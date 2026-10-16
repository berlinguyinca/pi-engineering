/**
 * Bounded, targeted retry policy (issue #307, CI-005): a pure decision function
 * that says whether a failed stage may be retried and, if so, which tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type RetryFailureClass,
  type TargetedRetryInput,
  decideTargetedRetry,
} from "../../src/verify/targetedRetry.ts";

function input(over: Partial<TargetedRetryInput>): TargetedRetryInput {
  return {
    stage: "unit",
    required: true,
    attempt: 1,
    maxAttempts: 2,
    failureClass: "assertion",
    failingTests: ["b", "a"],
    quarantined: [],
    ...over,
  };
}

test("targeted retry: attempt 1 of 2 assertion retries de-duplicated sorted failing tests", () => {
  const decision = decideTargetedRetry(input({ failingTests: ["b", "a", "b"] }));
  assert.equal(decision.action, "retry");
  assert.deepEqual(decision.retryTests, ["a", "b"]);
  assert.deepEqual(decision.reasons, ["assertion failure; retry failing tests once to confirm"]);
});

test("targeted retry: attempt 2 of 2 fails with retry budget exhausted", () => {
  const decision = decideTargetedRetry(input({ attempt: 2 }));
  assert.equal(decision.action, "fail");
  assert.deepEqual(decision.retryTests, []);
  assert.deepEqual(decision.reasons, ["retry budget exhausted"]);
});

test("targeted retry: quarantined failing test wins over the budget and fails", () => {
  const decision = decideTargetedRetry(input({ attempt: 2, failingTests: ["q"], quarantined: ["q"] }));
  assert.equal(decision.action, "fail");
  assert.deepEqual(decision.retryTests, []);
  assert.deepEqual(decision.reasons, ["quarantined test blocks retry"]);
});

test("targeted retry: stalled stage is not retried", () => {
  const decision = decideTargetedRetry(input({ failureClass: "stall" }));
  assert.equal(decision.action, "fail");
  assert.deepEqual(decision.retryTests, []);
  assert.deepEqual(decision.reasons, ["stalled stage is not retried"]);
});

test("targeted retry: maxAttempts 0 fails with invalid attempt bounds", () => {
  const decision = decideTargetedRetry(input({ maxAttempts: 0 }));
  assert.equal(decision.action, "fail");
  assert.deepEqual(decision.reasons, ["invalid attempt bounds"]);
});

test("targeted retry: non-integer attempt fails with invalid attempt bounds", () => {
  const decision = decideTargetedRetry(input({ attempt: 1.5 }));
  assert.equal(decision.action, "fail");
  assert.deepEqual(decision.reasons, ["invalid attempt bounds"]);
});

test("targeted retry: no failing test names escalates to full stage", () => {
  const decision = decideTargetedRetry(input({ failingTests: [] }));
  assert.equal(decision.action, "escalate_full");
  assert.deepEqual(decision.retryTests, []);
  assert.deepEqual(decision.reasons, ["no failing test names; escalate to full stage"]);
});

test("targeted retry: more than MAX_TARGETED_TESTS escalates to full stage", () => {
  const failingTests = Array.from({ length: 21 }, (_, i) => `t${i}`);
  const decision = decideTargetedRetry(input({ failingTests }));
  assert.equal(decision.action, "escalate_full");
  assert.deepEqual(decision.retryTests, []);
  assert.deepEqual(decision.reasons, ["too many failing tests for targeted retry"]);
});

test("targeted retry: infra failure retries with the infra reason", () => {
  const decision = decideTargetedRetry(input({ failureClass: "infra", failingTests: ["only"] }));
  assert.equal(decision.action, "retry");
  assert.deepEqual(decision.retryTests, ["only"]);
  assert.deepEqual(decision.reasons, ["infra failure; retry failing tests"]);
});

test("targeted retry: unknown failure class escalates to full stage", () => {
  const decision = decideTargetedRetry(input({ failureClass: "unknown" }));
  assert.equal(decision.action, "escalate_full");
  assert.deepEqual(decision.retryTests, []);
  assert.deepEqual(decision.reasons, ["unknown failure class; escalate to full stage"]);
});

test("targeted retry: required false gives the same decision as required true", () => {
  const required = decideTargetedRetry(input({}));
  const optional = decideTargetedRetry(input({ required: false }));
  assert.deepEqual(optional, required);
});

test("targeted retry: frozen inputs are not mutated and reasons always has exactly one entry", () => {
  const failureClasses: RetryFailureClass[] = ["assertion", "stall", "infra", "unknown"];
  for (const failureClass of failureClasses) {
    const frozen = input({ failureClass });
    assert.equal(Object.isFrozen(frozen), false);
    const frozenFailingTests = Object.freeze([...frozen.failingTests]);
    const frozenQuarantined = Object.freeze([...frozen.quarantined]);
    const frozenInput = Object.freeze({ ...frozen, failingTests: frozenFailingTests, quarantined: frozenQuarantined });
    const beforeFailing = [...frozenFailingTests];
    const beforeQuarantined = [...frozenQuarantined];
    const decision = decideTargetedRetry(frozenInput);
    assert.deepEqual([...frozenFailingTests], beforeFailing);
    assert.deepEqual([...frozenQuarantined], beforeQuarantined);
    assert.equal(decision.reasons.length, 1);
  }

  // Also confirm the non-frozen default input is never mutated by a retry.
  const defaultInput = input({ failingTests: ["c", "b", "a", "b"] });
  const snapshot = [...defaultInput.failingTests];
  decideTargetedRetry(defaultInput);
  assert.deepEqual([...defaultInput.failingTests], snapshot);
});
