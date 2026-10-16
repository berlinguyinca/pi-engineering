import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBackpressure } from "../../src/gateway/backpressureSignal.ts";

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
