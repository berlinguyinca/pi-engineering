/**
 * (#425) Worker-shaped preflight.
 *
 * The gateway served small prose probes for hours while EVERY worker-shaped
 * dispatch died with `400 upstream_error / request_state: unknown` (observed
 * 2026-10-25 across six missions: full worker startup, then an instant 400
 * after 0 honoured waits). The lesson from the same day is that neither
 * request size alone nor tool schemas alone reproduce it — it is transient
 * upstream state at worker scale. So the probe is the real thing, minimal
 * bytes: the production `completeSimple` path (identical auth, base URL and
 * compatibility handling as a worker's first request) with a tiny
 * system+user exchange and the worker tool schema present.
 *
 * Doctrine (deliberately narrow):
 *   * a probe that succeeds caches success briefly, so parallel worker
 *     launches do not stampede the gateway;
 *   * a probe that fails maps through the SAME gateway-signal vocabulary as
 *     an in-run failure (#428/#435): route-availability and long-wait signals
 *     become `transient:*` capacity waits, quota/billing keep their failing
 *     `gateway:*` marker, auth is reported as auth;
 *   * the preflight never invents a new failure class: an unstructured error
 *     fails the task with its own text, exactly as the first in-session
 *     request would have.
 */

import { gatewayFailureMarker, parseGatewayWait } from "./signals.ts";

/** The slice of pi's ModelRuntime the probe needs. */
export interface PreflightRuntime {
  completeSimple(
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ stopReason?: string; errorMessage?: string }>;
}

export type PreflightOutcome = { ok: true; probed: boolean } | { ok: false; marker: string; detail: string };

const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 20_000;

interface CacheEntry {
  atMs: number;
  ok: boolean;
  marker?: string;
  detail?: string;
}

const cache = new Map<string, CacheEntry>();

/** Test hook: forget cached probe outcomes. */
export function resetPreflightCache(): void {
  cache.clear();
}

/** Preflight is on unless the operator turns it off (PI_ENG_PREFLIGHT=0|off). */
export function preflightEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PI_ENG_PREFLIGHT?.trim().toLowerCase();
  return v !== "0" && v !== "off";
}

/** The presence of a tool schema is part of the worker shape the gateway
 * must survive; the schema itself is the cheapest legitimate one. */
const PROBE_TOOLS = [
  {
    name: "bash",
    description: "Execute a shell command and return its output.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command" } },
      required: ["command"],
    },
  },
];

export async function preflightWorkerShape(options: {
  runtime: PreflightRuntime;
  model: unknown;
  timeoutMs?: number;
  now?: () => number;
  bypassCache?: boolean;
}): Promise<PreflightOutcome> {
  const model = options.model as { provider?: string; id?: string };
  const key = `${model?.provider ?? ""}/${model?.id ?? ""}`;
  const now = options.now?.() ?? Date.now();
  if (!options.bypassCache) {
    const hit = cache.get(key);
    if (hit && now - hit.atMs <= (hit.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
      return hit.ok
        ? { ok: true, probed: false }
        : { ok: false, marker: hit.marker ?? "preflight:error", detail: hit.detail ?? "" };
    }
  }
  const fail = (marker: string, detail: string): PreflightOutcome => {
    cache.set(key, { atMs: now, ok: false, marker, detail });
    return { ok: false, marker, detail };
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let reply: { stopReason?: string; errorMessage?: string };
  try {
    reply = await options.runtime.completeSimple(
      options.model,
      {
        systemPrompt: "You are an engineering agent. Act with tools when asked. Acknowledge readiness in one word.",
        messages: [{ role: "user", content: "Preflight check. Reply READY." }],
        tools: PROBE_TOOLS,
      },
      { maxTokens: 16, signal: controller.signal },
    );
  } catch (error) {
    clearTimeout(timer);
    const text = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted)
      return fail("transient:timeout", `preflight timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    const signal = parseGatewayWait({ text });
    if (signal) return fail(gatewayFailureMarker(signal), text.slice(0, 400));
    return fail("preflight:error", text.slice(0, 400));
  }
  clearTimeout(timer);
  if (reply?.stopReason === "error") {
    const text = reply.errorMessage ?? "preflight reported an error";
    const signal = parseGatewayWait({ text });
    if (signal) return fail(gatewayFailureMarker(signal), text.slice(0, 400));
    if (/\b40[13]\b|api key|credential|unauthorized|forbidden/i.test(text))
      return fail("preflight:auth", text.slice(0, 400));
    // No recognizable gateway envelope: fail the task with its own text —
    // exactly what the worker's first real request would have done. Never
    // park a mission on an error the gateway-signal vocabulary does not
    // describe as availability.
    return fail("preflight:error", text.slice(0, 400));
  }
  cache.set(key, { atMs: now, ok: true });
  return { ok: true, probed: true };
}
