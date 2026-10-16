import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WAIT_MS, classifyBackpressure } from "../../src/gateway/backpressureSignal.ts";

test("429 caller_concurrency is quota and waits on the same endpoint", () => {
  const signal = classifyBackpressure({
    status: 429,
    body: { code: "caller_concurrency", reason: "caller_concurrency", retry_after_ms: 5000 },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.action, "wait_same");
  assert.equal(signal.waitMs, 5000);
});

test("429 caller_queue_full is quota and waits on the same endpoint", () => {
  const signal = classifyBackpressure({ status: 429, body: { code: "caller_queue_full" } });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.action, "wait_same");
});

test("bare 429 with no code is quota", () => {
  const signal = classifyBackpressure({ status: 429 });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.action, "wait_same");
  assert.equal(signal.reason, "unknown");
});

test("429 capacity_unavailable is capacity and retries an alternate", () => {
  const signal = classifyBackpressure({
    status: 429,
    body: { code: "capacity_unavailable", reason: "capacity_unavailable", retry_after_ms: 8000 },
  });
  assert.equal(signal.kind, "capacity");
  assert.equal(signal.action, "retry_alternate");
  assert.equal(signal.waitMs, 8000);
});

test("503 backend_saturated is capacity and retries an alternate", () => {
  const signal = classifyBackpressure({ status: 503, body: { code: "backend_saturated" } });
  assert.equal(signal.kind, "capacity");
  assert.equal(signal.action, "retry_alternate");
});

test("action retry_alternate implies capacity regardless of code", () => {
  const signal = classifyBackpressure({ status: 503, body: { action: "retry_alternate" } });
  assert.equal(signal.kind, "capacity");
  assert.equal(signal.action, "retry_alternate");
});

test("context_capacity shrinks the context", () => {
  const signal = classifyBackpressure({ status: 503, body: { code: "context_capacity" } });
  assert.equal(signal.kind, "context");
  assert.equal(signal.action, "shrink_context");
});

test("model_context_exceeded shrinks the context", () => {
  const signal = classifyBackpressure({ status: 429, body: { code: "model_context_exceeded" } });
  assert.equal(signal.kind, "context");
  assert.equal(signal.action, "shrink_context");
});

test("no_context_capable_backend shrinks the context", () => {
  const signal = classifyBackpressure({ status: 503, body: { code: "no_context_capable_backend" } });
  assert.equal(signal.kind, "context");
  assert.equal(signal.action, "shrink_context");
});

test("other statuses are unknown and take no action", () => {
  const signal = classifyBackpressure({ status: 500, body: { code: "capacity_unavailable" } });
  assert.equal(signal.kind, "unknown");
  assert.equal(signal.action, "none");
});

test("waitMs falls back to the Retry-After header seconds", () => {
  const signal = classifyBackpressure({
    status: 429,
    headers: { "Retry-After": "2" },
    body: { code: "caller_queue_full" },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, 2000);
});

test("waitMs is null when neither body nor header provides it", () => {
  const signal = classifyBackpressure({ status: 429, body: { code: "caller_concurrency" } });
  assert.equal(signal.waitMs, null);
});

test("body retry_after_ms wins over the Retry-After header", () => {
  const signal = classifyBackpressure({
    status: 429,
    headers: { "Retry-After": "10" },
    body: { code: "caller_concurrency", retry_after_ms: 3000 },
  });
  assert.equal(signal.waitMs, 3000);
});

test("replaySafe from body replaySafe", () => {
  const signal = classifyBackpressure({ status: 429, body: { code: "caller_concurrency", replaySafe: true } });
  assert.equal(signal.replaySafe, true);
});

test("replaySafe from requestState not_started, defaults false otherwise", () => {
  assert.equal(
    classifyBackpressure({ status: 429, body: { code: "caller_concurrency", requestState: "not_started" } }).replaySafe,
    true,
  );
  assert.equal(classifyBackpressure({ status: 429, body: { code: "caller_concurrency" } }).replaySafe, false);
});

test("classifyBackpressure(null) is unknown and does not throw", () => {
  const signal = classifyBackpressure(null);
  assert.equal(signal.kind, "unknown");
  assert.equal(signal.action, "none");
  assert.equal(signal.waitMs, null);
});

test("classifyBackpressure(undefined) is unknown", () => {
  const signal = classifyBackpressure(undefined);
  assert.equal(signal.kind, "unknown");
  assert.equal(signal.waitMs, null);
});

test("classifyBackpressure('x') is unknown", () => {
  const signal = classifyBackpressure("x");
  assert.equal(signal.kind, "unknown");
  assert.equal(signal.action, "none");
});

test("numeric string status '429' behaves like 429", () => {
  const signal = classifyBackpressure({ status: "429", body: { code: "caller_concurrency" } });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.action, "wait_same");
});

test("NaN status is treated as absent and classified unknown", () => {
  const signal = classifyBackpressure({ status: Number.NaN, body: { code: "capacity_unavailable" } });
  assert.equal(signal.kind, "unknown");
  assert.equal(signal.action, "none");
});

test("Retry-After header lookup is case-insensitive on a plain object", () => {
  const signal = classifyBackpressure({
    status: 429,
    headers: { "RETRY-AFTER": "5" },
    body: { code: "caller_queue_full" },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, 5000);
});

test("Retry-After header lookup works on a Headers instance", () => {
  const signal = classifyBackpressure({
    status: 429,
    headers: new Headers({ "Retry-After": "5" }),
    body: { code: "caller_queue_full" },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, 5000);
});

test("MAX_WAIT_MS is exported as 600000", () => {
  assert.equal(MAX_WAIT_MS, 600000);
});

test("body retry_after_ms '' yields waitMs null, not 0", () => {
  const signal = classifyBackpressure({ status: 429, body: { code: "caller_concurrency", retry_after_ms: "" } });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, null);
});

test("body retry_after_ms -5 yields waitMs null", () => {
  const signal = classifyBackpressure({ status: 429, body: { code: "caller_concurrency", retry_after_ms: -5 } });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, null);
});

test("Retry-After header 'abc' yields waitMs null", () => {
  const signal = classifyBackpressure({
    status: 429,
    headers: { "Retry-After": "abc" },
    body: { code: "caller_queue_full" },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, null);
});

test("Retry-After header HTTP date one minute in the past yields waitMs 0", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const signal = classifyBackpressure({
    status: 429,
    headers: { "Retry-After": past },
    body: { code: "caller_queue_full" },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, 0);
});

test("retry_after_ms 99999999999 is capped at MAX_WAIT_MS", () => {
  const signal = classifyBackpressure({
    status: 429,
    body: { code: "caller_concurrency", retry_after_ms: 99999999999 },
  });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.waitMs, 600000);
});

test("real observed sample: 429 capacity_unavailable with retry_alternate", () => {
  const signal = classifyBackpressure({
    status: 429,
    body: {
      reason: "capacity_unavailable",
      retryAfterMs: 20000,
      retryable: true,
      action: "retry_alternate",
      replaySafe: true,
    },
  });
  assert.equal(signal.kind, "capacity");
  assert.equal(signal.action, "retry_alternate");
  assert.equal(signal.reason, "capacity_unavailable");
  assert.equal(signal.waitMs, 20000);
  assert.equal(signal.replaySafe, true);
});

test("429 with null headers does not throw and classifies like a bare 429", () => {
  const signal = classifyBackpressure({ status: 429, headers: null });
  assert.equal(signal.kind, "quota");
  assert.equal(signal.action, "wait_same");
  assert.equal(signal.reason, "unknown");
  assert.equal(signal.waitMs, null);
});
