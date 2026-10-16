import assert from "node:assert/strict";
import { test } from "node:test";
import { type QuotaResumeInput, decideQuotaResume } from "../../src/runtime/host/quotaResume.ts";

function input(over: Partial<QuotaResumeInput> = {}): QuotaResumeInput {
  return {
    failureClass: "quota",
    currentModelId: "m-a",
    catalogue: [
      { id: "m-a", eligible: true },
      { id: "m-b", eligible: true },
    ],
    nowMs: 1_000_000,
    pausedAtMs: null,
    maxPauseMs: 3_600_000,
    sideEffects: [],
    hasCheckpoint: true,
    ...over,
  };
}

test("quota resume: non-quota/availability failures fail fast", () => {
  const d = decideQuotaResume(input({ failureClass: "invalid_request" }));
  assert.equal(d.action, "fail");
  assert.equal(d.handoffKind, null);
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["not a quota or availability failure"]);
});

test("quota resume: billing refusal is not resumable", () => {
  const d = decideQuotaResume(input({ failureClass: "billing" }));
  assert.equal(d.action, "fail");
  assert.equal(d.handoffKind, null);
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["billing refusal is not resumable"]);
});

test("quota resume: pause window exceeded fails", () => {
  const d = decideQuotaResume(input({ pausedAtMs: 0, nowMs: 4_000_000, maxPauseMs: 3_600_000 }));
  assert.equal(d.action, "fail");
  assert.equal(d.handoffKind, null);
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["pause window exceeded"]);
});

test("quota resume: no checkpoint to resume from fails", () => {
  const d = decideQuotaResume(input({ hasCheckpoint: false }));
  assert.equal(d.action, "fail");
  assert.equal(d.handoffKind, null);
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["no checkpoint to resume from"]);
});

test("quota resume: vanished model switches to eligible alternate", () => {
  const d = decideQuotaResume(input({ failureClass: "model_not_found" }));
  assert.equal(d.action, "switch_model");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, "m-b");
  assert.deepEqual(d.reasons, ["model absent from catalogue; switching to alternate"]);
});

test("quota resume: unavailable model with no alternate pauses", () => {
  const d = decideQuotaResume(
    input({
      failureClass: "model_unavailable",
      catalogue: [{ id: "m-a", eligible: true }],
    }),
  );
  assert.equal(d.action, "pause");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["model absent and no eligible alternate"]);
});

test("quota resume: quota with all effects committed switches model", () => {
  const d = decideQuotaResume(
    input({
      failureClass: "quota",
      sideEffects: [
        { id: "push-1", kind: "push", committed: true },
        { id: "comment-1", kind: "comment", committed: true },
      ],
    }),
  );
  assert.equal(d.action, "switch_model");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, "m-b");
  assert.deepEqual(d.reasons, ["quota exhausted; switching to eligible alternate"]);
});

test("quota resume: uncommitted side effects block model switch", () => {
  const d = decideQuotaResume(
    input({
      failureClass: "quota",
      sideEffects: [{ id: "push-1", kind: "push", committed: false }],
    }),
  );
  assert.equal(d.action, "pause");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["uncommitted side effects block model switch"]);
});

test("quota resume: quota with no eligible alternate pauses", () => {
  const d = decideQuotaResume(
    input({
      failureClass: "quota",
      catalogue: [
        { id: "m-a", eligible: true },
        { id: "m-b", eligible: false },
      ],
    }),
  );
  assert.equal(d.action, "pause");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["quota exhausted and no eligible alternate"]);
});

test("quota resume: short capacity wait on same model", () => {
  const d = decideQuotaResume(input({ failureClass: "capacity_unavailable", retryAfterMs: 5_000 }));
  assert.equal(d.action, "wait");
  assert.equal(d.handoffKind, null);
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["short capacity wait on same model"]);
});

test("quota resume: long capacity wait pauses for recovery", () => {
  const d = decideQuotaResume(input({ failureClass: "capacity_unavailable", retryAfterMs: 120_000 }));
  assert.equal(d.action, "pause");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["capacity unavailable; pausing for later resume"]);
});

test("quota resume: rate limited without retryAfterMs pauses", () => {
  const d = decideQuotaResume(input({ failureClass: "rate_limited" }));
  assert.equal(d.action, "pause");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, null);
  assert.deepEqual(d.reasons, ["capacity unavailable; pausing for later resume"]);
});

test("quota resume: current model not in catalogue switches via rule 5", () => {
  const d = decideQuotaResume(
    input({
      failureClass: "quota",
      currentModelId: "m-ghost",
      catalogue: [{ id: "m-b", eligible: true }],
    }),
  );
  assert.equal(d.action, "switch_model");
  assert.equal(d.handoffKind, "recovery");
  assert.equal(d.alternateModelId, "m-b");
  assert.deepEqual(d.reasons, ["model absent from catalogue; switching to alternate"]);
});

test("quota resume: frozen input not mutated and two calls deep-equal", () => {
  const frozen = Object.freeze({
    failureClass: "quota",
    currentModelId: "m-a",
    catalogue: Object.freeze([
      Object.freeze({ id: "m-a", eligible: true }),
      Object.freeze({ id: "m-b", eligible: true }),
    ]),
    nowMs: 1_000_000,
    pausedAtMs: null,
    maxPauseMs: 3_600_000,
    sideEffects: Object.freeze([Object.freeze({ id: "push-1", kind: "push", committed: false })]),
    hasCheckpoint: true,
  }) as QuotaResumeInput;

  const d1 = decideQuotaResume(frozen);
  const d2 = decideQuotaResume(frozen);
  assert.deepEqual(d1, d2);
  assert.deepEqual(frozen.catalogue[1], { id: "m-b", eligible: true });
  assert.deepEqual(frozen.sideEffects[0], { id: "push-1", kind: "push", committed: false });
});

test("quota resume: every decision carries exactly one reason", () => {
  const cases: QuotaResumeInput[] = [
    input({ failureClass: "invalid_request" }),
    input({ failureClass: "billing" }),
    input({ pausedAtMs: 0, nowMs: 4_000_000 }),
    input({ hasCheckpoint: false }),
    input({ failureClass: "model_not_found" }),
    input({ failureClass: "model_unavailable", catalogue: [{ id: "m-a", eligible: true }] }),
    input({ failureClass: "quota", sideEffects: [{ id: "push-1", kind: "push", committed: false }] }),
    input({
      failureClass: "quota",
      catalogue: [
        { id: "m-a", eligible: true },
        { id: "m-b", eligible: false },
      ],
    }),
    input({ failureClass: "capacity_unavailable", retryAfterMs: 5_000 }),
    input({ failureClass: "capacity_unavailable", retryAfterMs: 120_000 }),
    input({ failureClass: "rate_limited" }),
    input({ failureClass: "no_workers", retryAfterMs: 5_000 }),
    input({ failureClass: "queue_saturated", retryAfterMs: 120_000 }),
    input({ failureClass: "unknown" }),
  ];
  for (const c of cases) {
    const d = decideQuotaResume(c);
    assert.equal(d.reasons.length, 1, `expected one reason for ${c.failureClass}`);
    assert.equal(typeof d.reasons[0], "string");
  }
});
