import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandoffResumeInput, HandoffSideEffect } from "../../src/runtime/host/handoffResume.ts";
import { decideHandoffResume } from "../../src/runtime/host/handoffResume.ts";

/** Small builder for a side effect. */
function effect(kind: HandoffSideEffect["kind"], committed: boolean): HandoffSideEffect {
  return { kind, committed };
}

const NOW_MS = 1_700_000_000_000;
const RECENT_AT = new Date(NOW_MS - 1_000).toISOString(); // 1s old
const TOO_OLD_AT = new Date(NOW_MS - 100_000).toISOString(); // 100s old
const SHA = "abc1234";

function input(over: Partial<HandoffResumeInput> = {}): HandoffResumeInput {
  return {
    state: "acknowledged",
    leaseGeneration: 2,
    successorGeneration: 2,
    leaseCheckpointSha: SHA,
    recordCheckpointSha: SHA,
    sourceSessionId: "sess-A",
    resumingSessionId: "sess-A",
    sideEffects: [effect("checkpoint", true)],
    createdAt: RECENT_AT,
    maxAgeMs: 10_000,
    nowMs: NOW_MS,
    ...over,
  };
}

test("handoff resume: happy path resumes", () => {
  const decision = decideHandoffResume(input());
  assert.equal(decision.decision, "resume");
  assert.deepEqual(decision.reasons, []);
});

test("handoff resume: aborted handoff refuses", () => {
  const decision = decideHandoffResume(input({ state: "aborted" }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["handoff aborted"]);
});

test("handoff resume: prepared handoff refuses with state in reason", () => {
  const decision = decideHandoffResume(input({ state: "prepared" }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["handoff not prepared for resume"]);
});

test("handoff resume: stale generation refuses", () => {
  const decision = decideHandoffResume(input({ leaseGeneration: 5, successorGeneration: 1 }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["stale generation (lease 5, successor 1)"]);
});

test("handoff resume: checkpoint mismatch refuses", () => {
  const decision = decideHandoffResume(input({ leaseCheckpointSha: "fffffff", recordCheckpointSha: SHA }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["checkpoint mismatch"]);
});

test("handoff resume: source mismatch refuses", () => {
  const decision = decideHandoffResume(input({ sourceSessionId: "sess-A", resumingSessionId: "sess-B" }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["source session mismatch"]);
});

test("handoff resume: uncommitted push-1 side effect refuses", () => {
  const decision = decideHandoffResume(input({ sideEffects: [effect("checkpoint", true), effect("push-1", false)] }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["uncommitted side effect push-1"]);
});

test("handoff resume: committed side effects do not block", () => {
  const decision = decideHandoffResume(
    input({ sideEffects: [effect("checkpoint", true), effect("push-1", true), effect("merge", true)] }),
  );
  assert.equal(decision.decision, "resume");
  assert.deepEqual(decision.reasons, []);
});

test("handoff resume: missing checkpoint restart_fresh with 'no checkpoint'", () => {
  const decision = decideHandoffResume(input({ recordCheckpointSha: undefined }));
  assert.equal(decision.decision, "restart_fresh");
  assert.deepEqual(decision.reasons, ["no checkpoint"]);
});

test("handoff resume: too old restart_fresh", () => {
  const decision = decideHandoffResume(input({ createdAt: TOO_OLD_AT }));
  assert.equal(decision.decision, "restart_fresh");
  assert.deepEqual(decision.reasons, ["handoff older than maxAgeMs"]);
});

test("handoff resume: unparseable createdAt treated as too old", () => {
  const decision = decideHandoffResume(input({ createdAt: "not-a-timestamp" }));
  assert.equal(decision.decision, "restart_fresh");
  assert.deepEqual(decision.reasons, ["handoff older than maxAgeMs"]);
});

test("handoff resume: refuse beats restart_fresh and collects both reasons", () => {
  const decision = decideHandoffResume(input({ state: "aborted", recordCheckpointSha: undefined }));
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, ["handoff aborted", "no checkpoint"]);
});

test("handoff resume: refuses collect every applicable reason in order", () => {
  const decision = decideHandoffResume(
    input({
      state: "prepared",
      leaseGeneration: 5,
      successorGeneration: 1,
      leaseCheckpointSha: "fffffff",
      recordCheckpointSha: SHA,
      sourceSessionId: "sess-A",
      resumingSessionId: "sess-B",
      sideEffects: [effect("push-1", false)],
      createdAt: TOO_OLD_AT,
    }),
  );
  assert.equal(decision.decision, "refuse");
  assert.deepEqual(decision.reasons, [
    "handoff not prepared for resume",
    "stale generation (lease 5, successor 1)",
    "checkpoint mismatch",
    "source session mismatch",
    "uncommitted side effect push-1",
    "handoff older than maxAgeMs",
  ]);
});

test("handoff resume: missing fields fail relevant checks without throwing", () => {
  const empty = decideHandoffResume({ nowMs: NOW_MS });
  assert.equal(empty.decision, "restart_fresh");
  assert.deepEqual(empty.reasons, ["no checkpoint"]);
});

test("handoff resume: does not mutate the input", () => {
  const before: HandoffResumeInput = input();
  const snapshot = structuredClone(before);
  decideHandoffResume(before);
  assert.deepEqual(before, snapshot);
});
