import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { type HandoffResumeInput, decideHandoffResume } from "../../src/runtime/host/handoffResume.ts";

const BASE_RECORD = {
  id: "handoff-1",
  kind: "context",
  state: "prepared",
  missionId: "MSN-abc123",
  predecessor: { sessionId: "sess-a", generation: 0 },
  createdAt: "2025-01-01T00:00:00.000Z",
} as const;

function baseRecord(): HandoffRecord {
  return { ...BASE_RECORD, kind: "context", state: "prepared" };
}

/** A fully-populated committed record ready to resume. */
function validRecord(): HandoffRecord {
  return {
    ...baseRecord(),
    state: "committed",
    successor: { sessionId: "sess-b", generation: 1 },
    checkpointSha: "0123456789abcdef",
    ackAt: "2025-01-01T00:00:01.000Z",
  };
}

const CREATED_MS = Date.parse("2025-01-01T00:00:00.000Z");

function input(overrides: Partial<HandoffResumeInput> = {}): HandoffResumeInput {
  return {
    record: validRecord(),
    currentLease: { generation: 1 },
    observedCheckpointSha: "0123456789abcdef",
    expectedSourceSha: "aaaabbbbccccdddd",
    observedSourceSha: "aaaabbbbccccdddd",
    sideEffects: [],
    nowMs: CREATED_MS + 60_000,
    maxAgeMs: 86_400_000,
    ...overrides,
  };
}

test("happy path resumes with no reasons", () => {
  const result = decideHandoffResume(input());
  assert.equal(result.decision, "resume");
  assert.deepEqual(result.reasons, []);
});

test("aborted handoff refuses", () => {
  const result = decideHandoffResume(input({ record: { ...validRecord(), state: "aborted" } }));
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("handoff aborted"));
});

test("prepared handoff refuses with the state in the reason", () => {
  const result = decideHandoffResume(input({ record: { ...validRecord(), state: "prepared" } }));
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("handoff not acknowledged (state prepared)"));
});

test("stale generation refuses", () => {
  // successor generation 1 < current lease generation 5
  const result = decideHandoffResume(input({ currentLease: { generation: 5 } }));
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("stale generation 1 < 5"));
});

test("checkpoint sha mismatch refuses", () => {
  const result = decideHandoffResume(input({ observedCheckpointSha: "ffffffffffffffff" }));
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("checkpoint sha mismatch"));
});

test("source sha mismatch refuses", () => {
  const result = decideHandoffResume(input({ observedSourceSha: "ffffffffffffffff" }));
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("source sha mismatch"));
});

test("uncommitted side effect refuses with its id in the reason", () => {
  const result = decideHandoffResume(input({ sideEffects: [{ id: "push-1", kind: "push", committed: false }] }));
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("uncommitted side effect push-1"));
});

test("committed side effects do not block resume", () => {
  const result = decideHandoffResume(
    input({
      sideEffects: [
        { id: "push-1", kind: "push", committed: true },
        { id: "pr-1", kind: "pr_create", committed: true },
      ],
    }),
  );
  assert.equal(result.decision, "resume");
  assert.deepEqual(result.reasons, []);
});

test("missing checkpoint sha restarts fresh with 'no checkpoint'", () => {
  const noRecordSha = decideHandoffResume(input({ record: { ...validRecord(), checkpointSha: undefined } }));
  assert.equal(noRecordSha.decision, "restart_fresh");
  assert.ok(noRecordSha.reasons.includes("no checkpoint"));

  const noObservedSha = decideHandoffResume(input({ observedCheckpointSha: null }));
  assert.equal(noObservedSha.decision, "restart_fresh");
  assert.ok(noObservedSha.reasons.includes("no checkpoint"));
});

test("handoff older than maxAgeMs restarts fresh", () => {
  const result = decideHandoffResume(input({ nowMs: CREATED_MS + 90_000, maxAgeMs: 60_000 }));
  assert.equal(result.decision, "restart_fresh");
  assert.ok(result.reasons.includes("handoff older than maxAgeMs"));
});

test("malformed createdAt restarts fresh (not finite)", () => {
  const result = decideHandoffResume(input({ record: { ...validRecord(), createdAt: "not-a-date" } }));
  assert.equal(result.decision, "restart_fresh");
  assert.ok(result.reasons.includes("handoff older than maxAgeMs"));
});

test("refuse beats restart_fresh when both apply, reasons contain both", () => {
  const result = decideHandoffResume(
    input({
      record: { ...validRecord(), state: "prepared", checkpointSha: undefined },
      observedCheckpointSha: null,
    }),
  );
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.includes("handoff not acknowledged (state prepared)"));
  assert.ok(result.reasons.includes("no checkpoint"));
});

test("input is not mutated", () => {
  const before = input({
    sideEffects: [{ id: "push-1", kind: "push", committed: false }],
  });
  const snapshot = JSON.stringify(before);
  decideHandoffResume(before);
  assert.equal(JSON.stringify(before), snapshot);
});
