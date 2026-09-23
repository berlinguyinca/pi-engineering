import assert from "node:assert";
import { test } from "node:test";
import { DEFAULT_ADMISSION_RETRY_CONFIG, normalizeAdmissionConfig } from "../../src/inference/admissionConfig.ts";
import { AdmissionEventBus, AdmissionMetrics } from "../../src/inference/admissionEvents.ts";
import { type RetryDelayBounds, parseRetryAfterMsHeader, resolveRetryDelay } from "../../src/inference/retryDelay.ts";

test("retry delay: retry-after-ms header wins over body and backoff", () => {
  const bounds: RetryDelayBounds = {
    baseBackoffMs: 1000,
    minDelayMs: 0,
    maxDelayMs: 60_000,
    jitterRatio: 0,
  };
  const d = resolveRetryDelay({
    headers: { "retry-after-ms": "1500" },
    body: { retry_after_ms: 500 },
    attempt: 1,
    bounds,
    random: () => 0,
  });
  assert.equal(d.delayMs, 1500);
  assert.equal(d.source, "retry-after-ms");
});

test("retry delay: header beats body; absent header falls back to body then backoff", () => {
  const bounds: RetryDelayBounds = {
    baseBackoffMs: 1000,
    minDelayMs: 0,
    maxDelayMs: 60_000,
    jitterRatio: 0,
  };
  const body = resolveRetryDelay({
    body: { retry_after_ms: 4000 },
    attempt: 1,
    bounds,
    random: () => 0,
  });
  assert.equal(body.delayMs, 4000);
  assert.equal(body.source, "body");
  const backoff = resolveRetryDelay({ attempt: 2, bounds, random: () => 0 });
  assert.equal(backoff.delayMs, 2000); // exponential: 1000 * 2^(2-1)
  assert.equal(backoff.source, "backoff");
});

test("retry delay: a server minimum is not clamped downward", () => {
  const bounds: RetryDelayBounds = {
    baseBackoffMs: 1000,
    minDelayMs: 1000,
    maxDelayMs: 5000,
    jitterRatio: 0,
  };
  const d = resolveRetryDelay({ headers: { "retry-after-ms": "9000" }, attempt: 1, bounds, random: () => 0 });
  assert.equal(d.delayMs, 9000);
  assert.equal(d.clamped, undefined);
});

test("parseRetryAfterMsHeader: bare seconds, numeric, and invalid inputs", () => {
  assert.equal(parseRetryAfterMsHeader("30"), 30);
  assert.equal(parseRetryAfterMsHeader("abc"), undefined);
  assert.equal(parseRetryAfterMsHeader(undefined), undefined);
});

test("admission config: normalize fills defaults and passes through set values", () => {
  const cfg = normalizeAdmissionConfig({ max_attempts: 7 });
  assert.equal(cfg.max_attempts, 7);
  assert.equal(cfg.max_elapsed_ms, DEFAULT_ADMISSION_RETRY_CONFIG.max_elapsed_ms);
  assert.equal(cfg.enabled, DEFAULT_ADMISSION_RETRY_CONFIG.enabled);
});

test("admission event bus: publish + subscribe fan out and dedupe", () => {
  const bus = new AdmissionEventBus();
  const seen: string[] = [];
  const unsub = bus.subscribe((e) => seen.push(e.name));
  bus.publish("inference.retry.scheduled", { sessionId: "s", role: "implementer" } as never);
  bus.publish("inference.retry.waiting", { sessionId: "s", role: "implementer" } as never);
  unsub();
  bus.publish("inference.retry.started", { sessionId: "s", role: "implementer" } as never);
  assert.deepEqual(seen, ["inference.retry.scheduled", "inference.retry.waiting"]);
});

test("admission metrics: records retries and reasons", () => {
  const m = new AdmissionMetrics();
  m.record({
    name: "inference.retry.scheduled",
    reason: "queue_timeout",
    delayUsedMs: 30_000,
    sessionId: "s",
    role: "implementer",
  } as never);
  m.record({ name: "inference.retry.started", attempt: 2, sessionId: "s", role: "implementer" } as never);
  const snap = m.snapshot();
  assert.equal(snap.retries, 1);
  assert.equal(snap.waitMs, 30_000);
  assert.equal(snap.byReason.length, 1);
  assert.equal(snap.byReason[0]!.reason, "queue_timeout");
});
