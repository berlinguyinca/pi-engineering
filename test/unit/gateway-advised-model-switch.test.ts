/**
 * Switching models on the gateway's IW-ACT-RETRY-ALTERNATE advice, mid-turn.
 *
 * The three halves and their seams (src/gateway/advisedSwitch.ts):
 *   - the coordinator arms on the FIRST advised hold, but only once a
 *     lifecycle preview recorded a stand-in — otherwise the hold is waited out;
 *   - the pump settles an advised hold at once when the caller says so
 *     (`abandonForAlternate`), with the advice on the error;
 *   - the settle handler claims the armed fallback, switches against the fresh
 *     ctx, omits the failed message and continues the turn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import {
  AdvisedModelSwitch,
  DEFAULT_STAY_WAIT_MS,
  MAX_STAY_CONTINUES,
  carriesAlternateAdvice,
} from "../../src/gateway/advisedSwitch.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import {
  type FallbackContext,
  FallbackCoordinator,
  applyPendingFallback,
  previewFallback,
} from "../../src/gateway/fallbackLifecycle.ts";
import { ALTERNATE_MODEL_ADVICE, ALTERNATE_MODEL_SWITCHING } from "../../src/gateway/signals.ts";
import { pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";

type M = Model<any>;

function model(id: string, contextWindow: number): M {
  return {
    id,
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow,
    maxTokens: 16_384,
    reasoning: false,
    input: ["text"],
  } as M;
}
const BIG = () => model("deepseek-v4-flash", 1_048_576);
const SMALL = () => model("qwen3.8-27b", 262_144);

function ctx(current: M | undefined, available: M[], usedTokens: number | null = 20_000) {
  const notifyCalls: string[] = [];
  const c: FallbackContext & { notifyCalls: string[] } = {
    notifyCalls,
    model: current,
    modelRegistry: { getAvailable: () => available },
    getContextUsage: () => (usedTokens == null ? undefined : { tokens: usedTokens }),
    ui: { notify: (message) => notifyCalls.push(message) },
  };
  return c;
}

/** The envelope from the report that motivated this, as Pi shows it. */
const ADVISED_429 =
  '429: {"message":"Try another eligible deployment after the declared delay.","type":"inferweave_backpressure","code":"capacity_unavailable","reason":"capacity_unavailable","retryable":true,"replay_safe":true,"request_state":"not_started","action":"retry_alternate","action_code":"IW-ACT-RETRY-ALTERNATE","retry_after_ms":20000,"scope":"model","model_intent":"qwen3.8-27b"}';

const advisedHold = (extra: Record<string, unknown> = {}) => ({
  modelId: "qwen3.8-27b",
  provider: "metabolomics",
  source: "body" as const,
  accountWide: false,
  advisesAlternate: true,
  ...extra,
});

// ─── Coordinator ────────────────────────────────────────────────────────────

test("advised: without a stand-in on record an advised hold arms nothing (it is waited out)", () => {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.onGatewayHold(advisedHold());
  assert.equal(c.hasPending, false);
  assert.equal(c.willSwitchOnAdvice, false);
});

test("advised: with a stand-in on record the FIRST advised hold arms a switch, even with the hold-count path off", () => {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.noteStandIn(true);
  assert.equal(c.willSwitchOnAdvice, true);
  c.onGatewayHold(advisedHold());
  assert.equal(c.hasPending, true);
  assert.equal(c.snapshot().reason, "gateway-advised-alternate");
  assert.equal(c.holds, 0, "the opt-in hold ledger is untouched when that path is off");
});

test("advised: a hold WITHOUT the advice never arms on the first hold", () => {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.noteStandIn(true);
  c.onGatewayHold(advisedHold({ advisesAlternate: false }));
  assert.equal(c.hasPending, false);
});

test("advised: switched off, the advice is ignored", () => {
  const c = new FallbackCoordinator({ advisedSwitch: false });
  c.noteStandIn(true);
  c.onGatewayHold(advisedHold());
  assert.equal(c.hasPending, false);
  assert.equal(c.willSwitchOnAdvice, false);
});

test("advised: an account-wide refusal or a transport drop carrying the advice does not arm", () => {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.noteStandIn(true);
  c.onGatewayHold(advisedHold({ accountWide: true }));
  c.onGatewayHold(advisedHold({ source: "transport-drop" }));
  assert.equal(c.hasPending, false);
});

test("advised: the model just left stays excluded across turns for the TTL; an operator select clears everything", () => {
  let clock = 1_000;
  const c = new FallbackCoordinator({ advisedSwitch: true, now: () => clock, switchedFromTtlMs: 60_000 });
  c.noteStandIn(true);
  c.onGatewayHold(advisedHold({ retryAfterMs: 20_000 }));
  const first = c.claimPending();
  assert.ok(first);
  assert.equal(first.excludeIds, undefined, "nothing excluded on the first switch");
  assert.equal(first.retryAfterMs, 20_000, "the declared delay travels with the pending switch");
  c.onSwitched("qwen3.8-27b");
  assert.deepEqual(c.excludedModelIds, ["qwen3.8-27b"]);

  c.onGatewayHold(advisedHold({ modelId: "deepseek-v4-flash" }));
  assert.deepEqual(c.claimPending()?.excludeIds, ["qwen3.8-27b"], "the stand-in's own refusal cannot ping-pong");

  // Output on the stand-in does NOT end the exclusion: capacity that
  // alternates between two models would otherwise bounce the session every turn.
  c.onProgress();
  assert.deepEqual(c.excludedModelIds, ["qwen3.8-27b"]);
  clock += 60_001;
  assert.deepEqual(c.excludedModelIds, [], "the exclusion expires");

  c.onSwitched("a");
  c.onModelSelect();
  assert.deepEqual(c.excludedModelIds, [], "/model clears it at once");
});

test("advised: a hold the pump will abandon does not count toward the opt-in hold ledger", () => {
  const c = new FallbackCoordinator({ enabled: true, advisedSwitch: true });
  c.noteStandIn(true);
  c.onGatewayHold(advisedHold());
  c.onGatewayHold(advisedHold());
  c.onGatewayHold(advisedHold());
  assert.equal(c.holds, 0, "Pi's retries of an abandoned attempt are not saturation evidence");
  assert.equal(c.snapshot().reason, "gateway-advised-alternate");
});

test("advised: the hold-count path still arms at its threshold with the advice absent", () => {
  const c = new FallbackCoordinator({ enabled: true, advisedSwitch: true });
  for (let i = 0; i < 3; i++) c.onGatewayHold(advisedHold({ advisesAlternate: false }));
  assert.equal(c.snapshot().reason, "gateway-admission-hold");
});

// ─── Chooser: exclusions and the preview ────────────────────────────────────

test("applyPendingFallback: an excluded model is never the stand-in", async () => {
  const big = BIG();
  const small = SMALL();
  const calls: M[] = [];
  const c = ctx(small, [big, small]);
  const result = await applyPendingFallback(
    {
      setModel: (m) => {
        calls.push(m);
        return true;
      },
    },
    c,
    {
      consecutiveHolds: 0,
      reason: "gateway-advised-alternate",
      excludeIds: [big.id],
    },
  );
  assert.equal(result.switched, false);
  assert.equal(result.skipped, "no-alternatives");
  assert.equal(calls.length, 0);
});

test("applyPendingFallback: an advised switch tells the operator why, naming both models", async () => {
  const big = BIG();
  const small = SMALL();
  const c = ctx(big, [big, small]);
  const result = await applyPendingFallback({ setModel: () => true }, c, {
    consecutiveHolds: 0,
    reason: "gateway-advised-alternate",
  });
  assert.equal(result.switched, true);
  assert.equal(result.targetId, small.id);
  assert.match(c.notifyCalls[0] ?? "", /gateway advises another model/);
  assert.match(c.notifyCalls[0] ?? "", new RegExp(`switched to ${small.id}`));
});

test("previewFallback: true only when the chooser would switch; it touches no setModel", async () => {
  const big = BIG();
  const small = SMALL();
  assert.equal(await previewFallback(ctx(big, [big, small])), true);
  assert.equal(await previewFallback(ctx(big, [big])), false, "no alternatives");
  assert.equal(await previewFallback(ctx(big, [big, small], null)), false, "unknown context size is a stay");
  assert.equal(await previewFallback(ctx(big, [big, small], 900_000)), false, "the session would not fit");
  assert.equal(await previewFallback(ctx(big, [big, small]), { excludeIds: [small.id] }), false);
});

// ─── Pump: abandoning an advised hold ───────────────────────────────────────

type Ev = { type: string; [k: string]: unknown };
type Res = { stopReason: string; errorMessage?: string };

function scripted(attempts: Ev[][]) {
  let opened = 0;
  const open = () => {
    const events = attempts[Math.min(opened, attempts.length - 1)] ?? [];
    opened++;
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    const result = (terminal?.message ?? terminal?.error ?? { stopReason: "stop" }) as Res;
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: async () => result,
    };
  };
  return {
    open,
    get opened() {
      return opened;
    },
  };
}

function sink() {
  const pushed: Ev[] = [];
  let ended: Res | undefined;
  return {
    pushed,
    get ended() {
      return ended;
    },
    push: (e: Ev) => pushed.push(e),
    end: (r?: Res) => {
      ended = r;
    },
  };
}

const failed429 = (): Ev => ({ type: "error", error: { stopReason: "error", errorMessage: ADVISED_429 } });

test("pump: an advised hold is settled at once when the caller abandons it, with the advice on the error", async () => {
  const s = scripted([
    [failed429()],
    [
      { type: "text_delta", text: "never" },
      { type: "done", message: { stopReason: "stop" } },
    ],
  ]);
  const out = sink();
  const held: number[] = [];
  const onHold: string[] = [];
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: async (signal) => {
      held.push(signal.retryAfterMs);
    },
    onHold: (info) => onHold.push(info.signal.actionCode ?? ""),
    abandonForAlternate: () => true,
  });
  assert.equal(s.opened, 1, "no retry on the model the gateway advised against");
  assert.deepEqual(held, [], "the wait is not taken");
  assert.deepEqual(onHold, ["IW-ACT-RETRY-ALTERNATE"], "the hold is still observed — that is what arms the switch");
  assert.equal(outcome.settled, "error");
  assert.equal(outcome.holds, 0);
  assert.equal(out.ended?.errorMessage, ALTERNATE_MODEL_SWITCHING);
  // Pi's auto-retry runs BEFORE the settle boundary that switches models; its
  // classifier must see nothing transient here, or it retries the refused
  // model three times first.
  assert.equal(
    isRetryableAssistantError({
      role: "assistant",
      stopReason: "error",
      errorMessage: ALTERNATE_MODEL_SWITCHING,
    } as never),
    false,
  );
  assert.ok(
    carriesAlternateAdvice({ errorMessage: ALTERNATE_MODEL_SWITCHING }),
    "the settle handler still recognises it",
  );
});

test("pump: a refusal that arrives as a THROW is never abandoned (no guidance could reach the message)", async () => {
  let opened = 0;
  const open = () => {
    opened++;
    return {
      async *[Symbol.asyncIterator]() {
        if (opened === 1) throw new Error(ADVISED_429);
        yield { type: "text_delta", text: "ok" } as Ev;
        yield { type: "done", message: { stopReason: "stop" } } as Ev;
      },
      result: async () => ({ stopReason: "stop" }) as Res,
    };
  };
  const out = sink();
  const held: number[] = [];
  let asked = 0;
  const outcome = await pumpWithGatewayRetry(open, out, {
    hold: async (signal) => {
      held.push(signal.retryAfterMs);
    },
    abandonForAlternate: () => {
      asked++;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.deepEqual(held, [20_000], "waited out instead");
  assert.equal(outcome.settled, "ok");
});

test("pump: when the caller does not abandon, an advised hold is waited out as before", async () => {
  const s = scripted([
    [failed429()],
    [
      { type: "text_delta", text: "ok" },
      { type: "done", message: { stopReason: "stop" } },
    ],
  ]);
  const out = sink();
  const held: number[] = [];
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: async (signal) => {
      held.push(signal.retryAfterMs);
    },
    abandonForAlternate: () => false,
  });
  assert.equal(s.opened, 2);
  assert.deepEqual(held, [20_000], "the declared delay is honoured");
  assert.equal(outcome.settled, "ok");
});

test("pump: a plain saturation hold never consults abandonForAlternate", async () => {
  const s = scripted([
    [{ type: "error", error: { stopReason: "error", errorMessage: "503 no worker for model" } }],
    [
      { type: "text_delta", text: "ok" },
      { type: "done", message: { stopReason: "stop" } },
    ],
  ]);
  const out = sink();
  let asked = 0;
  await pumpWithGatewayRetry(s.open, out, {
    hold: async () => {},
    abandonForAlternate: () => {
      asked++;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.equal(s.opened, 2);
});

// ─── Settle handler ─────────────────────────────────────────────────────────

function settleEvent(message: Record<string, unknown> | undefined, outcome: "error" | "completed" = "error") {
  return {
    outcome,
    entries: [{ type: "custom", customType: "other-handler" }],
    context: {
      contextEntries: [
        { sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hi" }] },
        ...(message ? [{ sourceEntry: { id: "a1" }, messages: [message] }] : []),
      ],
    },
  } as never;
}

const failedAdvised = (content: unknown[] = []) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage: `${ADVISED_429} — ${ALTERNATE_MODEL_ADVICE}`,
  content,
});

function handler(opts: { pending?: boolean; switched?: boolean; throws?: boolean; owe?: boolean } = {}) {
  const c = new FallbackCoordinator({ advisedSwitch: true });
  c.noteStandIn(true);
  if (opts.pending !== false) c.onGatewayHold(advisedHold({ retryAfterMs: 20_000 }));
  const applied: FallbackContext[] = [];
  const owed: Array<{ delayMs: number; attempt: number }> = [];
  const h = new AdvisedModelSwitch({
    claimPending: () => c.claimPending(),
    apply: async (ctx) => {
      applied.push(ctx);
      if (opts.throws) throw new Error("boom");
      return opts.switched === false
        ? { switched: false, skipped: "stay", reason: "no model fits" }
        : { switched: true, currentId: "qwen3.8-27b", targetId: "deepseek-v4-flash", reason: "fits" };
    },
    ...(opts.owe ? { oweWait: (_ctx, delayMs, attempt) => owed.push({ delayMs, attempt }) } : {}),
  });
  return { c, h, applied, owed };
}

test("settle: an abandoned advised failure switches models, omits the failed message and continues the turn", async () => {
  const { c, h, applied } = handler();
  const fresh = ctx(SMALL(), [BIG(), SMALL()]);
  const result = await h.onBeforeSettle(settleEvent(failedAdvised()), fresh);
  assert.equal(applied.length, 1, "applied exactly once");
  assert.equal(applied[0], fresh, "against the settle callback's own ctx");
  assert.equal(c.hasPending, false, "the pending flag is consumed");
  assert.deepEqual(result, {
    entries: [
      { type: "custom", customType: "other-handler" },
      { type: "context_edit", targetId: "a1", replacement: null },
    ],
    continue: true,
  });
});

test("settle: no stand-in fits and no wait seam — the turn ends with the advice, nothing is replayed", async () => {
  const { h } = handler({ switched: false });
  assert.equal(await h.onBeforeSettle(settleEvent(failedAdvised()), ctx(SMALL(), [SMALL()])), undefined);
});

test("settle: the stand-in on record is gone — owe the skipped wait and continue on the same model, bounded", async () => {
  const { c, h, owed } = handler({ switched: false, owe: true });
  const fresh = ctx(SMALL(), [SMALL()]);
  const replay = {
    entries: [
      { type: "custom", customType: "other-handler" },
      { type: "context_edit", targetId: "a1", replacement: null },
    ],
    continue: true,
  };
  for (let i = 1; i <= MAX_STAY_CONTINUES; i++) {
    c.onGatewayHold(advisedHold({ retryAfterMs: 20_000 }));
    assert.deepEqual(await h.onBeforeSettle(settleEvent(failedAdvised()), fresh), replay, `stay ${i} continues`);
    assert.deepEqual(owed.at(-1), { delayMs: 20_000, attempt: i }, "the declared delay is owed, not skipped");
  }
  c.onGatewayHold(advisedHold({ retryAfterMs: 20_000 }));
  assert.equal(await h.onBeforeSettle(settleEvent(failedAdvised()), fresh), undefined, "past the cap the turn ends");
  assert.equal(owed.length, MAX_STAY_CONTINUES);

  // A completed turn resets the cap.
  await h.onBeforeSettle(settleEvent(undefined, "completed"), fresh);
  c.onGatewayHold(advisedHold());
  assert.deepEqual(await h.onBeforeSettle(settleEvent(failedAdvised()), fresh), replay);
  assert.deepEqual(owed.at(-1), { delayMs: DEFAULT_STAY_WAIT_MS, attempt: 1 }, "no declared delay: the default");
});

test("settle: the abandoned attempt's own marker text is enough to act on", async () => {
  const { h } = handler();
  const result = await h.onBeforeSettle(
    settleEvent({ role: "assistant", stopReason: "error", errorMessage: ALTERNATE_MODEL_SWITCHING, content: [] }),
    ctx(SMALL(), [BIG(), SMALL()]),
  );
  assert.equal(result?.continue, true);
});

test("settle: a boundary event without context entries is a no-op, not a throw", async () => {
  const { h } = handler();
  assert.equal(await h.onBeforeSettle({ outcome: "error" } as never, ctx(SMALL(), [SMALL()])), undefined);
});

test("settle: a throwing switch is contained; Pi stays alive and the turn ends", async () => {
  const { h } = handler({ throws: true });
  assert.equal(await h.onBeforeSettle(settleEvent(failedAdvised()), ctx(SMALL(), [SMALL()])), undefined);
});

test("settle: nothing armed (the hold was waited out) means no switch and no claim", async () => {
  const { h, applied } = handler({ pending: false });
  assert.equal(await h.onBeforeSettle(settleEvent(failedAdvised()), ctx(SMALL(), [SMALL()])), undefined);
  assert.equal(applied.length, 0);
});

test("settle: a completed turn, a failure after visible output, or a failure without the advice are not ours", async () => {
  const { c, h, applied } = handler();
  const fresh = ctx(SMALL(), [BIG(), SMALL()]);
  assert.equal(await h.onBeforeSettle(settleEvent(failedAdvised(), "completed"), fresh), undefined);
  assert.equal(
    await h.onBeforeSettle(settleEvent(failedAdvised([{ type: "text", text: "partial" }])), fresh),
    undefined,
    "after output the replay belongs to AfterOutputRetry",
  );
  assert.equal(
    await h.onBeforeSettle(
      settleEvent({ role: "assistant", stopReason: "error", errorMessage: "503 no worker for model", content: [] }),
      fresh,
    ),
    undefined,
  );
  assert.equal(applied.length, 0);
  assert.equal(c.hasPending, true, "an unrelated failure leaves the armed fallback for before_agent_start");
});

test("carriesAlternateAdvice: the marker, or the parsed envelope", () => {
  assert.equal(carriesAlternateAdvice({ errorMessage: `x — ${ALTERNATE_MODEL_ADVICE}` }), true);
  assert.equal(carriesAlternateAdvice({ errorMessage: ADVISED_429 }), true);
  assert.equal(carriesAlternateAdvice({ errorMessage: "503 no worker for model" }), false);
  assert.equal(carriesAlternateAdvice(undefined), false);
});

// ─── Config ─────────────────────────────────────────────────────────────────

test("config: following the gateway's advice is on by default and has an ordinary off switch", () => {
  const saved = process.env.PI_GATEWAY_ADVISED_MODEL_SWITCH;
  try {
    delete process.env.PI_GATEWAY_ADVISED_MODEL_SWITCH;
    assert.equal(resolveGatewayConfig().advisedModelSwitch, true);
    process.env.PI_GATEWAY_ADVISED_MODEL_SWITCH = "false";
    assert.equal(resolveGatewayConfig().advisedModelSwitch, false);
  } finally {
    if (saved === undefined) delete process.env.PI_GATEWAY_ADVISED_MODEL_SWITCH;
    else process.env.PI_GATEWAY_ADVISED_MODEL_SWITCH = saved;
  }
});
