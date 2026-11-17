/**
 * #458 — the successor of a checkpoint handoff was told nothing it could verify.
 *
 * Unit A1 built a full immutable reference set (40-hex checkpoint SHA, 40-hex
 * source SHA, artifact refs with sha256 hashes) and unit B1's store method
 * `addHandoffRecordWithCheckpointRefs` documents that it "attaches" them. It did
 * not: `attachCheckpointRefs` copied `checkpointSha` and dropped `sourceSha` and
 * every artifact hash, and `validateHandoffRecord`'s allowlist copy would have
 * dropped them anyway because no field was declared to hold them. The successor
 * could see WHICH commit it resumed from but could not prove which artifacts it
 * was built from — the proof A1 computed was discarded one function later.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { attachCheckpointRefs, buildCheckpointRefs } from "../../src/runtime/host/handoffCheckpointRefs.ts";
import type { HandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { validateHandoffRecord } from "../../src/runtime/host/handoffKinds.ts";
import { SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

function baseRecord(over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: "ho-1",
    kind: "phase_transition",
    state: "prepared",
    missionId: "MSN-458",
    predecessor: { sessionId: "pre", generation: 1 },
    createdAt: "2026-10-29T00:00:00.000Z",
    ...over,
  } as HandoffRecord;
}

const refsInput = {
  checkpointSha: SHA_A,
  sourceSha: SHA_B,
  artifactRefs: ["artifact://checkpoint-1", "artifact://patch-2"],
  artifactHashes: [H1, H2],
};

/** The whole reference set survives attachment, not just the commit SHA. */
test("attachCheckpointRefs carries sourceSha and every artifact hash (#458)", () => {
  const built = buildCheckpointRefs(refsInput);
  if (!built.ok) throw new Error(`refs rejected: ${built.errors.join("; ")}`);
  const refs = built.refs;
  const attached = attachCheckpointRefs(baseRecord(), built.refs);

  assert.equal(attached.checkpointSha, SHA_A, "the commit sha keeps its own field");
  assert.ok(attached.checkpointRefs, "the reference set must be on the record");
  assert.equal(attached.checkpointRefs.sourceSha, SHA_B);
  assert.deepEqual(attached.checkpointRefs.artifacts, [
    { ref: "artifact://checkpoint-1", sha256: H1 },
    { ref: "artifact://patch-2", sha256: H2 },
  ]);

  // Fresh copies both ways: neither the input refs nor the base record can be
  // reached through the returned record.
  const carried = attached.checkpointRefs;
  if (!carried) throw new Error("attachment produced no reference set");
  const carriedFirst = carried.artifacts[0];
  const builtFirst = built.refs.artifacts[0];
  if (!carriedFirst || !builtFirst) throw new Error("expected artifact refs");
  carriedFirst.sha256 = "c".repeat(64);
  assert.equal(builtFirst.sha256, H1, "input refs must not be reachable");
});

/** A record that carries refs validates and keeps them; a malformed set does not. */
test("validateHandoffRecord preserves a valid set and rejects a malformed one", () => {
  const built = buildCheckpointRefs(refsInput);
  if (!built.ok) throw new Error(`refs rejected: ${built.errors.join("; ")}`);
  const validated = validateHandoffRecord(attachCheckpointRefs(baseRecord(), built.refs));
  if (!validated.ok) throw new Error(`record rejected: ${validated.errors.join("; ")}`);
  const good = validated;
  assert.equal(good.record.checkpointRefs?.sourceSha, SHA_B);
  assert.equal(good.record.checkpointRefs?.artifacts.length, 2);

  // A tampered artifact hash is refused rather than stored.
  const tampered = {
    ...good.record,
    checkpointRefs: { ...good.record.checkpointRefs!, artifacts: [{ ref: "artifact://checkpoint-1", sha256: "nope" }] },
  };
  assert.ok(!validateHandoffRecord(tampered).ok, "a non-hex artifact hash must be rejected");

  // A reference set that disagrees with the record's own checkpoint is refused.
  const disagreeing = { ...good.record, checkpointSha: SHA_B };
  assert.ok(!validateHandoffRecord(disagreeing).ok, "refs.checkpointSha must match checkpointSha");

  // A record with no reference set is still valid — old writers are not broken.
  assert.ok(validateHandoffRecord(baseRecord()).ok, "checkpointRefs stays optional");
});

/** The durable store round-trips the reference set, so a successor can verify it. */
test("the store persists the reference set and replays it after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-458-"));
  const eventsDir = join(root, "events");
  const recoveryDir = join(root, "recovery");
  const open = (sessionId: string) =>
    MissionStore.open(SessionEventStore.open({ eventsDir, recoveryDir, sessionId, worktreeId: "wt" }));

  const store = open("writer");
  const stored = store.addHandoffRecordWithCheckpointRefs(baseRecord(), refsInput);
  assert.equal(stored.checkpointRefs?.sourceSha, SHA_B);
  await store.flush();

  // A fresh session — the successor's view — reads back the same proof.
  const reopened = open("successor");
  const read = reopened.getHandoffRecord("ho-1");
  assert.ok(read?.checkpointRefs, "the successor must be able to verify the checkpoint");
  assert.equal(read.checkpointRefs.sourceSha, SHA_B);
  assert.deepEqual(
    read.checkpointRefs.artifacts.map((a) => a.sha256),
    [H1, H2],
  );
});
