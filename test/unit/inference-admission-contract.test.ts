/**
 * InferWeave admission contract parsing (spec 01).
 *
 * Classification is STRUCTURAL: a response is an admission response only when
 * its body carries `type: "inference_admission"` (top-level or nested under
 * `error` / `detail` / `detail.error`). A bare HTTP 429 from a non-InferWeave
 * provider is never admission, and HTTP status outranks the reason token.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMISSION_STATUSES,
  AdmissionFailure,
  DEFAULT_ADMISSION_REASON_POLICY,
  FALLBACK_ADMISSION_REASONS,
  PERMANENT_ADMISSION_STATUSES,
  RETRYABLE_ADMISSION_REASONS,
  admissionFromResponse,
  formatAdmissionFailure,
  formatDuration,
  isAdmissionRetryStatus,
  mayCarryAdmission,
  parseAdmissionPayload,
  serverRequestIdFromHeaders,
} from "../../src/inference/admissionContract.ts";

const PAYLOAD = {
  type: "inference_admission",
  reason: "queue_timeout",
  retry_after_ms: 30_000,
  active: 4,
  active_limit: 4,
  queued: 26,
  queue_limit: 100,
  request_id: "iw-123",
};

test("parses a top-level admission payload structurally", () => {
  const info = parseAdmissionPayload(PAYLOAD);
  assert.ok(info);
  assert.equal(info.reason, "queue_timeout");
  assert.equal(info.retryAfterMs, 30_000);
  assert.equal(info.active, 4);
  assert.equal(info.activeLimit, 4);
  assert.equal(info.queued, 26);
  assert.equal(info.queueLimit, 100);
  assert.equal(info.requestId, "iw-123");
});

test("accepts the payload nested under error / detail / detail.error", () => {
  for (const wrap of [
    { error: PAYLOAD },
    { detail: PAYLOAD },
    { detail: { error: PAYLOAD } },
    { error: { error: PAYLOAD } },
  ]) {
    const info = parseAdmissionPayload(wrap);
    assert.ok(info, `expected to parse ${JSON.stringify(Object.keys(wrap))}`);
    assert.equal(info.reason, "queue_timeout");
  }
});

test("parses a JSON string body", () => {
  const info = parseAdmissionPayload(JSON.stringify(PAYLOAD));
  assert.ok(info);
  assert.equal(info.retryAfterMs, 30_000);
});

test("rejects a bare provider-shaped 429 body (no admission type tag)", () => {
  const body = { error: { message: "rate limited", type: "rate_limit_exceeded" } };
  assert.equal(parseAdmissionPayload(body), undefined);
});

test("rejects non-admission shapes: arrays, primitives, malformed JSON, empty string", () => {
  assert.equal(parseAdmissionPayload([PAYLOAD]), undefined);
  assert.equal(parseAdmissionPayload(42), undefined);
  assert.equal(parseAdmissionPayload("not json {"), undefined);
  assert.equal(parseAdmissionPayload("   "), undefined);
  assert.equal(parseAdmissionPayload({ reason: "queue_timeout" }), undefined); // no type marker
});

test("defaults a missing reason to 'unknown'", () => {
  const info = parseAdmissionPayload({ type: "inference_admission", retry_after_ms: 1000 });
  assert.ok(info);
  assert.equal(info.reason, "unknown");
});

test("accepts camelCase and snake_case field shapes", () => {
  const camel = parseAdmissionPayload({
    type: "inference_admission",
    reason: "queue_timeout",
    retryAfterMs: 5000,
    activeLimit: 2,
    queueLimit: 10,
    requestId: "iw-camel",
  });
  assert.ok(camel);
  assert.equal(camel.retryAfterMs, 5000);
  assert.equal(camel.activeLimit, 2);
  assert.equal(camel.queueLimit, 10);
  assert.equal(camel.requestId, "iw-camel");
});

test("ignores invalid numeric fields (negative, NaN, strings that are not numbers)", () => {
  const info = parseAdmissionPayload({
    type: "inference_admission",
    reason: "queue_timeout",
    retry_after_ms: -5,
    active: Number.NaN,
    queued: "not-a-number",
  });
  assert.ok(info);
  assert.equal(info.retryAfterMs, undefined);
  assert.equal(info.active, undefined);
  assert.equal(info.queued, undefined);
});

test("mayCarryAdmission gates the 4xx-5xx range", () => {
  assert.ok(mayCarryAdmission(429));
  assert.ok(mayCarryAdmission(503));
  assert.ok(mayCarryAdmission(400));
  assert.ok(mayCarryAdmission(599));
  assert.ok(!mayCarryAdmission(200));
  assert.ok(!mayCarryAdmission(399));
});

test("isAdmissionRetryStatus is 429/503 only", () => {
  assert.ok(isAdmissionRetryStatus(429));
  assert.ok(isAdmissionRetryStatus(503));
  assert.ok(!isAdmissionRetryStatus(500));
  assert.ok(!isAdmissionRetryStatus(401));
  assert.ok(ADMISSION_STATUSES.includes(429));
  assert.ok(ADMISSION_STATUSES.includes(503));
});

test("permanent statuses never wait regardless of reason token", () => {
  assert.deepEqual([...PERMANENT_ADMISSION_STATUSES].sort(), [400, 401, 403, 404, 422]);
  for (const s of PERMANENT_ADMISSION_STATUSES) assert.ok(mayCarryAdmission(s));
});

test("reason taxonomy groups retryable / fallback reasons", () => {
  for (const r of RETRYABLE_ADMISSION_REASONS) {
    assert.equal(DEFAULT_ADMISSION_REASON_POLICY[r]!.action, "retry", r);
  }
  for (const r of FALLBACK_ADMISSION_REASONS) {
    assert.equal(DEFAULT_ADMISSION_REASON_POLICY[r]!.action, "fallback", r);
  }
  assert.equal(DEFAULT_ADMISSION_REASON_POLICY.auth_failed!.action, "fail");
  assert.equal(DEFAULT_ADMISSION_REASON_POLICY.forbidden!.action, "fail");
  assert.equal(DEFAULT_ADMISSION_REASON_POLICY.malformed_request!.action, "fail");
  assert.equal(DEFAULT_ADMISSION_REASON_POLICY.capacity_unavailable!.action, "retry_then_fallback");
});

test("admissionFromResponse requires a 4xx-5xx status and extracts request id from headers", () => {
  assert.equal(
    admissionFromResponse({ status: 200, body: PAYLOAD }),
    undefined,
    "a 200 cannot be an admission response",
  );
  const info = admissionFromResponse({
    status: 429,
    headers: { "x-inferweave-request-id": "iw-header-id" },
    body: { ...PAYLOAD, request_id: undefined },
  });
  assert.ok(info);
  assert.equal(info.requestId, "iw-header-id");
  // Body request id wins over a header request id.
  const withBody = admissionFromResponse({
    status: 429,
    headers: { "x-inferweave-request-id": "iw-header-id" },
    body: PAYLOAD,
  });
  assert.ok(withBody);
  assert.equal(withBody.requestId, "iw-123");
});

test("serverRequestIdFromHeaders follows preference order", () => {
  const get = (headers: Record<string, string> | undefined): string | undefined => serverRequestIdFromHeaders(headers);
  assert.equal(get({ "x-inferweave-request-id": "a" }), "a");
  assert.equal(get({ "x-request-id": "b" }), "b");
  assert.equal(get({ "x-amz-request-id": "c" }), "c");
  assert.equal(get({ "request-id": "d" }), "d");
  assert.equal(get({ "x-correlation-id": "e" }), "e");
  assert.equal(get({ "content-type": "application/json" }), undefined);
  assert.equal(get(undefined), undefined);
});

test("formatAdmissionFailure is canonical and carries the out-of-budget phrase", () => {
  const msg = formatAdmissionFailure({
    provider: "inferweave",
    modelId: "qwen",
    logicalRequestId: "lr-1",
    status: 429,
    reason: "queue_timeout",
    action: "retry",
    attempts: 4,
    elapsedMs: 120_000,
    lastDelayMs: 30_000,
    serverRequestId: "iw-123",
  });
  assert.match(msg, /queue_timeout/);
  assert.match(msg, /HTTP 429/);
  assert.match(msg, /attempts=4/);
  assert.match(msg, /waited=2m/);
  assert.match(msg, /request=iw-123/);
  assert.match(msg, /out of admission budget/);
  assert.match(msg, /inferweave\/qwen/);
});

test("AdmissionFailure retains its facts and name", () => {
  const err = new AdmissionFailure({
    provider: "inferweave",
    modelId: "qwen",
    logicalRequestId: "lr-1",
    status: 503,
    reason: "worker_saturated",
    action: "retry",
    attempts: 2,
    elapsedMs: 10_000,
  });
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AdmissionFailure");
  assert.equal(err.facts.reason, "worker_saturated");
  assert.equal(err.facts.status, 503);
  assert.match(err.message, /out of admission budget/);
});

test("formatDuration renders ms, seconds, and minutes", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-1), "0s");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(3_600_000), "60m");
  assert.equal(formatDuration(135_000), "2m15s");
});
