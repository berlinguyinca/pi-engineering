/**
 * The `/refresh-models` operation.
 *
 * Fetch what the gateway serves, reconcile it with `models.json`, and report
 * exactly what changed. Kept out of the extension entry point so the whole
 * operation is testable without a session — the lesson of a scoping fix that
 * shipped unapplied because the only code path exercising it was untested
 * wiring.
 */

import { type CatalogPlan, type ConfiguredModel, describeCatalogPlan, planCatalogUpdate } from "./catalogPlan.ts";
import { DEFAULT_GATEWAY_BASE_URL, type GatewayModelEntry, fetchGatewayModels } from "./gatewayCatalog.ts";
import {
  type ModelsConfig,
  providerBaseUrl,
  providerModels,
  readModelsConfig,
  withProviderModels,
  writeModelsConfig,
} from "./modelsConfig.ts";

export interface RefreshOptions {
  modelsPath: string;
  providerId: string;
  /** Overrides the configured base URL. */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  /** Report what would change without touching the file. */
  dryRun?: boolean;
  /** Remove configured models the gateway no longer lists. Off by default. */
  pruneMissing?: boolean;
  /** Generate a tiny completion with every advertised model and keep only successful ones. */
  probeModels?: boolean;
  /** Deadline for one inference probe. */
  probeTimeoutMs?: number;
  /** Maximum inference probes in flight at once. */
  probeConcurrency?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface RefreshResult {
  plan: CatalogPlan;
  gateway: GatewayModelEntry[];
  baseUrl: string;
  /** Written only when the plan was dirty and this was not a dry run. */
  backupPath?: string;
  written: boolean;
  /** Rendered report, ready to show. */
  lines: string[];
}

export interface ProviderRefreshAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

export interface RefreshConfiguredProvidersOptions
  extends Pick<
    RefreshOptions,
    | "modelsPath"
    | "dryRun"
    | "pruneMissing"
    | "probeModels"
    | "probeTimeoutMs"
    | "probeConcurrency"
    | "signal"
    | "fetchImpl"
    | "now"
  > {
  providerIds: string[];
  authForProvider?: (providerId: string) => ProviderRefreshAuth | Promise<ProviderRefreshAuth>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
// Backends commonly expose several model aliases through one GPU worker. Probe
// sequentially by default so refresh itself does not manufacture a capacity
// failure and hide an otherwise healthy model. Callers may opt into bounded
// parallelism when their gateway is known to have independent capacity.
const DEFAULT_PROBE_CONCURRENCY = 1;
/**
 * Small, so the probe never brushes a model's per-slot context, yet the same
 * budget as before: a reasoning model that ignores the thinking-off parameter
 * still needs room to reach a visible "OK".
 */
const PROBE_MAX_TOKENS = 64;
/** A configured reasoning model thinks before it answers: give it room. */
const REASONING_PROBE_MAX_TOKENS = 256;

/**
 * One model's verification verdict.
 *
 * - `working`: produced a completion.
 * - `unavailable` (definitive): the gateway answered 404 / `model_not_found`
 *   AND the model has left its `/models` listing on a re-read. Pruned. A 404
 *   for a model still listed (a worker rejoining during a deploy), or one the
 *   listing cannot confirm, is inconclusive.
 * - `rejected` (definitive): the request was refused as invalid (400/413/422)
 *   even after one retry without optional parameters — a probe incompatibility
 *   or a model fault, not "try again later". Kept as configured, never added.
 * - `inconclusive`: capacity, timeouts, 5xx, transport errors. Kept as
 *   configured, never added.
 * - `systemic`: the refusal applies to every model (authentication, an
 *   account-wide limit); the provider is skipped and nothing is written.
 */
type ProbeResult =
  | { verdict: "working"; note?: string }
  | { verdict: "unavailable"; reason: string }
  | { verdict: "rejected"; reason: string }
  | { verdict: "inconclusive"; reason: string }
  | { verdict: "systemic"; reason: string };

function requestHeaders(opts: Pick<RefreshOptions, "apiKey" | "headers">): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  };
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    const existing = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (existing) delete headers[existing];
    if (value !== null) headers[name] = value;
  }
  return headers;
}

function visibleCompletion(payload: unknown): boolean {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim().length > 0;
}

function errorCode(payload: unknown): string {
  const error = (payload as { error?: { code?: unknown; reason?: unknown; type?: unknown } })?.error;
  for (const value of [error?.code, error?.reason, error?.type]) {
    if (typeof value === "string" && value.length > 0) return value.toLowerCase();
  }
  return "";
}

/** The gateway's own words for a refusal, bounded and on one line. */
function errorText(payload: unknown, raw: string): string {
  const error = (payload as { error?: unknown })?.error;
  const message =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : payload === null
          ? raw
          : "";
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** "HTTP 400 upstream_error: Correct the request syntax, …" */
function describeRefusal(status: number, code: string, text: string): string {
  return `HTTP ${status}${code ? ` ${code}` : ""}${text ? `: ${text}` : ""}`;
}

function supportsThinkingOff(providerId: string, api: string, baseUrl: string): boolean {
  if (api !== "openai-completions") return false;
  const configuredList = (value: string | undefined, fallback: string[]): string[] =>
    (value === undefined ? fallback : value.split(",")).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const providers = configuredList(process.env.PI_THINKING_OFF_PROVIDERS, ["metabolomics"]);
  if (providers.includes(providerId.toLowerCase())) return true;
  const hosts = configuredList(process.env.PI_THINKING_OFF_GATEWAYS, ["llm.example.com"]);
  try {
    return hosts.includes(new URL(baseUrl).host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * One minimal completion: a fixed one-word prompt, a small output cap, no
 * streaming, no tools, no images. `optional` adds the parameters a model may
 * legitimately reject (`temperature`, and the thinking-off `reasoning_effort`).
 */
async function probeGatewayModel(
  model: GatewayModelEntry,
  baseUrl: string,
  opts: RefreshOptions,
  optional: { disableThinking: boolean } | null,
  maxTokens: number = PROBE_MAX_TOKENS,
): Promise<ProbeResult> {
  opts.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: requestHeaders(opts),
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        max_tokens: maxTokens,
        stream: false,
        ...(optional ? { temperature: 0 } : {}),
        ...(optional?.disableThinking ? { reasoning_effort: "none" } : {}),
      }),
      signal: controller.signal,
    });
    const raw = typeof response.text === "function" ? await response.text().catch(() => "") : "";
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : typeof response.text === "function" ? null : await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) {
      if (visibleCompletion(payload)) return { verdict: "working" };
      // A reasoning model may spend the whole small budget thinking (empty
      // content, finish_reason "length"): an answered request still proves the
      // model is served, which is all verification has to establish.
      const choices = (payload as { choices?: unknown })?.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        return { verdict: "working", note: "served; no visible text within the probe budget" };
      }
      return { verdict: "inconclusive", reason: "HTTP 200 without a completion" };
    }
    const code = errorCode(payload);
    const reason = describeRefusal(response.status, code, errorText(payload, raw));
    const scope = (payload as { error?: { scope?: unknown } })?.error?.scope;
    if (response.status === 401 || response.status === 403 || scope === "account") {
      return { verdict: "systemic", reason };
    }
    if (response.status === 404 || code === "model_not_found") return { verdict: "unavailable", reason };
    if (response.status === 400 || response.status === 413 || response.status === 422) {
      return { verdict: "rejected", reason };
    }
    return { verdict: "inconclusive", reason };
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (timedOut || controller.signal.aborted) return { verdict: "inconclusive", reason: "probe timed out" };
    return { verdict: "inconclusive", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

interface Verification {
  working: GatewayModelEntry[];
  /** Definitively not served: pruned from the configuration. */
  excluded: Array<{ id: string; reason: string }>;
  /** Not verified this time (rejected or inconclusive): kept as configured, never added. */
  held: Array<{ id: string; verdict: "rejected" | "inconclusive"; reason: string }>;
  notes: Array<{ id: string; note: string }>;
}

async function verifiedGatewayModels(
  gateway: GatewayModelEntry[],
  baseUrl: string,
  opts: RefreshOptions,
  disableThinking: boolean,
  reasoningIds: ReadonlySet<string>,
  relist: () => Promise<GatewayModelEntry[] | null>,
): Promise<Verification> {
  const verdicts = new Array<ProbeResult>(gateway.length);
  let next = 0;
  const workers = Math.max(1, Math.min(opts.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY, gateway.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= gateway.length) return;
        const model = gateway[index]!;
        const budget = reasoningIds.has(model.id) ? REASONING_PROBE_MAX_TOKENS : PROBE_MAX_TOKENS;
        let result = await probeGatewayModel(model, baseUrl, opts, { disableThinking }, budget);
        if (result.verdict === "inconclusive" && result.reason === "probe timed out") {
          result = await probeGatewayModel(model, baseUrl, opts, { disableThinking }, budget);
        } else if (result.verdict === "rejected") {
          // A 400 is most often a parameter this model's backend does not
          // accept. Retry once with only the required fields; a second refusal
          // is the model's definitive answer to the minimal probe.
          const retry = await probeGatewayModel(model, baseUrl, opts, null, budget);
          // Whatever else the retry says, the model answered the full probe with
          // a 400: it is never pruned on the retry's word alone.
          result =
            retry.verdict === "working"
              ? { verdict: "working", note: "verified without optional probe parameters" }
              : retry.verdict === "rejected" || retry.verdict === "unavailable"
                ? result
                : retry;
        }
        verdicts[index] = result;
      }
    }),
  );
  // A single 404 never deletes a model: only one that has also left the
  // gateway's listing is gone. A listing that cannot be re-read confirms nothing.
  if (verdicts.some((result) => result.verdict === "unavailable")) {
    const listed = await relist().catch(() => null);
    const stillListed = new Set((listed ?? []).map((entry) => entry.id));
    verdicts.forEach((result, index) => {
      if (result.verdict !== "unavailable") return;
      if (listed === null || stillListed.has(gateway[index]!.id)) {
        verdicts[index] = {
          verdict: "inconclusive",
          reason: `${result.reason} (${listed === null ? "listing could not be re-read" : "still listed by the gateway"})`,
        };
      }
    });
  }
  const systemic = gateway
    .map((model, index) => ({ model, result: verdicts[index]! }))
    .filter((entry) => entry.result.verdict === "systemic");
  if (systemic.length > 0) {
    throw new Error(
      `model verification was inconclusive: ${systemic
        .map(({ model, result }) => `${model.id}: ${"reason" in result ? result.reason : "systemic failure"}`)
        .join("; ")}`,
    );
  }
  const working = gateway.filter((_, index) => verdicts[index]?.verdict === "working");
  const excluded: Verification["excluded"] = [];
  const held: Verification["held"] = [];
  const notes: Verification["notes"] = [];
  gateway.forEach((model, index) => {
    const result = verdicts[index]!;
    if (result.verdict === "unavailable") excluded.push({ id: model.id, reason: result.reason });
    else if (result.verdict === "rejected" || result.verdict === "inconclusive") {
      held.push({ id: model.id, verdict: result.verdict, reason: result.reason });
    } else if (result.verdict === "working" && result.note) notes.push({ id: model.id, note: result.note });
  });
  if (working.length === 0) {
    throw new Error(
      `none of the ${gateway.length} advertised models produced a usable completion (${[...excluded, ...held]
        .map(({ id, reason }) => `${id}: ${reason}`)
        .join("; ")})`,
    );
  }
  return { working, excluded, held, notes };
}

export interface ConfiguredProviderRefreshResult {
  results: Array<{ providerId: string; result: RefreshResult }>;
  failures: Array<{ providerId: string; error: Error }>;
  /** One restore point for the complete successful batch. */
  backupPath?: string;
  written: boolean;
  lines: string[];
}

async function planProviderRefresh(config: ModelsConfig, opts: RefreshOptions): Promise<RefreshResult> {
  const existing: ConfiguredModel[] = providerModels(config, opts.providerId);
  const baseUrl = opts.baseUrl ?? providerBaseUrl(config, opts.providerId) ?? DEFAULT_GATEWAY_BASE_URL;
  const configuredProvider = config.providers?.[opts.providerId];
  const api = typeof configuredProvider?.api === "string" ? configuredProvider.api : "openai-completions";

  const listing = () =>
    fetchGatewayModels({
      baseUrl,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const advertised = await listing();
  const reasoningIds = new Set(existing.filter((model) => model.reasoning === true).map((model) => model.id));

  const canProbe = opts.probeModels && api === "openai-completions";
  const disableThinking = supportsThinkingOff(opts.providerId, api, baseUrl);
  const verified: Verification = canProbe
    ? await verifiedGatewayModels(advertised, baseUrl, opts, disableThinking, reasoningIds, listing)
    : { working: advertised, excluded: [], held: [], notes: [] };
  const gateway = verified.working;
  const configuredIds = new Set(existing.map((model) => model.id));
  const plan = planCatalogUpdate(existing, gateway, {
    ...(opts.pruneMissing || canProbe ? { pruneMissing: true } : {}),
    // A model that was not verified this time keeps its configured entry
    // exactly as it was; only a definitive "not served" removes one.
    keep: verified.held.map(({ id }) => id),
  });
  const planLines = describeCatalogPlan(plan).map((line) =>
    canProbe
      ? line
          .replace(/^not on the gateway/, "not working")
          .replace(" — the gateway no longer lists it", " — not advertised or inference probe failed")
      : line,
  );
  const lines = [
    `${opts.providerId} — ${gateway.length} ${canProbe ? "working" : "advertised"} model(s) on ${baseUrl}`,
    ...(canProbe
      ? [
          `Inference-tested ${advertised.length}; excluded ${verified.excluded.length}; not verified ${verified.held.length}.`,
        ]
      : []),
    ...(opts.probeModels && !canProbe ? [`Inference probe skipped for unsupported provider API ${api}.`] : []),
    ...verified.excluded.map(({ id, reason }) => `  excluded: ${id} — ${reason}`),
    ...verified.held.map(
      ({ id, verdict, reason }) =>
        `  ${verdict}: ${id} — ${reason} (${configuredIds.has(id) ? "kept as configured" : "not added"})`,
    ),
    ...verified.notes.map(({ id, note }) => `  note: ${id} — ${note}`),
    ...planLines,
  ];
  return { plan, gateway, baseUrl, written: false, lines };
}

/**
 * Refresh one provider's models from its gateway.
 *
 * Reads the config BEFORE fetching so a malformed `models.json` fails before
 * any network call, and writes only when something actually changed — a refresh
 * that rewrites an identical file still churns a backup and a mtime for nothing.
 */
export async function refreshProviderModels(opts: RefreshOptions): Promise<RefreshResult> {
  const config: ModelsConfig = readModelsConfig(opts.modelsPath);
  const result = await planProviderRefresh(config, opts);

  if (!result.plan.dirty || opts.dryRun) {
    if (result.plan.dirty && opts.dryRun) result.lines.push("Dry run — nothing written.");
    return result;
  }

  opts.signal?.throwIfAborted();
  const write = writeModelsConfig(
    opts.modelsPath,
    withProviderModels(config, opts.providerId, result.plan.next),
    (opts.now ?? (() => new Date()))(),
  );
  result.lines.push(`Wrote ${opts.modelsPath}`);
  if (write.backupPath) result.lines.push(`Previous version kept at ${write.backupPath}`);
  result.lines.push("Restart Pi or run /reload for the new models to take effect.");

  return {
    ...result,
    written: true,
    ...(write.backupPath ? { backupPath: write.backupPath } : {}),
  };
}

/** Refresh configured providers independently so one bad host cannot block the rest. */
export async function refreshConfiguredProviders(
  opts: RefreshConfiguredProvidersOptions,
): Promise<ConfiguredProviderRefreshResult> {
  // Parse once before entering the per-provider recovery loop. A malformed
  // source file is not a provider failure and must never be replaced.
  let nextConfig = readModelsConfig(opts.modelsPath);
  const results: ConfiguredProviderRefreshResult["results"] = [];
  const failures: ConfiguredProviderRefreshResult["failures"] = [];
  const lines: string[] = [];

  for (const providerId of opts.providerIds) {
    try {
      opts.signal?.throwIfAborted();
      const auth = (await opts.authForProvider?.(providerId)) ?? {};
      opts.signal?.throwIfAborted();
      const result = await planProviderRefresh(nextConfig, {
        modelsPath: opts.modelsPath,
        providerId,
        ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.pruneMissing ? { pruneMissing: true } : {}),
        ...(opts.probeModels ? { probeModels: true } : {}),
        ...(opts.probeTimeoutMs !== undefined ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
        ...(opts.probeConcurrency !== undefined ? { probeConcurrency: opts.probeConcurrency } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      opts.signal?.throwIfAborted();
      if (result.plan.dirty && opts.dryRun) result.lines.push("Dry run — nothing written.");
      if (result.plan.dirty && !opts.dryRun) {
        nextConfig = withProviderModels(nextConfig, providerId, result.plan.next);
      }
      results.push({ providerId, result });
      lines.push(...result.lines);
    } catch (cause) {
      opts.signal?.throwIfAborted();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failures.push({ providerId, error });
      lines.push(`${providerId} — skipped: ${error.message}. Existing configuration kept.`);
    }
  }

  const dirty = results.some(({ result }) => result.plan.dirty);
  if (!dirty || opts.dryRun) return { results, failures, written: false, lines };

  opts.signal?.throwIfAborted();
  const write = writeModelsConfig(opts.modelsPath, nextConfig, (opts.now ?? (() => new Date()))());
  const commonLines = [`Wrote ${opts.modelsPath}`];
  if (write.backupPath) commonLines.push(`Previous version kept at ${write.backupPath}`);
  commonLines.push("Restart Pi or run /reload for the new models to take effect.");
  lines.push(...commonLines);

  for (const entry of results) {
    if (!entry.result.plan.dirty) continue;
    entry.result = {
      ...entry.result,
      written: true,
      ...(write.backupPath ? { backupPath: write.backupPath } : {}),
    };
  }

  return {
    results,
    failures,
    ...(write.backupPath ? { backupPath: write.backupPath } : {}),
    written: true,
    lines,
  };
}
