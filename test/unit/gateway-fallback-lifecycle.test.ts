/**
 * Regression tests for the stale `ExtensionCommandContext` crash.
 *
 * The bug: the extension captured a Pi session context in `latestCtx` and, from
 * an asynchronous gateway hold callback, dereferenced it (`considerFallback`
 * read `ctx.model`). A hold observed while session A is active can be delivered
 * after A has been replaced, reloaded, forked, or shut down — by which point the
 * captured ctx is stale and `assertActive` throws, killing the process:
 *
 *   Error: This extension ctx is stale after session replacement or reload.
 *   at ExtensionRunner.assertActive
 *   at get model
 *   at considerFallback (...)
 *
 * The fix replaces the retained context with a plain-data state machine
 * (`FallbackCoordinator`): the hold callback updates only a count and a pending
 * flag, and the fallback itself runs exclusively from a lifecycle callback that
 * supplies a fresh, currently-valid context (`applyPendingFallback`).
 *
 * These tests pin that separation. The `SessionContext` below models the Pi
 * hazard directly: a captured context is valid only while its session is
 * active, and dereferencing it after invalidation throws — exactly like
 * `assertActive`. If the hold path ever reached for a stale ctx again, these
 * tests would throw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  FALLBACK_AFTER_HOLDS,
  type FallbackApplyDeps,
  type FallbackContext,
  FallbackCoordinator,
  type PendingFallback,
  applyPendingFallback,
} from "../../src/gateway/fallbackLifecycle.ts";

type M = Model<any>;

function model(id: string, contextWindow: number, extra: Record<string, unknown> = {}): M {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow,
    maxTokens: 16_384,
    reasoning: false,
    input: ["text"],
    ...extra,
  } as M;
}

const FLASH = () => model("deepseek-v4-flash", 1_048_576);
const QWEN = () => model("qwen3.8-27b", 262_144);
const QWEN_Q4 = () => model("qwen3.8-27b-q4-250k", 131_072);

/**
 * Models a Pi session context with the staleness hazard.
 *
 * Every session-bound accessor (`model`, `modelRegistry`, `getContextUsage`,
 * `ui`) throws once the session is invalidated, mirroring `assertActive`. A
 * stale-context bug surfaces here as an exception instead of a silent no-op.
 */
class SessionContext {
  readonly label: string;
  readonly notifyCalls: Array<{ message: string; type?: string }> = [];
  private _active = true;
  private model_: M | undefined;
  private available_: M[];
  private usedTokens_: number | null;
  constructor(label: string, model: M | undefined, available: M[], usedTokens: number | null) {
    this.label = label;
    this.model_ = model;
    this.available_ = available;
    this.usedTokens_ = usedTokens;
  }
  get active(): boolean {
    return this._active;
  }
  /** Simulate `newSession()` / `fork()` / `switchSession()` / `reload()` / shutdown. */
  invalidate(): void {
    this._active = false;
  }
  private ensureActive(): void {
    if (!this._active) {
      throw new Error(`This extension ctx is stale after session replacement or reload (${this.label}).`);
    }
  }
  get model(): M | undefined {
    this.ensureActive();
    return this.model_;
  }
  get modelRegistry(): { getAvailable: () => M[] } {
    this.ensureActive();
    return { getAvailable: () => this.available_ };
  }
  getContextUsage(): { tokens: number } | undefined {
    this.ensureActive();
    return this.usedTokens_ == null ? undefined : { tokens: this.usedTokens_ };
  }
  get ui(): { notify: (message: string, type?: "info" | "warning" | "error") => void } {
    this.ensureActive();
    return {
      notify: (message, type) => {
        this.notifyCalls.push({ message, type });
      },
    };
  }
}

/**
 * Mirrors the extension's wiring:
 *   * onHold            → coordinator.onGatewayHold (plain data only)
 *   * before_agent_start→ claimPending + applyPendingFallback + reset holds
 *
 * The `.catch` mirrors the extension's detached-promise boundary, so a rejected
 * fallback is captured rather than escaping as an uncaught exception.
 */
function makeHarness(deps: FallbackApplyDeps) {
  const coordinator = new FallbackCoordinator();
  let lastError: unknown;
  const onHold = (info: { modelId?: string; provider?: string } = {}): void => {
    coordinator.onGatewayHold(info);
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
  return { coordinator, onHold, beforeAgentStart, getLastError: () => lastError };
}

function setModelRecorder(): { deps: FallbackApplyDeps; calls: M[] } {
  const calls: M[] = [];
  return {
    calls,
    deps: {
      setModel: (m) => {
        calls.push(m);
        return true;
      },
    },
  };
}

// ─── FallbackCoordinator: the plain-data state machine ──────────────────────

test("coordinator: holds accumulate and arm a pending fallback at the threshold", () => {
  const c = new FallbackCoordinator();
  for (let i = 0; i < FALLBACK_AFTER_HOLDS - 1; i++) c.onGatewayHold();
  assert.equal(c.hasPending, false, "below the threshold nothing is pending");
  assert.equal(c.holds, FALLBACK_AFTER_HOLDS - 1);
  c.onGatewayHold();
  assert.equal(c.hasPending, true, "at the threshold a fallback is pending");
  assert.equal(c.holds, FALLBACK_AFTER_HOLDS);
});

test("coordinator: a stream producing output resets the consecutive-hold run", () => {
  const c = new FallbackCoordinator();
  c.onGatewayHold();
  c.onGatewayHold();
  c.onProgress();
  assert.equal(c.holds, 0, "progress means capacity is back");
  c.onGatewayHold();
  assert.equal(c.hasPending, false, "a single hold after progress does not arm a fallback");
});

test("T5: many holds produce at most one pending fallback, claimed exactly once", () => {
  const c = new FallbackCoordinator();
  for (let i = 0; i < 10; i++) c.onGatewayHold();
  assert.equal(c.hasPending, true);
  const first = c.claimPending();
  const second = c.claimPending();
  assert.ok(first, "the first claim wins");
  assert.equal(second, undefined, "a second claim finds nothing — no double switch");
  assert.equal(c.hasPending, false);
});

test("T4: an explicit model_select clears the pending fallback and the hold count", () => {
  const c = new FallbackCoordinator();
  c.onGatewayHold();
  c.onGatewayHold();
  c.onGatewayHold();
  assert.equal(c.hasPending, true);
  c.onModelSelect();
  assert.equal(c.hasPending, false, "a stale fallback intent must not survive an operator switch");
  assert.equal(c.holds, 0, "the operator's choice gets a clean ledger");
});

test("session shutdown clears ephemeral fallback state", () => {
  const c = new FallbackCoordinator();
  c.onGatewayHold();
  c.onGatewayHold();
  c.onGatewayHold();
  assert.equal(c.hasPending, true);
  c.onSessionShutdown();
  assert.equal(c.hasPending, false, "nothing leaks into the next session");
  assert.equal(c.holds, 0);
});

test("coordinator: a snapshot is plain data only", () => {
  const c = new FallbackCoordinator();
  c.onGatewayHold({ modelId: "m", provider: "p" });
  c.onGatewayHold();
  c.onGatewayHold();
  const snap = c.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    "consecutiveHolds",
    "reason",
    "requestedAt",
    "sourceModelId",
    "sourceProvider",
  ]);
  assert.equal(typeof snap.consecutiveHolds, "number");
  assert.equal(typeof snap.requestedAt, "number");
  // No function, no context object — this is what makes the flag safe to
  // update from an async callback after the session is gone.
  assert.ok(!Object.values(snap).some((v) => typeof v === "object" && v !== null));
});

// ─── applyPendingFallback: runs only against a fresh context ────────────────

test("T1: a hold in an active session arms a fallback that switches on the next before_agent_start", async () => {
  const big = FLASH();
  const small = QWEN();
  const { deps, calls } = setModelRecorder();
  const harness = makeHarness(deps);

  const sessionA = new SessionContext("A", big, [big, small], 20_000);
  for (let i = 0; i < FALLBACK_AFTER_HOLDS; i++) harness.onHold({ modelId: big.id, provider: big.provider });
  assert.equal(harness.coordinator.hasPending, true);

  await harness.beforeAgentStart(sessionA as unknown as FallbackContext);

  assert.equal(calls.length, 1, "exactly one setModel");
  assert.ok(calls[0]);
  assert.equal(calls[0].id, small.id);
  assert.equal(sessionA.notifyCalls.length, 1, "the operator is told the model changed");
  assert.equal(harness.coordinator.hasPending, false, "the pending flag is consumed");
  assert.equal(harness.coordinator.holds, 0, "a successful switch resets the hold ledger");
});

test("T2: an old hold that fires after session replacement touches no stale ctx", async () => {
  const big = FLASH();
  const small = QWEN();
  const other = QWEN_Q4();
  const { deps, calls } = setModelRecorder();
  const harness = makeHarness(deps);

  const sessionA = new SessionContext("A", big, [big, small], 20_000);
  const sessionB = new SessionContext("B", big, [big, small, other], 20_000);

  // Three holds observed while A is active arm the fallback.
  harness.onHold({ modelId: big.id });
  harness.onHold({ modelId: big.id });
  harness.onHold({ modelId: big.id });
  assert.equal(harness.coordinator.hasPending, true);

  // A is replaced by B; A's captured ctx is now stale.
  sessionA.invalidate();
  // The OLD gateway callback fires after the replacement. In the buggy
  // architecture this dereferenced sessionA.model and threw assertActive.
  harness.onHold({ modelId: big.id });
  assert.doesNotThrow(() => harness.coordinator.snapshot(), "the hold path is plain data");
  // sessionA is genuinely stale and was never touched by the hold path:
  assert.throws(() => {
    void sessionA.model;
  }, /stale/);

  // B's before_agent_start applies the fallback against B's fresh ctx.
  await harness.beforeAgentStart(sessionB as unknown as FallbackContext);
  assert.equal(calls.length, 1, "one switch, against the live session");
  assert.equal(sessionB.notifyCalls.length, 1);
  assert.equal(sessionA.notifyCalls.length, 0, "the stale session is never notified");
  assert.equal(harness.getLastError(), undefined);
});

test("T3: a reload while a fallback is pending does not crash and applies on the fresh ctx", async () => {
  const big = FLASH();
  const small = QWEN();
  const { deps, calls } = setModelRecorder();
  const harness = makeHarness(deps);

  // The pre-reload context for the session.
  const beforeReload = new SessionContext("A", big, [big, small], 20_000);
  harness.onHold({ modelId: big.id });
  harness.onHold({ modelId: big.id });
  harness.onHold({ modelId: big.id });
  assert.equal(harness.coordinator.hasPending, true);

  // reload() invalidates the captured context.
  beforeReload.invalidate();
  // A detached callback from before the reload fires now.
  harness.onHold({ modelId: big.id });

  // After reload the same logical session has a fresh context.
  const afterReload = new SessionContext("A'", big, [big, small], 20_000);
  await harness.beforeAgentStart(afterReload as unknown as FallbackContext);
  assert.equal(calls.length, 1);
  assert.equal(afterReload.notifyCalls.length, 1);
  assert.throws(
    () => {
      void beforeReload.model;
    },
    /stale/,
    "the pre-reload context stayed stale and unused",
  );
  assert.equal(harness.getLastError(), undefined);
});

test("T4: after the operator selects a model, a stale pending fallback does not switch away", async () => {
  const big = FLASH();
  const small = QWEN();
  const { deps, calls } = setModelRecorder();
  const harness = makeHarness(deps);

  harness.onHold({ modelId: big.id });
  harness.onHold({ modelId: big.id });
  harness.onHold({ modelId: big.id });
  assert.equal(harness.coordinator.hasPending, true);

  // The operator explicitly selects a model.
  harness.coordinator.onModelSelect();
  assert.equal(harness.coordinator.hasPending, false);

  // A subsequent before_agent_start must NOT switch away from the operator's choice.
  const session = new SessionContext("A", big, [big, small], 20_000);
  await harness.beforeAgentStart(session as unknown as FallbackContext);
  assert.equal(calls.length, 0, "no switch after the operator chose a model");
  assert.equal(session.notifyCalls.length, 0);
});

test("T6: a fallback whose setModel throws is caught; Pi stays alive", async () => {
  const big = FLASH();
  const small = QWEN();
  const deps: FallbackApplyDeps = {
    setModel: () => {
      throw new Error("setModel blew up");
    },
  };
  const harness = makeHarness(deps);
  harness.onHold();
  harness.onHold();
  harness.onHold();

  const session = new SessionContext("A", big, [big, small], 20_000);
  // Must not throw out of the (mirrored) before_agent_start handler.
  await assert.doesNotReject(async () => {
    await harness.beforeAgentStart(session as unknown as FallbackContext);
  });
  assert.ok(harness.getLastError() instanceof Error, "the failure is captured, not fatal");
  assert.match((harness.getLastError() as Error).message, /setModel blew up/);
  assert.equal(session.notifyCalls.length, 0, "no switch was announced");
});

test("T6b: a failing health probe degrades to unknown and still allows the switch", async () => {
  const big = FLASH();
  const small = QWEN();
  const { deps, calls } = setModelRecorder();
  // The health probe throws synchronously — the module must treat it as
  // "unknown" and proceed with the decision on context size alone.
  deps.healthFor = () => {
    throw new Error("health probe failed");
  };
  const harness = makeHarness(deps);
  harness.onHold();
  harness.onHold();
  harness.onHold();

  const session = new SessionContext("A", big, [big, small], 20_000);
  await harness.beforeAgentStart(session as unknown as FallbackContext);
  assert.equal(calls.length, 1, "the switch still happened");
  assert.equal(harness.getLastError(), undefined);
});

test("applyPendingFallback: unknown context size is a stay, not a switch", async () => {
  const big = FLASH();
  const small = QWEN();
  const { deps, calls } = setModelRecorder();
  // getContextUsage() is null right after compaction.
  const session = new SessionContext("A", big, [big, small], null);
  const pending: PendingFallback = { consecutiveHolds: FALLBACK_AFTER_HOLDS };
  const result = await applyPendingFallback(deps, session as unknown as FallbackContext, pending);
  assert.equal(result.switched, false);
  assert.equal(result.skipped, "stay");
  assert.equal(calls.length, 0);
});

test("applyPendingFallback: a setModel that returns false is a no-switch, no throw", async () => {
  const big = FLASH();
  const small = QWEN();
  const calls: M[] = [];
  const deps: FallbackApplyDeps = {
    setModel: (m) => {
      calls.push(m);
      return false;
    },
  };
  const session = new SessionContext("A", big, [big, small], 20_000);
  const pending: PendingFallback = { consecutiveHolds: FALLBACK_AFTER_HOLDS };
  const result = await applyPendingFallback(deps, session as unknown as FallbackContext, pending);
  assert.equal(result.switched, false);
  assert.equal(result.skipped, "set-model-declined");
  assert.equal(calls.length, 1, "setModel was attempted");
  assert.equal(session.notifyCalls.length, 0, "a declined switch is not announced");
});

test("applyPendingFallback: no current model is a safe no-op", async () => {
  const { deps, calls } = setModelRecorder();
  const session = new SessionContext("A", undefined, [FLASH(), QWEN()], 20_000);
  const pending: PendingFallback = { consecutiveHolds: FALLBACK_AFTER_HOLDS };
  const result = await applyPendingFallback(deps, session as unknown as FallbackContext, pending);
  assert.equal(result.switched, false);
  assert.equal(result.skipped, "no-current-model");
  assert.equal(calls.length, 0);
});

test("T7: an admission storm keeps state consistent and switches at most once", async () => {
  const big = FLASH();
  const small = QWEN();
  const { deps, calls } = setModelRecorder();
  const harness = makeHarness(deps);

  // A storm of 429 queue timeouts interleaved with progress and operator
  // intervention. At no point may state become inconsistent or throw.
  for (let i = 0; i < 200; i++) {
    harness.onHold({ modelId: big.id, provider: big.provider });
    if (i % 5 === 0) harness.coordinator.onProgress();
    if (i % 17 === 0) harness.coordinator.onModelSelect();
    // Invariants must hold continuously.
    assert.ok(Number.isInteger(harness.coordinator.holds) && harness.coordinator.holds >= 0);
    assert.equal(typeof harness.coordinator.hasPending, "boolean");
  }

  // Whatever is pending applies at most once.
  const session = new SessionContext("A", big, [big, small], 20_000);
  await harness.beforeAgentStart(session as unknown as FallbackContext);
  assert.ok(calls.length <= 1, "one claim yields at most one switch");
  assert.equal(harness.getLastError(), undefined);
});

test("T7: holds keep counting across progress until a real switch or select", () => {
  const c = new FallbackCoordinator();
  // 2 holds, progress (reset), 3 more holds → pending again.
  c.onGatewayHold();
  c.onGatewayHold();
  c.onProgress();
  assert.equal(c.holds, 0);
  c.onGatewayHold();
  c.onGatewayHold();
  c.onGatewayHold();
  assert.equal(c.hasPending, true, "the run restarts cleanly after progress");
});
