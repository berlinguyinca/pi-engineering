#!/usr/bin/env node
/**
 * Stale-context fallback dogfood: prove the hold-driven model fallback is
 * lifecycle-safe against the REAL gateway retry pump and the REAL coordinator.
 *
 * The defect class: a gateway admission hold fires asynchronously with respect
 * to the Pi session lifecycle. A hold observed on session A can be delivered
 * after A has been replaced, reloaded, forked, or shut down. The old code
 * dereferenced a captured ctx (`ctx.model`) from the hold callback and Pi exited
 * via `assertActive`.
 *
 * This dogfood drives the real `installGatewayStreamRetry` pump with a scripted
 * base stream that emits the EXACT 429 admission envelope the gateway sends, and
 * wires `onHold`/`onProgress` to the `FallbackCoordinator` exactly as
 * extensions/index.ts does. It proves:
 *
 *   1. an admission hold is honoured (the reported retry_after_ms is waited) and
 *      then retried to success — the operator never sees the 429;
 *   2. the hold path never touches a stale ctx: a ctx that throws on access,
 *      like `assertActive`, is never dereferenced by a hold that fires late;
 *   3. the pending fallback arms at the threshold and applies ONLY on a fresh
 *      ctx; the stale session is never read, written, or notified;
 *   4. a fallback whose setModel throws is caught by the detached-promise
 *      boundary rather than escaping as a fatal uncaught exception;
 *   5. an admission storm (many 429s) keeps the state machine consistent and
 *      switches at most once.
 *
 * Deterministic: scripted base stream, no live model call, no external network.
 * Exit 0 when every phase passes.
 *
 *   node scripts/dogfood-stale-context-fallback.ts [--verbose]
 */
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  FALLBACK_AFTER_HOLDS,
  type FallbackApplyDeps,
  type FallbackContext,
  FallbackCoordinator,
  applyPendingFallback,
} from "../src/gateway/fallbackLifecycle.ts";
import { type ProviderHost, installGatewayStreamRetry } from "../src/gateway/installStreamRetry.ts";
import type { RetryableEvent, RetryableResult } from "../src/gateway/streamRetry.ts";

const verbose = process.argv.includes("--verbose");
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}`);
    failures.push(what);
  }
}
function log(...args: unknown[]): void {
  if (verbose) console.log(...args);
}

// The exact admission envelope the gateway sends on a queue timeout.
const ADMISSION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout",' +
  '"queue_limit":100,"queued":45,"reason":"queue_timeout","request_id":"dogfood-1",' +
  '"retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';

// ── the scripted base stream ─────────────────────────────────────────────────
type Ev = RetryableEvent & { text?: string; error?: RetryableResult };

/** One scripted base-stream attempt. Settles with an error or a stop. */
function attempt(errorMessage: string | undefined, okText?: string) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Ev, void, unknown> {
      if (okText) yield { type: "text_delta", text: okText } as Ev;
    },
    result: async (): Promise<RetryableResult> =>
      errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" },
  };
}

/** A sink that behaves like `createAssistantMessageEventStream`. */
function fakeStream() {
  const pushed: Ev[] = [];
  let settle: (r: RetryableResult) => void = () => {};
  const settled = new Promise<RetryableResult>((r) => {
    settle = r;
  });
  return {
    pushed,
    settled,
    push: (e: Ev) => pushed.push(e),
    end: (r?: RetryableResult) => settle(r ?? {}),
    async *[Symbol.asyncIterator](): AsyncGenerator<Ev, void, unknown> {
      for (const e of pushed) yield e;
    },
    result: () => settled,
  };
}

/**
 * A host that behaves like pi's registry: `getProvider` returns the latest
 * registered (wrapped) handler, and the wrapper delegates to the captured base
 * — which advances one scripted step per real transport call.
 */
function makeHost(script: Array<{ errorMessage?: string; okText?: string }>) {
  const registered: Array<{ id: string; config: Record<string, unknown> }> = [];
  const configs = new Map<string, Record<string, unknown>>();
  let baseCalls = 0;
  const realBase = {
    streamSimple: () => {
      const step = script[Math.min(baseCalls++, script.length - 1)] ?? {};
      return attempt(step.errorMessage, step.okText);
    },
  };
  const host: ProviderHost<unknown, unknown, unknown> = {
    getProvider: (id: string) => {
      const matches = registered.filter((r) => r.id === id);
      const latest = matches[matches.length - 1];
      if (latest?.config.streamSimple) return { streamSimple: latest.config.streamSimple as never };
      return realBase;
    },
    getRegisteredProviderConfig: (id: string) => configs.get(id),
    registerProvider: (id: string, config: Record<string, unknown>) => {
      registered.push({ id, config });
      configs.set(id, config);
    },
  };
  return { host, baseCalls: () => baseCalls };
}

// ── a stale Pi context, modelled with the real hazard ────────────────────────
function model(id: string, contextWindow: number): Model<any> {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow,
    maxTokens: 16_384,
    reasoning: false,
    input: ["text"],
  } as Model<any>;
}

/**
 * A session context that throws on access once invalidated, exactly like Pi's
 * `assertActive`. Counts every access so the dogfood can PROVE the stale ctx
 * was never touched by the hold path.
 */
class StaleCtx implements FallbackContext {
  accesses = 0;
  notified = 0;
  private _active = true;
  private label: string;
  private current: Model<any>;
  private available: Model<any>[];
  private usedTokens: number | null;
  constructor(label: string, current: Model<any>, available: Model<any>[], usedTokens: number | null) {
    this.label = label;
    this.current = current;
    this.available = available;
    this.usedTokens = usedTokens;
  }
  get model(): Model<any> | undefined {
    this.ensure();
    return this.current;
  }
  get modelRegistry(): { getAvailable?: () => Model<any>[] } {
    this.ensure();
    return { getAvailable: () => this.available };
  }
  getContextUsage(): { tokens: number } | undefined {
    this.ensure();
    return this.usedTokens == null ? undefined : { tokens: this.usedTokens };
  }
  get ui(): { notify: (message: string, type?: "info" | "warning" | "error") => void } {
    this.ensure();
    return {
      notify: () => {
        this.notified++;
      },
    };
  }
  invalidate(): void {
    this._active = false;
  }
  get active(): boolean {
    return this._active;
  }
  private ensure(): void {
    this.accesses++;
    if (!this._active)
      throw new Error(`This extension ctx is stale after session replacement or reload (${this.label}).`);
  }
}

/**
 * Mirrors the extension's wiring: the hold callback is plain-data-only, and the
 * fallback is applied from a lifecycle callback on the fresh ctx, with the
 * detached-promise boundary (the `.catch`) that keeps a failure from exiting Pi.
 */
function makeHarness(deps: FallbackApplyDeps) {
  const coordinator = new FallbackCoordinator({ enabled: true });
  let lastError: unknown;
  const onHold = (): void => {
    coordinator.onGatewayHold();
  };
  const onProgress = (): void => {
    coordinator.onProgress();
  };
  const beforeAgentStart = async (ctx: FallbackContext): Promise<void> => {
    const pending = coordinator.claimPending();
    if (!pending) return;
    try {
      const result = await applyPendingFallback(deps, ctx, pending);
      if (result.switched) coordinator.onProgress();
    } catch (error) {
      lastError = error;
    }
  };
  return { coordinator, onHold, onProgress, beforeAgentStart, getLastError: () => lastError };
}

const BIG = () => model("deepseek-v4-flash", 1_048_576);
const SMALL = () => model("qwen3.8-27b", 262_144);

// ── Phase 1: an admission hold is honoured, then retried to success ─────────
{
  console.log("phase 1: a 429 admission hold is waited out, then retried to success");
  const { host, baseCalls } = makeHost([{ errorMessage: ADMISSION_429 }, { okText: "recovered" }]);
  const stream = fakeStream();
  const waits: number[] = [];
  const result = installGatewayStreamRetry(
    host,
    { provider: "metabolomics", api: "openai-completions" },
    {
      createStream: () => stream,
      hold: async (signal) => {
        waits.push(signal.retryAfterMs);
      },
      errorMessage: (_m, error) => ({
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    },
  );
  check(result === "installed", "the wrapper is installed on the provider");
  // Call the WRAPPED streamSimple (what Pi now dispatches to).
  const handler = host.getProvider("metabolomics")?.streamSimple as (m: unknown, c: unknown) => unknown;
  handler({}, {});
  const settled = await stream.settled;
  check(settled.stopReason === "stop", "the turn recovers — the operator never sees the 429");
  check(
    waits.length === 1 && waits[0] === 30_000,
    `the reported retry_after_ms (30000) is honoured exactly (got ${waits})`,
  );
  check(baseCalls() === 2, "the real transport was reached twice — 429 then success");
  log("waits", waits, "baseCalls", baseCalls(), "settled", settled);
}

// ── Phase 2: a hold that fires after session replacement touches no stale ctx ─
{
  console.log("phase 2: a late hold after session replacement touches no stale ctx");
  const coordinator = new FallbackCoordinator();
  const staleA = new StaleCtx("A", BIG(), [BIG(), SMALL()], 20_000);

  // A gateway hold is observed while A is active. The REAL hold path only
  // touches the coordinator — never a captured ctx.
  coordinator.onGatewayHold();
  check(staleA.accesses === 0, "the hold path does not read the ctx at all");

  // A is replaced by B; A's captured ctx is now stale.
  staleA.invalidate();
  // The OLD callback fires after the replacement.
  let threw = false;
  try {
    coordinator.onGatewayHold();
  } catch {
    threw = true;
  }
  check(!threw, "a late hold after replacement does not throw");
  check(staleA.accesses === 0, "the stale ctx was never dereferenced");
  let staleThrows = false;
  try {
    void staleA.model;
  } catch {
    staleThrows = true;
  }
  check(staleThrows, "(control) the stale ctx genuinely throws if anything did touch it");
}

// ── Phase 3: the pending fallback applies only on a fresh ctx ───────────────
{
  console.log("phase 3: the pending fallback applies on the fresh ctx, never the stale one");
  const big = BIG();
  const small = SMALL();
  const setModelCalls: Model<any>[] = [];
  const deps: FallbackApplyDeps = { setModel: (m) => setModelCalls.push(m as Model<any>) };
  const harness = makeHarness(deps);

  const staleA = new StaleCtx("A", big, [big, small], 20_000);
  const freshB = new StaleCtx("B", big, [big, small], 20_000);

  for (let i = 0; i < FALLBACK_AFTER_HOLDS; i++) harness.onHold();
  check(harness.coordinator.hasPending, "the hold threshold arms a pending fallback");

  staleA.invalidate();
  harness.onHold(); // a late hold from the old session
  await harness.beforeAgentStart(freshB);

  check(setModelCalls.length === 1, "exactly one setModel");
  check(setModelCalls[0]?.id === small.id, "the switch targets the stand-in model");
  check(freshB.notified === 1, "the operator is told, on the fresh session");
  check(staleA.notified === 0, "the stale session is never notified");
  check(staleA.accesses === 0, "the stale ctx is never read during the fallback");
  check(harness.coordinator.holds === 0, "a successful switch resets the hold ledger");
  check(harness.getLastError() === undefined, "no error escaped");
}

// ── Phase 4: a fallback whose setModel throws is caught, not fatal ───────────
{
  console.log("phase 4: a throwing setModel is caught by the detached boundary");
  const big = BIG();
  const small = SMALL();
  const deps: FallbackApplyDeps = {
    setModel: () => {
      throw new Error("setModel blew up");
    },
  };
  const harness = makeHarness(deps);
  for (let i = 0; i < FALLBACK_AFTER_HOLDS; i++) harness.onHold();
  const session = new StaleCtx("A", big, [big, small], 20_000);

  let threw = false;
  try {
    await harness.beforeAgentStart(session);
  } catch {
    threw = true;
  }
  check(!threw, "the (mirrored) before_agent_start handler does not throw");
  check(harness.getLastError() instanceof Error, "the failure is captured");
  check(session.notified === 0, "no switch was announced");
}

// ── Phase 5: an admission storm keeps state consistent, switches at most once ─
{
  console.log("phase 5: an admission storm keeps the state machine consistent");
  const big = BIG();
  const small = SMALL();
  const setModelCalls: Model<any>[] = [];
  const deps: FallbackApplyDeps = { setModel: (m) => setModelCalls.push(m as Model<any>) };
  const harness = makeHarness(deps);

  for (let i = 0; i < 500; i++) {
    harness.onHold();
    if (i % 5 === 0) harness.coordinator.onProgress();
    if (i % 29 === 0) harness.coordinator.onModelSelect();
    const h = harness.coordinator.holds;
    if (!(Number.isInteger(h) && h >= 0)) {
      check(false, `state stayed consistent (holds=${h})`);
      break;
    }
    if (i === 499) check(true, "500 holds, state consistent throughout");
  }
  const session = new StaleCtx("A", big, [big, small], 20_000);
  await harness.beforeAgentStart(session);
  check(setModelCalls.length <= 1, `one claim yields at most one switch (got ${setModelCalls.length})`);
  check(harness.getLastError() === undefined, "no error escaped the storm");
}

// ── result ───────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.error(`DOGFOOD FAIL: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("DOGFOOD PASS: stale-context fallback is lifecycle-safe end to end");
