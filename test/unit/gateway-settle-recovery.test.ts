/**
 * Last-resort settle recovery (src/gateway/settleRecovery.ts).
 *
 * The error strings are copied from real session logs (~/.pi/agent/sessions):
 * these are the failures that left sessions waiting for a human "retry".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SettleRecovery,
  recoverableFailure,
  resolveSettleRecovery,
  settleRecoveryEnabled,
} from "../../src/gateway/settleRecovery.ts";
import { ALTERNATE_MODEL_SWITCHING } from "../../src/gateway/signals.ts";

const fail = (errorMessage: string, content: unknown[] = []) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage,
  content,
});

const ADVISED_429 =
  '429: {"message":"Try another eligible deployment after the declared delay.","type":"inferweave_backpressure","code":"capacity_unavailable","reason":"capacity_unavailable","retryable":true,"replay_safe":true,"request_state":"not_started","action":"retry_alternate","action_code":"IW-ACT-RETRY-ALTERNATE","retry_after_ms":20000,"scope":"model","model_intent":"qwen3.8-27b"}';
const QUEUE_TIMEOUT =
  '503: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":8,"queued":8,"code":"queue_timeout","retryable":true,"replay_safe":true,"request_state":"queued","action":"backoff","action_code":"IW-ACT-BACKOFF","retry_after_ms":30000}';
const DO_NOT_RETRY =
  '503: {"action":"do_not_retry","action_code":"IW-ACT-DO-NOT-RETRY","code":"invalid_upstream_response","message":"bad upstream"}';
const FIX_REQUEST =
  '404: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"model_not_found","message":"Model qwen3.8-27b-q4-262k not found"}';

test("recoverableFailure: the failures that stalled real sessions are recoverable", () => {
  for (const text of [
    "Stream ended without finish_reason",
    "terminated",
    "Request timed out.",
    "Connection error.",
    "502 <html>\r\n<head><title>502 Bad Gateway</title></head>",
    "500 proxy error: Could not establish connection",
    ADVISED_429,
    QUEUE_TIMEOUT,
    ALTERNATE_MODEL_SWITCHING,
    "no capacity on this deployment; gateway advises an alternate model — switching automatically if one fits, else switch with /model",
  ]) {
    assert.ok(recoverableFailure(fail(text)), `should recover: ${text.slice(0, 60)}`);
  }
});

test("recoverableFailure: final refusals and operator-owned cases are not recovered", () => {
  for (const text of [
    DO_NOT_RETRY,
    FIX_REQUEST,
    "400 proxy: request exceeds available context windows\n",
    '413: {"message":"1000000 tokens exceeds the 262144-token pool","type":"context_too_large","code":413}',
  ]) {
    assert.equal(recoverableFailure(fail(text)), undefined, `should not recover: ${text.slice(0, 60)}`);
  }
  // Output on screen is AfterOutputRetry's; an abort is the operator's.
  assert.equal(recoverableFailure(fail("terminated", [{ type: "text", text: "partial" }])), undefined);
  assert.equal(
    recoverableFailure({ role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" }),
    undefined,
  );
  assert.equal(recoverableFailure(undefined), undefined);
});

test("recoverableFailure: a gateway-advertised wait is carried through", () => {
  assert.equal(recoverableFailure(fail(QUEUE_TIMEOUT))?.advertisedWaitMs, 30_000);
});

// ─── The handler ───────────────────────────────────────────────────────────

const MODEL = { provider: "metabolomics", id: "qwen3.8-27b", contextWindow: 262_144 };

function harness(
  options: Partial<ConstructorParameters<typeof SettleRecovery>[1]> = {},
  deps: { paced?: boolean; pending?: boolean } = {},
) {
  const owed: Array<{ delayMs: number; attempt: number; label: string }> = [];
  let clock = 1_000_000;
  const handler = new SettleRecovery(
    {
      owe: (_ctx, delayMs, attempt, label) => owed.push({ delayMs, attempt, label }),
      isPaced: () => deps.paced ?? true,
      hasPendingWait: () => deps.pending ?? false,
    },
    { random: () => 0, now: () => clock, ...options },
  );
  const event = (errorMessage: string, extra: Record<string, unknown> = {}) => ({
    outcome: "error" as const,
    entries: [] as unknown[],
    context: { contextEntries: [{ sourceEntry: { id: "e1" }, messages: [fail(errorMessage)] }] },
    ...extra,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { handler, owed, event, advance };
}

test("continues a failed turn, dropping the failed message, and owes a paced wait", () => {
  const h = harness();
  const out = h.handler.onBeforeSettle(h.event("Stream ended without finish_reason"), { model: MODEL });
  assert.equal(out?.continue, true);
  assert.deepEqual(out?.entries, [{ type: "context_edit", targetId: "e1", replacement: null }]);
  assert.equal(h.owed.length, 1);
  assert.equal(h.owed[0]!.delayMs, 30_000);
});

test("escalates to the cap, then holds there", () => {
  const h = harness();
  for (let i = 0; i < 8; i++) h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  assert.deepEqual(
    h.owed.map((o) => o.delayMs),
    [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000],
  );
});

test("honours a longer gateway-advertised wait but caps it", () => {
  const h = harness();
  h.handler.onBeforeSettle(h.event(QUEUE_TIMEOUT), { model: MODEL });
  assert.equal(h.owed[0]!.delayMs, 30_000);
  const long = harness({ maxAdvertisedWaitMs: 45_000 });
  long.handler.onBeforeSettle(long.event(QUEUE_TIMEOUT.replace("30000", "900000")), { model: MODEL });
  assert.equal(long.owed[0]!.delayMs, 45_000);
});

test("defers when an earlier handler already asked to continue", () => {
  const h = harness();
  const out = h.handler.onBeforeSettle(
    h.event("terminated", { entries: [{ type: "context_edit", targetId: "e1", replacement: null }] }),
    { model: MODEL },
  );
  assert.equal(out, undefined);
  assert.equal(h.owed.length, 0);
});

test("never recovers an abort, a completed turn, or a final refusal", () => {
  const h = harness();
  assert.equal(h.handler.onBeforeSettle({ ...h.event("terminated"), outcome: "aborted" }, { model: MODEL }), undefined);
  assert.equal(
    h.handler.onBeforeSettle({ ...h.event("terminated"), outcome: "completed" }, { model: MODEL }),
    undefined,
  );
  assert.equal(h.handler.onBeforeSettle(h.event(DO_NOT_RETRY), { model: MODEL }), undefined);
  assert.equal(h.owed.length, 0);
});

test("gives up at the horizon", () => {
  const h = harness({ horizonMs: 10 * 60_000 });
  assert.ok(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL })?.continue);
  h.advance(11 * 60_000);
  assert.equal(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL }), undefined);
  // The episode is over: the next failure starts a fresh one.
  assert.ok(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL })?.continue);
});

test("gives up after maxAttempts so a hard failure cannot spin", () => {
  const h = harness({ maxAttempts: 3 });
  const results = Array.from({ length: 5 }, () => h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL }));
  assert.deepEqual(
    results.map((r) => r?.continue === true),
    [true, true, true, false, true],
  );
});

test("a completed turn resets the episode", () => {
  const h = harness({ maxAttempts: 2 });
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  h.handler.onBeforeSettle({ ...h.event("x"), outcome: "completed" }, { model: MODEL });
  assert.ok(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL })?.continue);
  assert.equal(h.owed.at(-1)!.delayMs, 30_000);
});

test("a successful assistant message ends the episode, mid-run", () => {
  const h = harness({ maxAttempts: 2 });
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  assert.equal(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL }), undefined);
  h.handler.onMessageEnd({ role: "assistant", stopReason: "toolUse" });
  assert.ok(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL })?.continue);
  assert.equal(h.owed.at(-1)!.delayMs, 30_000);
  // A failed assistant message and a tool result are not success.
  h.handler.onMessageEnd({ role: "assistant", stopReason: "error" });
  h.handler.onMessageEnd({ role: "toolResult" });
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  assert.equal(h.owed.at(-1)!.delayMs, 60_000);
});

test("registers the settle, settled and message_end hooks", () => {
  const h = harness();
  const seen: string[] = [];
  h.handler.register({ on: (name: string) => void seen.push(name) });
  assert.deepEqual(seen, ["agent_before_settle", "agent_settled", "message_end"]);
});

test("a model switch starts a fresh budget", () => {
  const h = harness();
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL });
  h.handler.onBeforeSettle(h.event("terminated"), { model: { ...MODEL, id: "deepseek-v4-flash" } });
  assert.equal(h.owed.at(-1)!.delayMs, 30_000);
});

test("exhausted quota and spend limits are final, not waited out", () => {
  for (const text of [
    '429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":86400}}',
    "429 Rate limit reached: monthly spend limit reached",
    "429 insufficient_quota: you exceeded your current quota",
  ]) {
    assert.equal(recoverableFailure(fail(text)), undefined, text.slice(0, 50));
  }
});

test("stays silent when an earlier handler already owes a wait", () => {
  const h = harness({}, { pending: true });
  assert.equal(h.handler.onBeforeSettle(h.event("terminated"), { model: MODEL }), undefined);
});

test("does not retry when requests bypass the pacing wrapper, or a wait is already owed", () => {
  const unpaced = harness({}, { paced: false });
  assert.equal(unpaced.handler.onBeforeSettle(unpaced.event("terminated"), { model: MODEL }), undefined);
  const pending = harness({}, { pending: true });
  assert.equal(pending.handler.onBeforeSettle(pending.event("terminated"), { model: MODEL }), undefined);
  assert.equal(unpaced.owed.length + pending.owed.length, 0);
});

test("resolveSettleRecovery reads env overrides", () => {
  const o = resolveSettleRecovery({
    PI_SETTLE_RECOVERY_HORIZON_MS: "60000",
    PI_SETTLE_RECOVERY_BASE_MS: "1000",
    PI_SETTLE_RECOVERY_CAP_MS: "5000",
    PI_SETTLE_RECOVERY_MAX_ATTEMPTS: "7",
  });
  assert.equal(o.horizonMs, 60_000);
  assert.equal(o.baseMs, 1_000);
  assert.equal(o.capMs, 5_000);
  assert.equal(o.maxAttempts, 7);
});

test("the horizon follows the shared PI_GATEWAY_MAX_ELAPSED_MS window", () => {
  assert.equal(resolveSettleRecovery({ PI_GATEWAY_MAX_ELAPSED_MS: "600000" }).horizonMs, 600_000);
  assert.equal(
    resolveSettleRecovery({ PI_GATEWAY_MAX_ELAPSED_MS: "600000", PI_SETTLE_RECOVERY_HORIZON_MS: "5000" }).horizonMs,
    5_000,
  );
});

test("PI_SETTLE_RECOVERY=0 turns the handler off", () => {
  assert.equal(settleRecoveryEnabled({ PI_SETTLE_RECOVERY: "0" }), false);
  assert.equal(settleRecoveryEnabled({}), true);
});

// ─── Reporting each decision ───────────────────────────────────────────────

import { type RecoveryDecision, describeDecision } from "../../src/gateway/settleRecovery.ts";
import { createInspectorSlot } from "../../src/runtime/herdr/attachInspector.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";

function reporting(options: Partial<ConstructorParameters<typeof SettleRecovery>[1]> = {}, throwing = false) {
  const decisions: RecoveryDecision[] = [];
  const handler = new SettleRecovery(
    {
      owe: () => {},
      isPaced: () => true,
      hasPendingWait: () => false,
      onDecision: (d) => {
        decisions.push(d);
        if (throwing) throw new Error("sink down");
      },
    },
    { random: () => 0, ...options },
  );
  const event = (text: string) => ({
    outcome: "error" as const,
    entries: [] as unknown[],
    context: { contextEntries: [{ sourceEntry: { id: "e1" }, messages: [fail(text)] }] },
  });
  return { handler, decisions, event };
}

test("every continue and the give-up are reported, with the model and what failed", () => {
  const r = reporting({ maxAttempts: 1 });
  r.handler.onBeforeSettle(r.event("terminated"), { model: MODEL });
  r.handler.onBeforeSettle(r.event("terminated"), { model: MODEL });
  assert.deepEqual(
    r.decisions.map((d) => [d.action, d.attempt, d.model]),
    [
      ["continue", 1, "qwen3.8-27b"],
      ["giveup", 1, "qwen3.8-27b"],
    ],
  );
  assert.equal(r.decisions[0]!.delayMs, 30_000);
});

test("a reporting sink that throws changes nothing about recovery", () => {
  const r = reporting({}, true);
  assert.equal(r.handler.onBeforeSettle(r.event("terminated"), { model: MODEL })?.continue, true);
});

test("decisions also reach a telemetry sink as structured detail", () => {
  const seen: Array<{ key?: string; detail?: unknown }> = [];
  const off = setTelemetrySink((n) => seen.push(n));
  try {
    const r = reporting();
    r.handler.onBeforeSettle(r.event("terminated"), { model: MODEL });
  } finally {
    off();
  }
  const notice = seen.find((n) => n.key === "settle-recovery:attempt");
  assert.equal((notice?.detail as { type?: string; action?: string }).type, "settle-recovery");
  assert.equal((notice?.detail as { action?: string }).action, "continue");
});

test("describeDecision gives one readable line per action", () => {
  const base = { attempt: 3, elapsedMs: 600_000, kind: "truncated stream", model: "qwen3.8-27b" };
  assert.match(describeDecision({ ...base, action: "continue", delayMs: 120_000 }), /continuing in 2m \(attempt 3\)/);
  assert.match(
    describeDecision({ ...base, action: "giveup" }),
    /gave up on qwen3.8-27b after 3 attempts over 10m.*needs an operator/,
  );
  assert.match(describeDecision({ ...base, action: "unpaced" }), /not recovering/);
});

test("the inspector slot turns a note into a system message, and drops it until the feed is attached", () => {
  const slot = createInspectorSlot();
  slot.note("[recovery] before attach");
  const pushed: Array<Record<string, unknown>> = [];
  slot.set({
    feed: { push: (e: Record<string, unknown>) => pushed.push(e) },
    associate() {},
    flush() {},
    dispose() {},
  } as never);
  slot.note("[recovery] attempt 1");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.kind, "message");
  assert.equal(pushed[0]!.role, "system");
  assert.equal(pushed[0]!.text, "[recovery] attempt 1");
  assert.match(String(pushed[0]!.message_id), /^recovery-/);
});

test("a model that bypasses the wrapper is reported as unpaced, once", () => {
  const decisions: RecoveryDecision[] = [];
  const handler = new SettleRecovery(
    { owe: () => {}, isPaced: () => false, hasPendingWait: () => false, onDecision: (d) => decisions.push(d) },
    { random: () => 0 },
  );
  const event = {
    outcome: "error" as const,
    entries: [] as unknown[],
    context: { contextEntries: [{ sourceEntry: { id: "e1" }, messages: [fail("terminated")] }] },
  };
  assert.equal(handler.onBeforeSettle(event, { model: MODEL }), undefined);
  assert.deepEqual(
    decisions.map((d) => d.action),
    ["unpaced"],
  );
});

test("inspector notes carry a timestamp, are not truncated, and have unique ids", () => {
  const slot = createInspectorSlot();
  const pushed: Array<Record<string, unknown>> = [];
  slot.set({
    feed: { push: (e: Record<string, unknown>) => pushed.push(e) },
    associate() {},
    flush() {},
    dispose() {},
  } as never);
  slot.note("one");
  slot.note("two");
  assert.equal(pushed.length, 2);
  assert.notEqual(pushed[0]!.message_id, pushed[1]!.message_id);
  assert.equal(pushed[0]!.truncated, false);
  assert.ok(Number.isFinite(Date.parse(String(pushed[0]!.ts))));
});
