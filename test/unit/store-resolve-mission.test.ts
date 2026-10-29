import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { SessionEventStore } from "../../src/runtime/isolation/SessionEventStore.ts";

/**
 * #427 — `mission status/resume MSN-J9sycT` answered **Unknown mission** from
 * the session that had just run it, while the durable per-session streams
 * replayed that mission perfectly. The live projection is not the authority;
 * the appended events are. Before a mutation path declares a mission unknown it
 * must apply what other sessions appended to the same namespace.
 */

async function namespace(): Promise<{ root: string; eventsDir: string; recoveryDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-resolve-"));
  return { root, eventsDir: join(root, "events"), recoveryDir: join(root, "recovery") };
}

function createMission(store: MissionStore, missionId: string): ReturnType<MissionStore["createMission"]> {
  return store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "resolve from durable events",
    user_request: "resolve from durable events",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "low",
    workflow_class: "conversation",
  });
}

/** A mission another session appended after this store opened is resolvable. */
test("a mission appended by another session resolves instead of reading unknown", async () => {
  const ns = await namespace();
  const mine = MissionStore.open(SessionEventStore.open({ ...ns, sessionId: "mine", worktreeId: "wt" }));
  const theirsBackend = SessionEventStore.open({ ...ns, sessionId: "theirs", worktreeId: "wt" });
  const theirs = MissionStore.open(theirsBackend);
  createMission(theirs, "MSN-J9sycT");
  await theirs.flush();

  assert.equal(mine.getMission("MSN-J9sycT"), undefined, "the live projection has not seen it yet");

  const resolved = mine.resolveMission("MSN-J9sycT");

  assert.ok(resolved, "the durable streams are the authority, not the local projection");
  assert.equal(resolved?.mission_id, "MSN-J9sycT");
  assert.ok(mine.getMission("MSN-J9sycT"), "resolving also brings it into the live store");

  theirsBackend.close();
});

/** A truly unknown id is still unknown — resolving must not invent one. */
test("an id no stream carries stays unknown", async () => {
  const ns = await namespace();
  const store = MissionStore.open(SessionEventStore.open({ ...ns, sessionId: "solo", worktreeId: "wt" }));

  assert.equal(store.resolveMission("MSN-nope"), undefined);
});

/** Resolving is idempotent and cheap to call again on a known mission. */
test("resolving a mission the store already holds changes nothing", async () => {
  const ns = await namespace();
  const store = MissionStore.open(SessionEventStore.open({ ...ns, sessionId: "own", worktreeId: "wt" }));
  createMission(store, "MSN-own");
  await store.flush();

  const before = store.getMission("MSN-own");
  const after = store.resolveMission("MSN-own");

  assert.equal(after?.revision, before?.revision, "a re-read does not advance the mission");
  assert.equal(after?.status, before?.status);
});

/** A resolved mission is mutable: the store applied it fully, not partially. */
test("a resolved mission can be transitioned by the resolving store", async () => {
  const ns = await namespace();
  const mine = MissionStore.open(SessionEventStore.open({ ...ns, sessionId: "a", worktreeId: "wt" }));
  const theirsBackend = SessionEventStore.open({ ...ns, sessionId: "b", worktreeId: "wt" });
  const theirs = MissionStore.open(theirsBackend);
  createMission(theirs, "MSN-handover");
  await theirs.flush();

  const resolved = mine.resolveMission("MSN-handover");
  assert.equal(resolved?.status, "NEW");

  mine.transitionMission("MSN-handover", "CLASSIFYING");

  assert.equal(mine.getMission("MSN-handover")?.status, "CLASSIFYING");
  theirsBackend.close();
});
