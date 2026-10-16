import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CheckpointRefsInput,
  attachCheckpointRefs,
  buildCheckpointRefs,
} from "../../src/runtime/host/handoffCheckpointRefs.ts";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

function baseRecord(): HandoffRecord {
  return {
    id: "handoff-1",
    kind: "context",
    state: "prepared",
    missionId: "MSN-abc123",
    predecessor: { sessionId: "sess-a", generation: 0 },
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

function validInput(overrides: Partial<CheckpointRefsInput> = {}): CheckpointRefsInput {
  return {
    checkpointSha: SHA_A,
    sourceSha: SHA_B,
    artifactRefs: [`artifact://checkpoint-1`, `artifact://checkpoint-2`],
    artifactHashes: [H1, H2],
    ...overrides,
  };
}

test("handoff checkpoint refs: valid input builds refs with artifacts in order", () => {
  const result = buildCheckpointRefs(validInput());
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.refs.checkpointSha, SHA_A);
  assert.equal(result.refs.sourceSha, SHA_B);
  assert.deepEqual(result.refs.artifacts, [
    { ref: "artifact://checkpoint-1", sha256: H1 },
    { ref: "artifact://checkpoint-2", sha256: H2 },
  ]);
});

test("handoff checkpoint refs: 7-hex checkpointSha triggers rule 1 error", () => {
  const result = buildCheckpointRefs(validInput({ checkpointSha: "a".repeat(7) }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.errors, ["checkpointSha must be a 40-hex commit sha"]);
});

test("handoff checkpoint refs: uppercase sourceSha triggers rule 2 error", () => {
  const result = buildCheckpointRefs(validInput({ sourceSha: SHA_B.toUpperCase() }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.errors, ["sourceSha must be a 40-hex commit sha"]);
});

test("handoff checkpoint refs: both bad shas report exactly 2 errors in order", () => {
  const result = buildCheckpointRefs(validInput({ checkpointSha: "a".repeat(7), sourceSha: SHA_B.toUpperCase() }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.errors, [
    "checkpointSha must be a 40-hex commit sha",
    "sourceSha must be a 40-hex commit sha",
  ]);
});

test("handoff checkpoint refs: length mismatch reports only the rule 3 error and skips rules 4-6", () => {
  const result = buildCheckpointRefs(
    validInput({
      artifactRefs: [`artifact://checkpoint-1`, `artifact://checkpoint-2`],
      artifactHashes: [H1],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.deepEqual(result.errors, ["artifact refs and hashes length mismatch"]);
});

test("handoff checkpoint refs: ref without artifact:// triggers rule 4 error with index", () => {
  const result = buildCheckpointRefs(validInput({ artifactRefs: [`artifact://checkpoint-1`, `bad-ref`] }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.includes("artifact ref 1 must start with artifact://"));
});

test("handoff checkpoint refs: bare artifact:// ref triggers rule 4 error", () => {
  const result = buildCheckpointRefs(validInput({ artifactRefs: [`artifact://`], artifactHashes: [H1] }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.includes("artifact ref 0 must start with artifact://"));
});

test("handoff checkpoint refs: short hash triggers rule 5 error with index", () => {
  const result = buildCheckpointRefs(validInput({ artifactHashes: [H1, "1".repeat(63)] }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.includes("artifact hash 1 must be 64-hex sha256"));
});

test("handoff checkpoint refs: duplicate ref triggers rule 6 error exactly once on second occurrence", () => {
  const result = buildCheckpointRefs(
    validInput({
      artifactRefs: [`artifact://checkpoint-1`, `artifact://checkpoint-1`, `artifact://checkpoint-2`],
      artifactHashes: [H1, H2, H1],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  const dupErrors = result.errors.filter((e) => e === "duplicate artifact ref artifact://checkpoint-1");
  assert.equal(dupErrors.length, 1);
});

test("handoff checkpoint refs: empty artifacts build ok with artifacts []", () => {
  const result = buildCheckpointRefs(validInput({ artifactRefs: [], artifactHashes: [] }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.deepEqual(result.refs.artifacts, []);
});

test("handoff checkpoint refs: inputs are not mutated and returned arrays/objects are new", () => {
  const input = validInput();
  const refsInput = { ...input, artifactRefs: [...input.artifactRefs], artifactHashes: [...input.artifactHashes] };
  const result = buildCheckpointRefs(refsInput);
  assert.equal(result.ok, true);
  assert.ok(result.ok);

  // Input arrays are unchanged.
  assert.deepEqual(refsInput.artifactRefs, input.artifactRefs);
  assert.deepEqual(refsInput.artifactHashes, input.artifactHashes);

  // Returned artifacts array is a new array with new objects, not the input refs.
  assert.notStrictEqual(result.refs.artifacts, refsInput.artifactRefs);
  for (let i = 0; i < result.refs.artifacts.length; i += 1) {
    assert.notStrictEqual(result.refs.artifacts[i], refsInput.artifactRefs[i]);
  }

  // Mutating the input after the call must not affect the returned refs.
  refsInput.artifactRefs[0] = "mutated";
  const firstArtifact = result.refs.artifacts[0];
  assert.equal(firstArtifact?.ref, "artifact://checkpoint-1");
});

test("handoff checkpoint refs: attachCheckpointRefs sets checkpointSha, keeps other fields, returns new object", () => {
  const record = baseRecord();
  const refs = { checkpointSha: SHA_A, sourceSha: SHA_B, artifacts: [{ ref: "artifact://c", sha256: H1 }] };
  const attached = attachCheckpointRefs(record, refs);

  assert.notStrictEqual(attached, record);
  assert.equal(attached.checkpointSha, SHA_A);

  const { checkpointSha: _ignored, ...rest } = attached;
  void _ignored;
  assert.deepEqual(rest, record);

  // The original record is not mutated.
  assert.equal(record.checkpointSha, undefined);
});
