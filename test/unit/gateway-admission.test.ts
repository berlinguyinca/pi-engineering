/**
 * Model-gateway backpressure: signal parsing and process-wide admission.
 *
 * The fixture in the first test is a verbatim production payload — the one the
 * runtime was ignoring while it kept re-queuing work against a saturated
 * gateway.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import {
  decideGatewayRetry,
  describeGatewayWait,
  isAccountWideRefusal,
  parseGatewayWait,
  parseRetryAfterHeader,
} from "../../src/gateway/signals.ts";

const PRODUCTION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":100,"queued":30,"reason":"queue_timeout","request_id":"332ea9d2-6a34-4d06-ba7e-514081ccbdef","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';

// ─── Signal parsing ─────────────────────────────────────────────────────────

test("parses the reported wait and admission limits from a production 429", () => {
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  assert.equal(signal.retryAfterMs, 30_000);
  assert.equal(signal.source, "body");
  assert.equal(signal.retryable, true);
  assert.equal(signal.status, 429);
  assert.equal(signal.reason, "queue_timeout");
  assert.equal(signal.type, "inference_admission");
  assert.equal(signal.scope, "agent");
  assert.equal(signal.activeLimit, 4);
  assert.equal(signal.queued, 30);
  assert.equal(signal.queueLimit, 100);
  assert.equal(signal.requestId, "332ea9d2-6a34-4d06-ba7e-514081ccbdef");
});

test("describes a wait in one line", () => {
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  const text = describeGatewayWait(signal);
  assert.match(text, /429/);
  assert.match(text, /queue_timeout/);
  assert.match(text, /30s/);
});

test("shares the structural admission contract with the inference transport", () => {
  // The gateway signal parser reuses the inference `parseAdmissionPayload`
  // contract parser, so an envelope nested one level under `error` / `detail`
  // (the shape the inference transport already honours) is recognised here
  // too, with all fields populated from the shared structural parse.
  const nested = JSON.stringify({
    error: {
      type: "inference_admission",
      reason: "queue_timeout",
      retry_after_ms: 30_000,
      active_limit: 4,
      queued: 30,
      queue_limit: 100,
      request_id: "iw-9",
      scope: "agent",
    },
  });
  const signal = parseGatewayWait({ text: `429: ${nested}` });
  assert.ok(signal);
  assert.equal(signal.source, "body");
  assert.equal(signal.retryAfterMs, 30_000);
  assert.equal(signal.reason, "queue_timeout");
  assert.equal(signal.type, "inference_admission");
  assert.equal(signal.scope, "agent");
  assert.equal(signal.activeLimit, 4);
  assert.equal(signal.queued, 30);
  assert.equal(signal.queueLimit, 100);
  assert.equal(signal.requestId, "iw-9");
});

test("falls back to the Retry-After header when there is no body", () => {
  const signal = parseGatewayWait({ status: 429, headers: { "Retry-After": "12" } });
  assert.ok(signal);
  assert.equal(signal.retryAfterMs, 12_000);
  assert.equal(signal.source, "header");
});

test("parses an HTTP-date Retry-After against the injected clock", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const ms = parseRetryAfterHeader("Tue, 15 Sep 2026 12:00:45 GMT", now);
  assert.equal(ms, 45_000);
  // A date in the past clamps to zero rather than going negative.
  assert.equal(parseRetryAfterHeader("Tue, 15 Sep 2026 11:59:00 GMT", now), 0);
});

test("a saturation status with no wait at all still yields a default wait", () => {
  const signal = parseGatewayWait({ status: 503 });
  assert.ok(signal);
  assert.equal(signal.source, "default");
  assert.ok(signal.retryAfterMs > 0);
});

test("quota and billing exhaustion is reported as NON-retryable", () => {
  for (const text of [
    '429: {"message":"You exceeded your current quota","type":"insufficient_quota"}',
    "429 Too Many Requests: your credit balance is too low",
  ]) {
    const signal = parseGatewayWait({ text });
    assert.ok(signal, text);
    assert.equal(signal.retryable, false, text);
  }
});

test("legacy permanent admission reasons are non-retryable raw or nested", () => {
  for (const reason of ["quota_exhausted", "auth_failed", "forbidden", "malformed_request"]) {
    for (const body of [
      { type: "inference_admission", reason },
      { detail: { error: { type: "inference_admission", reason } } },
    ]) {
      const signal = parseGatewayWait({ status: 429, text: JSON.stringify(body) });
      assert.ok(signal);
      assert.equal(signal.retryable, false, `${reason}: ${JSON.stringify(body)}`);
    }
  }
});

test("409 and 413 remain non-retryable even with explicit safe replay flags", () => {
  const body = JSON.stringify({
    type: "inferweave_backpressure",
    reason: "queue_timeout",
    retryable: true,
    replay_safe: true,
    request_state: "queued",
    action: "backoff",
    action_code: "IW-ACT-BACKOFF",
  });
  for (const status of [409, 413]) {
    const signal = parseGatewayWait({ status, text: body });
    assert.ok(signal);
    assert.equal(signal.retryable, false, `status ${status}`);
  }
});

test("ordinary errors are not mistaken for backpressure", () => {
  assert.equal(parseGatewayWait({ text: "400: invalid request: unknown tool" }), null);
  assert.equal(parseGatewayWait({ text: "context window exceeded" }), null);
  assert.equal(parseGatewayWait({ status: 200 }), null);
  assert.equal(parseGatewayWait({}), null);
});

test("malformed payloads degrade instead of throwing", () => {
  const signal = parseGatewayWait({ text: '429: {"retry_after_ms": not-json' });
  assert.ok(signal);
  assert.equal(signal.status, 429);
  assert.equal(signal.source, "default");
});

test("a malformed new-contract marker is terminal instead of using legacy retry heuristics", () => {
  const signal = parseGatewayWait({
    text: '503: {"type":"inferweave_backpressure","retryable":tru',
    headers: { "retry-after": "8" },
  });
  assert.ok(signal);
  assert.equal(signal.type, "inferweave_backpressure");
  assert.equal(signal.retryable, false);
  assert.equal(signal.retryAfterMs, 8_000);
});

test("a retry_after_ms reported as a string is honoured", () => {
  const signal = parseGatewayWait({ text: '429: {"retry_after_ms":"1500","reason":"queue_timeout"}' });
  assert.equal(signal?.retryAfterMs, 1500);
});

// ─── Admission control ──────────────────────────────────────────────────────

/** A controller driven by a fake clock: `sleep` advances time, never waits. */
function testController(opts: { maxConcurrency?: number; reservedSlots?: number; maxWaitMs?: number } = {}) {
  let now = 1_000;
  const sleeps: number[] = [];
  const controller = new AdmissionController({
    maxConcurrency: opts.maxConcurrency ?? 4,
    reservedSlots: opts.reservedSlots ?? 0,
    ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
    jitterMs: 0,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0,
  });
  return { controller, sleeps };
}

test("the reported wait is honoured exactly, not backed off exponentially", async () => {
  const { controller, sleeps } = testController();
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);

  const waited = await controller.noteWaitAndSleep(signal);
  assert.equal(waited, 30_000);
  assert.deepEqual(sleeps, [30_000]);
  assert.equal(controller.cooldownRemainingMs(), 0);
});

test("the cooldown is process-wide: every caller waits, not just the one that was refused", async () => {
  const { controller, sleeps } = testController();
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);

  controller.noteWait(signal);
  assert.equal(controller.cooldownRemainingMs(), 30_000);

  // A caller that never saw the 429 is held too.
  const slot = await controller.acquire();
  assert.ok(sleeps.includes(30_000));
  assert.equal(controller.cooldownRemainingMs(), 0);
  slot.release();
});

test("a longer cooldown is never shortened by a later, smaller wait", () => {
  const { controller } = testController();
  controller.noteWait({ retryAfterMs: 30_000, retryable: true, source: "body" });
  controller.noteWait({ retryAfterMs: 1_000, retryable: true, source: "body" });
  assert.equal(controller.cooldownRemainingMs(), 30_000);
});

test("a server minimum is never shortened by the local wait setting", () => {
  const { controller } = testController({ maxWaitMs: 5_000 });
  const armed = controller.noteWait({ retryAfterMs: 86_400_000, retryable: true, source: "body" });
  assert.equal(armed, 86_400_000);
  assert.equal(controller.cooldownRemainingMs(), 86_400_000);
});

test("the interactive reserve applies from the start, before any gateway pushback", () => {
  // The window before the first 429 is exactly when the runtime was
  // overloading the gateway: 4 worker sessions PLUS the operator's own turn
  // against an admission window of 4.
  const { controller } = testController({ maxConcurrency: 4, reservedSlots: 1 });
  assert.equal(controller.status().concurrency, 3);
});

test("concurrency is clamped to the gateway's active_limit, minus the interactive reserve", () => {
  const { controller } = testController({ maxConcurrency: 8, reservedSlots: 1 });
  assert.equal(controller.status().concurrency, 7);
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  controller.noteWait(signal);
  // active_limit 4, one slot left for the operator's own turn.
  assert.equal(controller.status().concurrency, 3);
});

test("relaxing never reclaims the interactive reserve", () => {
  const { controller } = testController({ maxConcurrency: 4, reservedSlots: 1 });
  controller.noteWait({ retryAfterMs: 0, retryable: true, source: "body", activeLimit: 1 });
  assert.equal(controller.status().concurrency, 1);
  for (let i = 0; i < 60; i++) controller.noteSuccess();
  assert.equal(controller.status().concurrency, 3, "reserve stays held after recovery");
});

test("the clamp never drops below one slot", () => {
  const { controller } = testController({ maxConcurrency: 4, reservedSlots: 2 });
  controller.noteWait({ retryAfterMs: 0, retryable: true, source: "body", activeLimit: 1 });
  assert.equal(controller.status().concurrency, 1);
});

test("slots are bounded by the clamp and released back", async () => {
  const { controller } = testController({ maxConcurrency: 4 });
  controller.noteWait({ retryAfterMs: 0, retryable: true, source: "body", activeLimit: 2 });
  assert.equal(controller.status().concurrency, 2);

  const a = await controller.acquire();
  const b = await controller.acquire();
  assert.equal(controller.status().active, 2);

  let third = false;
  const pending = controller.acquire().then((slot) => {
    third = true;
    return slot;
  });
  await Promise.resolve();
  assert.equal(third, false, "a third caller must queue behind the clamp");

  a.release();
  const c = await pending;
  assert.equal(third, true);
  assert.equal(controller.status().active, 2);
  b.release();
  c.release();
  assert.equal(controller.status().active, 0);
});

test("releasing a slot twice does not corrupt the count", async () => {
  const { controller } = testController({ maxConcurrency: 1 });
  const slot = await controller.acquire();
  slot.release();
  slot.release();
  assert.equal(controller.status().active, 0);
});

test("the clamp relaxes back toward the configured maximum after clean runs", () => {
  const { controller } = testController({ maxConcurrency: 4 });
  controller.noteWait({ retryAfterMs: 0, retryable: true, source: "body", activeLimit: 1 });
  assert.equal(controller.status().concurrency, 1);
  for (let i = 0; i < 3; i++) controller.noteSuccess();
  assert.equal(controller.status().concurrency, 2);
  for (let i = 0; i < 3; i++) controller.noteSuccess();
  assert.equal(controller.status().concurrency, 3);
  for (let i = 0; i < 30; i++) controller.noteSuccess();
  assert.equal(controller.status().concurrency, 4, "never exceeds the configured maximum");
});

test("a fresh wait restarts the relax countdown", () => {
  const { controller } = testController({ maxConcurrency: 4 });
  controller.noteWait({ retryAfterMs: 0, retryable: true, source: "body", activeLimit: 1 });
  controller.noteSuccess();
  controller.noteSuccess();
  controller.noteWait({ retryAfterMs: 0, retryable: true, source: "body" });
  controller.noteSuccess();
  assert.equal(controller.status().concurrency, 1, "two pre-refusal successes must not count");
});

test("status and describe report the current hold", () => {
  const { controller } = testController();
  assert.equal(controller.describe(), null);
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  controller.noteWait(signal);
  const status = controller.status();
  assert.equal(status.cooldownMs, 30_000);
  assert.equal(status.lastSignal?.requestId, "332ea9d2-6a34-4d06-ba7e-514081ccbdef");
  assert.match(controller.describe() ?? "", /gateway backoff/);
});

// ─── Configuration ──────────────────────────────────────────────────────────

test("gateway config is tunable from the environment", () => {
  const saved = { ...process.env };
  try {
    process.env.PI_GATEWAY_MAX_CONCURRENCY = "2";
    process.env.PI_GATEWAY_RESERVED_SLOTS = "0";
    process.env.PI_GATEWAY_MAX_RETRIES = "7";
    process.env.PI_GATEWAY_ADMISSION_ENABLED = "false";
    const cfg = resolveGatewayConfig();
    assert.equal(cfg.maxConcurrency, 2);
    assert.equal(cfg.reservedSlots, 0);
    assert.equal(cfg.maxRetries, 7);
    assert.equal(cfg.enabled, false);
  } finally {
    process.env = saved;
  }
});

// ─── Worker retry policy ────────────────────────────────────────────────────

test("backpressure is retried outside the degeneration recovery ladder", () => {
  const first = decideGatewayRetry(PRODUCTION_429, 0, 4);
  assert.equal(first.action, "wait");
  assert.equal(first.action === "wait" ? first.signal.retryAfterMs : 0, 30_000);
});

test("the gateway retry budget is finite", () => {
  const spent = decideGatewayRetry(PRODUCTION_429, 4, 4);
  assert.equal(spent.action, "give-up");
  assert.equal(spent.action === "give-up" ? spent.reason : "", "retries-exhausted");
});

test("a hard quota refusal is never retried", () => {
  const quota = decideGatewayRetry('429: {"type":"insufficient_quota"}', 0, 4);
  assert.equal(quota.action, "give-up");
  assert.equal(quota.action === "give-up" ? quota.reason : "", "non-retryable");
});

test("non-gateway failures fall through to the normal failure path", () => {
  assert.equal(decideGatewayRetry(undefined, 0, 4).action, "not-gateway");
  assert.equal(decideGatewayRetry("tool 'read' not found", 0, 4).action, "not-gateway");
});

// ─── Observers ──────────────────────────────────────────────────────────────

test("subscribers receive admission events alongside the telemetry hook", () => {
  const seen: string[] = [];
  const hook: string[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => 1_000,
    sleep: async () => {},
    onEvent: (e) => hook.push(e.type),
  });
  const unsubscribe = controller.subscribe((e) => seen.push(e.type));

  controller.noteWait({ retryAfterMs: 30_000, retryable: true, source: "body", activeLimit: 1 });
  assert.deepEqual(hook, ["clamp", "wait"]);
  assert.deepEqual(seen, ["clamp", "wait"]);

  unsubscribe();
  controller.noteWait({ retryAfterMs: 1_000, retryable: true, source: "body" });
  assert.deepEqual(seen, ["clamp", "wait"], "unsubscribed listener must stop receiving");
});

test("a throwing subscriber cannot break admission control", () => {
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => 1_000,
    sleep: async () => {},
  });
  controller.subscribe(() => {
    throw new Error("listener blew up");
  });
  assert.doesNotThrow(() => controller.noteWait({ retryAfterMs: 5_000, retryable: true, source: "body" }));
  assert.equal(controller.cooldownRemainingMs(), 5_000);
});

test("the default controller clock is monotonic when wall time moves backward", () => {
  const originalDateNow = Date.now;
  try {
    Date.now = () => 100_000;
    const controller = new AdmissionController({ maxConcurrency: 1, jitterMs: 0 });
    controller.noteWait({ retryAfterMs: 1_000, retryable: true, source: "body" });
    Date.now = () => 0;
    assert.ok(controller.cooldownRemainingMs() <= 1_000, "a wall-clock rollback must not lengthen the cooldown");
  } finally {
    Date.now = originalDateNow;
  }
});

// ─── Finite waiting without shortening a server minimum ─────────────────────

test("the default retry and elapsed budgets are finite", () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_GATEWAY_")) delete process.env[key];
    const cfg = resolveGatewayConfig();
    assert.ok(Number.isFinite(cfg.maxRetries));
    assert.ok(cfg.maxRetries > 0);
    assert.ok(Number.isFinite(cfg.maxElapsedMs));
    assert.ok(cfg.maxElapsedMs > 0);
  } finally {
    process.env = saved;
  }
});

test("model-scoped cooldown does not pause another model", async () => {
  let now = 1_000;
  const slept: number[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  });
  controller.noteWait({
    retryAfterMs: 5_000,
    retryable: true,
    source: "body",
    scope: "model",
    provider: "acme",
    model: "busy",
  });
  assert.equal(controller.cooldownRemainingMs({ provider: "acme", model: "other" }), 0);
  assert.equal(controller.cooldownRemainingMs({ provider: "acme", model: "busy" }), 5_000);
  await controller.awaitCooldown({ provider: "acme", model: "other" });
  assert.deepEqual(slept, []);
  assert.equal(controller.status().concurrency, 4, "a model-scoped refusal must not clamp unrelated models");
});

test("programmatic non-finite gateway budgets normalize back to finite defaults", () => {
  const cfg = resolveGatewayConfig({ maxRetries: Number.POSITIVE_INFINITY, maxElapsedMs: Number.POSITIVE_INFINITY });
  assert.ok(Number.isFinite(cfg.maxRetries));
  assert.ok(Number.isFinite(cfg.maxElapsedMs));
});

test("an unlimited budget never gives up, however many waits have been spent", () => {
  const decision = decideGatewayRetry(PRODUCTION_429, 10_000, Number.POSITIVE_INFINITY);
  assert.equal(decision.action, "wait");
});

test("an explicit budget of zero still means zero (no sentinel collision with unlimited)", () => {
  const saved = { ...process.env };
  try {
    process.env.PI_GATEWAY_MAX_RETRIES = "0";
    assert.equal(resolveGatewayConfig().maxRetries, 0);
    assert.equal(decideGatewayRetry(PRODUCTION_429, 0, 0).action, "give-up");
  } finally {
    process.env = saved;
  }
});

test("an explicit elapsed budget of zero survives environment and programmatic configuration", () => {
  const saved = { ...process.env };
  try {
    process.env.PI_GATEWAY_MAX_ELAPSED_MS = "0";
    assert.equal(resolveGatewayConfig().maxElapsedMs, 0);
    assert.equal(resolveGatewayConfig({ maxElapsedMs: 0 }).maxElapsedMs, 0);
  } finally {
    process.env = saved;
  }
});

test("a long advertised wait is honoured in full by default", () => {
  // Clamping a 5-minute wait to 2 minutes only sends the retry into the same
  // saturated queue and earns the same 429.
  const { controller } = testController();
  const armed = controller.noteWait({ retryAfterMs: 300_000, retryable: true, source: "body" });
  assert.equal(armed, 300_000);
});

test("an unbounded wait is abortable: the operator's escape ends the hold", async () => {
  const { controller } = testController();
  const abort = new AbortController();
  controller.noteWait({ retryAfterMs: 600_000, retryable: true, source: "body" });
  abort.abort();
  const waited = await controller.awaitCooldown({ signal: abort.signal });
  assert.equal(waited, 0, "an already-aborted turn must not wait at all");
  assert.ok(controller.cooldownRemainingMs() > 0, "the cooldown itself still stands for everyone else");
});

test("aborting mid-hold stops that caller without shortening the process-wide cooldown", async () => {
  const now = 1_000;
  const abort = new AbortController();
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => now,
    // A sleeper that never settles on its own: only the abort can end this.
    sleep: () => new Promise<void>(() => {}),
  });
  controller.noteWait({ retryAfterMs: 600_000, retryable: true, source: "body" });
  const pending = controller.awaitCooldown({ signal: abort.signal });
  abort.abort();
  assert.equal(await pending, 0);
  assert.equal(controller.status().waiting, 0, "the waiter must be released from the ledger");
});

// ─── Caller-scoped waits ────────────────────────────────────────────────────
// A 429 admission refusal speaks for the whole account: `scope: "agent"`,
// `active_limit`, a queue position. Holding every caller behind it is the point.
//
// A bare `503 no worker for model` speaks only for ONE model. The parser still
// produces a signal, but with a synthesized wait, and arming the process-wide
// cooldown from it would stall workers on models that are perfectly healthy —
// the worse the escalation, the longer the unrelated stall.

test("a caller-scoped wait holds the caller without arming the process cooldown", async () => {
  const slept: number[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const signal = parseGatewayWait({ text: "503 no worker for model" });
  assert.ok(signal);
  assert.equal(signal.source, "default", "a synthesized wait, not one the gateway advertised");

  const waited = await controller.noteCallerWaitAndSleep(signal);

  assert.equal(waited, signal.retryAfterMs);
  assert.deepEqual(slept, [signal.retryAfterMs], "the caller really waited");
  assert.equal(controller.cooldownRemainingMs(), 0, "workers on other models must not be stalled by this");
});

test("a caller-scoped wait is still reported, so the status bar can show it", async () => {
  const events: string[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async () => {},
    onEvent: (e) => events.push(e.type),
  });
  const signal = parseGatewayWait({ text: "503 no worker for model" });
  assert.ok(signal);
  await controller.noteCallerWaitAndSleep(signal);

  assert.deepEqual(events, ["wait"], "the spinner and countdown come from this event");
});

test("a caller-scoped wait never clamps process concurrency", async () => {
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async () => {},
  });
  const before = controller.status().concurrency;
  // active_limit is an account-wide statement; a caller-scoped wait must not
  // act on it, or one model's outage would shrink the whole runtime.
  await controller.noteCallerWaitAndSleep({
    retryAfterMs: 5_000,
    retryable: true,
    source: "default",
    status: 503,
    activeLimit: 1,
  });

  assert.equal(controller.status().concurrency, before);
  assert.equal(controller.cooldownRemainingMs(), 0);
});

test("an advertised admission refusal still arms the process-wide cooldown", async () => {
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async () => {},
  });
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  controller.noteWait(signal);

  assert.ok(controller.cooldownRemainingMs() > 0, "this one genuinely speaks for every caller");
});

test("a caller-scoped wait can be abandoned with the turn's own signal", async () => {
  const aborter = new AbortController();
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  aborter.abort();
  const started = Date.now();
  await controller.noteCallerWaitAndSleep(
    { retryAfterMs: 30_000, retryable: true, source: "default", status: 503 },
    { signal: aborter.signal },
  );
  assert.ok(Date.now() - started < 1_000, "escape must not wait out a 30s hold");
});

test("an observed wait is reported without parking anyone", async () => {
  // The after-the-fact path: a terminal assistant error carrying a bare 503.
  // The caller that hit it has already dealt with it, so the rest of the
  // process must not be stalled — but the status bar should still see it.
  const events: string[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async () => {},
    onEvent: (e) => events.push(e.type),
  });
  const signal = parseGatewayWait({ text: "503 no worker for model" });
  assert.ok(signal);

  const waitMs = controller.noteObservedWait(signal);

  assert.equal(waitMs, signal.retryAfterMs);
  assert.deepEqual(events, ["wait"], "the footer still gets its spinner");
  assert.equal(controller.cooldownRemainingMs(), 0, "but nothing is parked");
  assert.equal(controller.status().lastSignal?.status, 503, "and it is remembered as the last refusal");
});

test("an observed wait never clamps concurrency", () => {
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    sleep: async () => {},
  });
  const before = controller.status().concurrency;
  controller.noteObservedWait({ retryAfterMs: 5_000, retryable: true, source: "default", status: 503, activeLimit: 1 });
  assert.equal(controller.status().concurrency, before);
});

test("an aborted hold clears its timer instead of pinning the event loop", async () => {
  // Found by fresh-context review. Racing a promise against the abort resolves
  // the caller promptly but leaves the timer pending, and a pending timer keeps
  // Node alive: escape during a 60s hold, then quit, and pi sits there for the
  // full 60s waiting on a timer nobody wants.
  const aborter = new AbortController();
  const controller = new AdmissionController({
    maxConcurrency: 4,
    reservedSlots: 1,
    maxWaitMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
  });

  const held = controller.noteCallerWaitAndSleep(
    { retryAfterMs: 60_000, retryable: true, source: "default", status: 503 },
    { signal: aborter.signal },
  );
  aborter.abort();
  await held;

  // A timer still pending here would hold the test runner open past this point.
  const pending = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout") ?? [];
  assert.equal(pending.length, 0, `a cancelled hold left ${pending.length} timer(s) running`);
});

// ─── What a refusal is ABOUT decides who waits ──────────────────────────────

test("scoping: an admission 429 speaks for the account", () => {
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  assert.equal(isAccountWideRefusal(signal), true);
});

test("scoping: a 429 carrying only a Retry-After header is still account-wide", () => {
  // The earlier discriminator keyed on `source === "body"` and put this on the
  // wrong side: a rate limit is about the account however it reports its wait.
  const signal = parseGatewayWait({ status: 429, headers: { "retry-after": "12" } });
  assert.ok(signal);
  assert.equal(signal.source, "header");
  assert.equal(isAccountWideRefusal(signal), true);
});

test("scoping: a bare 503 speaks for one model only", () => {
  const signal = parseGatewayWait({ text: "503 no worker for model" });
  assert.ok(signal);
  assert.equal(isAccountWideRefusal(signal), false, "one model's outage must not stall the whole runtime");
});

test("scoping: a queue timeout is account-wide whatever status carries it", () => {
  const signal = parseGatewayWait({ text: '{"reason":"queue_timeout","retry_after_ms":1000}' });
  assert.ok(signal);
  assert.equal(isAccountWideRefusal(signal), true);
});
