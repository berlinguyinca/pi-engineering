/**
 * Retry-delay resolution (spec 02 §2).
 *
 * The largest valid header/body server minimum wins. Local backoff is bounded,
 * and positive jitter never shortens a server minimum.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBoundedJitter,
  bodyRetryAfterMs,
  clampDelay,
  decideWait,
  exponentialBackoffMs,
  parseRetryAfterHeader,
  parseRetryAfterMsHeader,
  resolveRetryDelay,
} from "../../src/inference/retryDelay.ts";

const BOUNDS = {
  minDelayMs: 500,
  maxDelayMs: 120_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 120_000,
  jitterRatio: 0,
  honorRetryAfter: true,
};

test("the largest valid server delay wins across headers and body", () => {
  const r = resolveRetryDelay({
    headers: { "retry-after-ms": "4000", "retry-after": "2" },
    body: { retry_after_ms: 9000 },
    attempt: 1,
    bounds: BOUNDS,
    random: () => 0,
  });
  assert.equal(r.source, "body");
  assert.equal(r.delayMs, 9000);
  assert.equal(r.serverDelayMs, 9000);
});

test("Retry-After delta-seconds wins only when it is the largest server minimum", () => {
  const r = resolveRetryDelay({
    headers: { "retry-after": "7" },
    body: { retry_after_ms: 9000 },
    attempt: 1,
    bounds: BOUNDS,
    random: () => 0,
  });
  assert.equal(r.source, "body");
  assert.equal(r.delayMs, 9000);
});

test("Retry-After HTTP date resolves relative to now", () => {
  const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const future = new Date(nowMs + 15_000).toUTCString();
  const r = resolveRetryDelay({
    headers: { "retry-after": future },
    attempt: 1,
    bounds: BOUNDS,
    nowMs,
    random: () => 0,
  });
  assert.equal(r.source, "retry-after-date");
  assert.equal(r.delayMs, 15_000);
});

test("body retry_after_ms is used when no header is present", () => {
  const r = resolveRetryDelay({
    body: { type: "inference_admission", reason: "queue_timeout", retry_after_ms: 30_000 },
    attempt: 1,
    bounds: BOUNDS,
    random: () => 0,
  });
  assert.equal(r.source, "body");
  assert.equal(r.delayMs, 30_000);
});

test("falls back to exponential backoff when no server delay is supplied", () => {
  const r1 = resolveRetryDelay({ attempt: 1, bounds: BOUNDS, random: () => 0 });
  const r2 = resolveRetryDelay({ attempt: 2, bounds: BOUNDS, random: () => 0 });
  const r3 = resolveRetryDelay({ attempt: 3, bounds: BOUNDS, random: () => 0 });
  assert.equal(r1.source, "backoff");
  assert.equal(r1.delayMs, 2_000);
  assert.equal(r2.delayMs, 4_000);
  assert.equal(r3.delayMs, 8_000);
});

test("honorRetryAfter:false ignores server hints and uses backoff", () => {
  const r = resolveRetryDelay({
    headers: { "retry-after-ms": "4000" },
    body: { retry_after_ms: 9000 },
    attempt: 2,
    bounds: { ...BOUNDS, honorRetryAfter: false },
    random: () => 0,
  });
  assert.equal(r.source, "backoff");
  assert.equal(r.delayMs, 4_000);
});

test("server minimum is never clamped downward", () => {
  const r = resolveRetryDelay({
    headers: { "retry-after-ms": "10000000" }, // 2.7 hours
    attempt: 1,
    bounds: BOUNDS,
    random: () => 0,
  });
  assert.equal(r.delayMs, 10_000_000);
  assert.equal(r.clamped, undefined);
  assert.equal(r.serverDelayMs, 10_000_000);

  const low = resolveRetryDelay({
    headers: { "retry-after-ms": "1" }, // below min
    attempt: 1,
    bounds: BOUNDS,
    random: () => 0,
  });
  assert.equal(low.delayMs, 500);
});

test("a server minimum that does not fit the remaining elapsed budget stops", () => {
  assert.deepEqual(decideWait({ serverMinimumMs: 8_000, proposedMs: 8_000, remainingMs: 7_000 }), {
    action: "stop",
    reason: "budget_elapsed",
  });
  assert.deepEqual(decideWait({ serverMinimumMs: 8_000, proposedMs: 8_500, remainingMs: 9_000 }), {
    action: "wait",
    waitMs: 8_500,
  });
});

test("positive-only jitter never shortens a server wait", () => {
  const bounds = { ...BOUNDS, jitterRatio: 0.5 };
  const r = resolveRetryDelay({
    headers: { "retry-after-ms": "10000" },
    attempt: 1,
    bounds,
    random: () => 0, // minimum jitter
  });
  assert.ok(r.delayMs >= 10_000);
  const max = resolveRetryDelay({
    headers: { "retry-after-ms": "10000" },
    attempt: 1,
    bounds,
    random: () => 1, // maximum jitter
  });
  assert.ok(max.delayMs <= 15_000);
});

test("parseRetryAfterMsHeader accepts digits and rejects junk", () => {
  assert.equal(parseRetryAfterMsHeader("30000"), 30000);
  assert.equal(parseRetryAfterMsHeader("0"), 0);
  assert.equal(parseRetryAfterMsHeader(" 120 "), 120);
  assert.equal(parseRetryAfterMsHeader("12.5"), undefined);
  assert.equal(parseRetryAfterMsHeader("-5"), undefined);
  assert.equal(parseRetryAfterMsHeader("abc"), undefined);
  assert.equal(parseRetryAfterMsHeader(undefined), undefined);
  assert.equal(parseRetryAfterMsHeader(""), undefined);
});

test("parseRetryAfterHeader handles delta-seconds and HTTP dates", () => {
  const nowMs = 1_000_000;
  assert.equal(parseRetryAfterHeader("30", nowMs), 30_000);
  const future = new Date(nowMs + 60_000).toUTCString();
  assert.equal(parseRetryAfterHeader(future, nowMs), 60_000);
  // An HTTP date in the past means "retry now".
  const past = new Date(nowMs - 10_000).toUTCString();
  assert.equal(parseRetryAfterHeader(past, nowMs), 0);
  assert.equal(parseRetryAfterHeader("garbage", nowMs), undefined);
  assert.equal(parseRetryAfterHeader(undefined, nowMs), undefined);
});

test("bodyRetryAfterMs reads the snake_case and camelCase field", () => {
  assert.equal(bodyRetryAfterMs({ retry_after_ms: 5000 }), 5000);
  assert.equal(bodyRetryAfterMs({ retryAfterMs: 6000 }), 6000);
  assert.equal(bodyRetryAfterMs({ retry_after_ms: "7000" }), 7000);
  assert.equal(bodyRetryAfterMs({ retry_after_ms: -1 }), undefined);
  assert.equal(bodyRetryAfterMs({}), undefined);
  assert.equal(bodyRetryAfterMs(null), undefined);
});

test("exponentialBackoffMs doubles per attempt and caps", () => {
  assert.equal(exponentialBackoffMs(1, 2000, 120000), 2000);
  assert.equal(exponentialBackoffMs(2, 2000, 120000), 4000);
  assert.equal(exponentialBackoffMs(3, 2000, 120000), 8000);
  assert.equal(exponentialBackoffMs(10, 2000, 5000), 5000);
});

test("clampDelay tolerates inverted bounds defensively", () => {
  assert.equal(clampDelay(1000, 500, 120000), 1000);
  assert.equal(clampDelay(10, 500, 120000), 500);
  assert.equal(clampDelay(999999, 500, 120000), 120000);
  assert.equal(clampDelay(500, 120000, 500), 500); // inverted min/max
});

test("addBoundedJitter returns the base delay when ratio is zero", () => {
  assert.equal(
    addBoundedJitter(10_000, 0, () => 1),
    10_000,
  );
  assert.equal(
    addBoundedJitter(10_000, 0.1, () => 0.5),
    10_500,
  );
  assert.equal(
    addBoundedJitter(10_000, 0.1, () => 0),
    10_000,
  );
  assert.equal(
    addBoundedJitter(10_000, 0.1, () => 1),
    11_000,
  );
});
