#!/usr/bin/env node
/**
 * Gateway-wait dogfood: prove the interactive turn survives a saturated
 * gateway, against a REAL `ModelRuntime` rather than a test double.
 *
 * The defect this covers is not reachable from unit tests: Pi's agent loop
 * calls `modelRuntime.streamSimple` (core/sdk.js:194) wrapped in
 * `retryAssistantCall`, which gives up after `retry.maxRetries` (3) attempts.
 * The fix installs a provider `streamSimple` that waits underneath that budget,
 * and whether the install SUCCEEDS depends on `validateExtensionProvider` and
 * `composeModelProvider` — live code paths a fake registry never runs.
 *
 * Phases:
 *   1. the operator's own configured provider accepts the wrapper and keeps
 *      its whole model catalogue (skipped when no provider is configured);
 *   2. a scripted saturated gateway is waited out past Pi's 3-attempt budget;
 *   3. an advertised `retry_after_ms` is honoured exactly, not backed off from;
 *   4. escape ends the hold instead of retrying forever.
 *
 * Deterministic: no live model call, no network. Exit 0 when every phase
 * passes.
 *
 *   node scripts/dogfood-gateway-wait.ts [--verbose]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../src/gateway/installStreamRetry.ts";
import { parseGatewayWait } from "../src/gateway/signals.ts";

const verbose = process.argv.includes("--verbose");
const log = (...a: unknown[]) => {
  if (verbose) console.log(...a);
};

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}`);
    failures.push(what);
  }
}

const ADMISSION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":100,"queued":30,' +
  '"reason":"queue_timeout","request_id":"dogfood","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';
const SATURATED = "503 no worker for model";

/** A provider whose transport is scripted, standing in for a saturated gateway. */
function scriptedProvider(script: Array<{ error?: string }>) {
  let calls = 0;
  const model = {
    id: "dogfood-model",
    name: "Dogfood",
    api: "anthropic-messages",
    provider: "dogfood",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  return {
    model,
    calls: () => calls,
    provider: {
      id: "dogfood",
      name: "Dogfood",
      auth: {
        apiKey: {
          name: "API key",
          login: async () => ({ type: "api_key", key: "k" }),
          check: async () => ({ type: "api_key", source: "environment" }),
          resolve: async () => ({ auth: { apiKey: "k" } }),
        },
      },
      getModels: () => [model],
      stream: () => {
        throw new Error("the agent loop uses streamSimple");
      },
      streamSimple: () => {
        const step = script[Math.min(calls, script.length - 1)];
        calls++;
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (step?.error) {
            s.push({
              type: "error",
              reason: "error",
              error: { stopReason: "error", errorMessage: step.error },
            } as never);
          } else {
            s.push({ type: "done", reason: "stop", message: { stopReason: "stop", content: [] } } as never);
          }
        });
        return s;
      },
    },
  };
}

async function scriptedRuntime(script: Array<{ error?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "dogfood-gateway-"));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const p = scriptedProvider(script);
  runtime.registerNativeProvider(p.provider as never);
  return {
    runtime,
    registry: new ModelRegistry(runtime),
    ...p,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Phase 1: the operator's own provider ────────────────────────────────────
async function phaseRealProvider(): Promise<void> {
  console.log("\nphase 1: the configured provider accepts the wrapper");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const available = await runtime.getAvailable();
  if (available.length === 0) {
    console.log("  skip  no provider configured on this machine");
    return;
  }
  const model = available[0]!;
  const before = registry.getAll().filter((m) => m.provider === model.provider).length;
  log(`  provider=${model.provider} api=${model.api} baseUrl=${model.baseUrl}`);

  resetGatewayStreamRetry();
  const outcome = installGatewayStreamRetry(
    registry as never,
    { provider: model.provider, api: model.api },
    {
      createStream: () => createAssistantMessageEventStream() as never,
      hold: async () => {},
      errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
    },
  );

  check(outcome === "installed", `install on the real provider '${model.provider}' (${outcome})`);
  const after = registry.getAll().filter((m) => m.provider === model.provider).length;
  check(after === before, `catalogue preserved (${before} -> ${after} models)`);
  check((await runtime.getAvailable()).length === available.length, "availability unchanged");
}

// ── Phase 2: saturation past Pi's budget ────────────────────────────────────
async function phaseWaitsOutSaturation(): Promise<void> {
  console.log("\nphase 2: saturation is waited out past Pi's 3-attempt budget");
  // Ten consecutive refusals. Pi's own retry would have surfaced
  // "Retry failed after 3 attempts" at the fourth.
  const script = [...Array.from({ length: 10 }, () => ({ error: SATURATED })), {}];
  const h = await scriptedRuntime(script);
  try {
    const holds: number[] = [];
    resetGatewayStreamRetry();
    installGatewayStreamRetry(
      h.registry as never,
      { provider: "dogfood", api: "anthropic-messages" },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async (signal) => {
          holds.push(signal.retryAfterMs);
        },
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
      },
    );

    const result = await h.runtime.streamSimple(h.model as never, { messages: [] } as never, { apiKey: "k" }).result();
    log(`  attempts=${h.calls()} holds=${holds.join(",")}`);

    check(result.stopReason === "stop", `the turn survives (stopReason=${result.stopReason})`);
    check(h.calls() === 11, `every refusal was retried (${h.calls()} provider attempts)`);
    check(holds.length === 10, `${holds.length} waits honoured, where Pi would have stopped at 3`);
    check(
      holds.every((w, i) => i === 0 || w >= holds[i - 1]!),
      "a synthesized wait escalates rather than busy-waiting",
    );
    check(Math.max(...holds) <= 60_000, "escalation stays capped");
  } finally {
    h.cleanup();
  }
}

// ── Phase 3: an advertised wait is honoured exactly ─────────────────────────
async function phaseHonoursAdvertisedWait(): Promise<void> {
  console.log("\nphase 3: an advertised retry_after_ms is honoured exactly");
  const h = await scriptedRuntime([{ error: ADMISSION_429 }, {}]);
  try {
    const holds: number[] = [];
    resetGatewayStreamRetry();
    installGatewayStreamRetry(
      h.registry as never,
      { provider: "dogfood", api: "anthropic-messages" },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async (signal) => {
          holds.push(signal.retryAfterMs);
        },
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
      },
    );
    const result = await h.runtime.streamSimple(h.model as never, { messages: [] } as never, { apiKey: "k" }).result();

    check(holds[0] === 30_000, `waited the advertised 30s, not a backoff guess (got ${holds[0]}ms)`);
    check(result.stopReason === "stop", "and then succeeded");
    const parsed = parseGatewayWait({ text: ADMISSION_429 });
    check(parsed?.queued === 30 && parsed?.queueLimit === 100, "queue position is available for the status bar");
  } finally {
    h.cleanup();
  }
}

// ── Phase 4: escape ends the hold ───────────────────────────────────────────
async function phaseAbortEndsHold(): Promise<void> {
  console.log("\nphase 4: escape ends an unbounded hold");
  const h = await scriptedRuntime([{ error: SATURATED }, { error: SATURATED }, {}]);
  try {
    const aborter = new AbortController();
    resetGatewayStreamRetry();
    installGatewayStreamRetry(
      h.registry as never,
      { provider: "dogfood", api: "anthropic-messages" },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async () => {
          aborter.abort();
        },
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
        signalOf: (options) => (options as { signal?: AbortSignal } | undefined)?.signal,
      },
    );
    const result = await h.runtime
      .streamSimple(h.model as never, { messages: [] } as never, { apiKey: "k", signal: aborter.signal })
      .result();

    check(result.stopReason === "aborted", `escape ends the turn (stopReason=${result.stopReason})`);
    check(h.calls() === 1, "and does not keep retrying behind the operator's back");
  } finally {
    h.cleanup();
  }
}

async function main(): Promise<void> {
  console.log("gateway-wait dogfood");
  await phaseRealProvider();
  await phaseWaitsOutSaturation();
  await phaseHonoursAdvertisedWait();
  await phaseAbortEndsHold();

  console.log("");
  if (failures.length > 0) {
    console.log(`DOGFOOD FAILED: ${failures.length} check(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("DOGFOOD OK");
}

main().catch((err) => {
  console.error("dogfood-gateway-wait:", err);
  process.exit(1);
});
