import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HANDOFF_KINDS,
  HANDOFF_STATES,
  type HandoffRecord,
  nextStates,
  validateHandoffRecord,
} from "../../src/runtime/host/handoffKinds.ts";

const BASE_RECORD = {
  id: "handoff-1",
  kind: "context",
  state: "prepared",
  missionId: "MSN-abc123",
  predecessor: { sessionId: "sess-a", generation: 0 },
  createdAt: "2025-01-01T00:00:00.000Z",
} as const;

/** A minimal valid record in the `prepared` state. */
function baseRecord(): HandoffRecord {
  return { ...BASE_RECORD, kind: "context", state: "prepared" };
}

function validRecord(): HandoffRecord {
  return {
    ...baseRecord(),
    state: "committed",
    successor: { sessionId: "sess-b", generation: 1 },
    checkpointSha: "0123456789abcdef",
    ackAt: "2025-01-01T00:00:01.000Z",
  };
}

test("all 10 typed handoff kinds validate as valid records", () => {
  assert.equal(HANDOFF_KINDS.length, 10);
  assert.deepEqual([...HANDOFF_KINDS].sort(), [
    "context",
    "delegation",
    "deployment",
    "merge",
    "phase_transition",
    "pr",
    "recovery",
    "review",
    "review_fix",
    "supervisor",
  ]);
  for (const kind of HANDOFF_KINDS) {
    const record = { ...baseRecord(), kind };
    const result = validateHandoffRecord(record);
    assert.equal(result.ok, true, `expected kind ${kind} to validate`);
    assert.deepEqual(result.ok ? result.record.kind : null, kind);
  }
});

test("unknown kind is rejected", () => {
  const result = validateHandoffRecord({ ...baseRecord(), kind: "bogus" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("kind")));
});

test("missing successor for acknowledged state is rejected", () => {
  const record = { ...baseRecord(), state: "acknowledged", ackAt: "2025-01-01T00:00:01.000Z" };
  const result = validateHandoffRecord(record);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("successor")));
});

test("missing ackAt for committed state is rejected", () => {
  const record = { ...baseRecord(), state: "committed", successor: { sessionId: "sess-b", generation: 1 } };
  const result = validateHandoffRecord(record);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("ackAt")));
});

test("bad checkpointSha is rejected", () => {
  for (const bad of ["xyz", "abcdefg!", "abcdef", "A".repeat(65)]) {
    const result = validateHandoffRecord({ ...validRecord(), checkpointSha: bad });
    assert.equal(result.ok, false, `expected sha ${bad} to be rejected`);
    assert.ok(!result.ok && result.errors.some((e) => e.includes("checkpointSha")));
  }
});

test("valid checkpointSha lengths are accepted", () => {
  for (const sha of ["0123456", "0123456789abcdef", "a".repeat(64)]) {
    const result = validateHandoffRecord({ ...validRecord(), checkpointSha: sha });
    assert.equal(result.ok, true, `expected sha ${sha} to validate`);
  }
});

test("transition table encodes prepared→validated→acknowledged→committed with aborted from every non-committed state", () => {
  assert.deepEqual(nextStates("prepared"), ["validated", "aborted"]);
  assert.deepEqual(nextStates("validated"), ["acknowledged", "aborted"]);
  assert.deepEqual(nextStates("acknowledged"), ["committed", "aborted"]);
  assert.deepEqual(nextStates("committed"), []);
  assert.deepEqual(nextStates("aborted"), []);

  // aborted is reachable from every forward-progress state (all states except
  // committed and aborted itself, which is a sink).
  for (const state of HANDOFF_STATES) {
    if (state === "prepared" || state === "validated" || state === "acknowledged") {
      assert.ok(nextStates(state).includes("aborted"), `aborted reachable from ${state}`);
    } else {
      assert.ok(!nextStates(state).includes("aborted"), `aborted not a successor of ${state}`);
    }
  }
});

test("a fully-populated record round-trips through validation", () => {
  const record = validRecord();
  const result = validateHandoffRecord(record);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.record.id === record.id);
  assert.ok(result.ok && result.record.kind === record.kind);
  assert.ok(result.ok && result.record.state === record.state);
  assert.ok(result.ok && result.record.missionId === record.missionId);
  assert.deepEqual(result.ok && result.record.predecessor, record.predecessor);
  assert.deepEqual(result.ok && result.record.successor, record.successor);
  assert.equal(result.ok && result.record.checkpointSha, record.checkpointSha);
  assert.equal(result.ok && result.record.ackAt, record.ackAt);
  assert.equal(result.ok && result.record.createdAt, record.createdAt);
});

test("non-object input is rejected", () => {
  for (const value of [null, undefined, "handoff", 42, []]) {
    const result = validateHandoffRecord(value);
    assert.equal(result.ok, false);
  }
});

test("malformed fields are rejected", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing id", { id: "" }],
    ["missing missionId", { missionId: "" }],
    ["missing predecessor", { predecessor: { sessionId: "", generation: 0 } }],
    ["negative generation", { predecessor: { sessionId: "s", generation: -1 } }],
    ["missing createdAt", { createdAt: "" }],
    ["non-string ackAt", { ackAt: 5 }],
  ];
  for (const [label, patch] of cases) {
    const result = validateHandoffRecord({ ...baseRecord(), ...patch });
    assert.equal(result.ok, false, `expected ${label} to be rejected`);
    assert.ok(result.ok === false && result.errors.length > 0);
  }
});

test("strict timestamp and field validation rejects garbage input", () => {
  const committed = (patch: Record<string, unknown>) => ({
    ...validRecord(),
    state: "committed",
    successor: { sessionId: "sess-b", generation: 1 },
    ackAt: "2025-01-01T00:00:01.000Z",
    ...patch,
  });

  const cases: Array<{ label: string; record: unknown; message: string }> = [
    {
      label: "unknown state 'bogus'",
      record: { ...baseRecord(), state: "bogus" },
      message: "state must be one of",
    },
    {
      label: "non-string state 42",
      record: { ...baseRecord(), state: 42 },
      message: "state must be a non-empty string",
    },
    {
      label: "generation 1.5",
      record: { ...baseRecord(), predecessor: { sessionId: "s", generation: 1.5 } },
      message: "predecessor must be { sessionId: string, generation: number }",
    },
    {
      label: "generation NaN",
      record: { ...baseRecord(), predecessor: { sessionId: "s", generation: Number.NaN } },
      message: "predecessor must be { sessionId: string, generation: number }",
    },
    {
      label: "generation -1",
      record: { ...baseRecord(), predecessor: { sessionId: "s", generation: -1 } },
      message: "predecessor must be { sessionId: string, generation: number }",
    },
    {
      label: "state committed without successor",
      record: { ...validRecord(), successor: undefined },
      message: "successor is required for state committed",
    },
    {
      label: "state committed with ackAt ''",
      record: committed({ ackAt: "" }),
      message: "ackAt must be an ISO-8601 timestamp when present",
    },
    {
      label: "state committed with ackAt 'not-a-date'",
      record: committed({ ackAt: "not-a-date" }),
      message: "ackAt must be an ISO-8601 timestamp when present",
    },
    {
      label: "createdAt 'garbage'",
      record: { ...baseRecord(), createdAt: "garbage" },
      message: "createdAt must be an ISO-8601 timestamp",
    },
    {
      label: "createdAt ''",
      record: { ...baseRecord(), createdAt: "" },
      message: "createdAt must be an ISO-8601 timestamp",
    },
    {
      label: "checkpointSha 123",
      record: { ...validRecord(), checkpointSha: 123 },
      message: "checkpointSha must match /^[0-9a-f]{7,64}$/ when present",
    },
    {
      label: "checkpointSha 'xyz'",
      record: { ...validRecord(), checkpointSha: "xyz" },
      message: "checkpointSha must match /^[0-9a-f]{7,64}$/ when present",
    },
    {
      label: "successor { sessionId: 1 }",
      record: { ...validRecord(), successor: { sessionId: 1 } },
      message: "successor must be { sessionId: string, generation: number }",
    },
    {
      label: "input [] (array)",
      record: [],
      message: "",
    },
  ];

  for (const { label, record, message } of cases) {
    const result = validateHandoffRecord(record);
    assert.equal(result.ok, false, `expected ${label} to be rejected`);
    if (result.ok === false && message !== "") {
      assert.ok(
        result.errors.some((e) => e.includes(message)),
        `${label} errors should include ${message}`,
      );
    }
  }
});

test("nextStates returns [] for unknown or non-handoff values", () => {
  assert.deepEqual(nextStates("bogus" as never), []);
  assert.deepEqual(nextStates("committed"), []);
  assert.deepEqual(nextStates("aborted"), []);
});

test("a valid committed record with a future ackAt passes", () => {
  const result = validateHandoffRecord({
    ...validRecord(),
    state: "committed",
    ackAt: "2026-10-16T00:00:00Z",
  });
  assert.equal(result.ok, true);
});

test("returned record is a fresh copy with no extra fields and isolated from the input", () => {
  const input = { ...validRecord(), junk: "should-be-dropped" };
  const result = validateHandoffRecord(input);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.notStrictEqual(result.record, input);
  assert.ok(!("junk" in result.record), "extra field should be dropped");

  // Mutating the input after validation must not change the returned record.
  input.state = "aborted";
  input.junk = "changed";
  assert.equal(result.record.state, "committed");
  assert.ok(!("junk" in result.record));
});

test("illegal transitions are rejected by the transition helper", () => {
  // prepared has only [validated, aborted] as successors.
  assert.ok(!nextStates("prepared").includes("acknowledged"), "prepared -> acknowledged illegal");
  assert.ok(!nextStates("prepared").includes("committed"), "prepared -> committed illegal");
  // validated has only [acknowledged, aborted] as successors.
  assert.ok(!nextStates("validated").includes("prepared"), "validated -> prepared illegal");
  // committed and aborted are sinks.
  assert.deepEqual(nextStates("committed"), [], "committed has no successors");
  assert.deepEqual(nextStates("aborted"), [], "aborted has no successors");
});
