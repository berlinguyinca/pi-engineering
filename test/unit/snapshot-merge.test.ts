import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type MissionSnapshotFile,
  type MissionSnapshotMission,
  mergeSnapshotFiles,
  readMissionSnapshotFile,
  tagSnapshotPublisher,
} from "../../src/orchestration/missionSnapshot.ts";

/**
 * #427 — four live `pi` processes on one dev box each publish
 * `.pi-eng/orchestration-snapshot.json`. The write is atomic per process, but
 * every process wrote ONLY ITS OWN live missions, so the file flipped between
 * partial views and the plugin (and any reader) showed whichever writer won.
 * Observed consequence: a mission that existed, and had blocked, read back as
 * absent minutes later.
 *
 * The merge is the fix: a publish replaces this publisher's own entries and
 * keeps every other publisher's, so the file is a union rather than a lottery.
 */

const PID = 1000;

function mission(id: string, over: Partial<MissionSnapshotMission> = {}): MissionSnapshotMission {
  return {
    id,
    revision: 1,
    title: id,
    goal: "g",
    workflowClass: "engineering",
    status: "RUNNING",
    riskProfile: "medium",
    constraints: [],
    requiredGates: [],
    acceptanceCriteria: [],
    tasks: [],
    findings: [],
    ...over,
  };
}

function file(missions: MissionSnapshotMission[], over: Partial<MissionSnapshotFile> = {}): MissionSnapshotFile {
  return { contractVersion: 3, generatedAt: new Date("2026-10-28T00:00:00.000Z").toISOString(), missions, ...over };
}

function ids(snapshot: MissionSnapshotFile): string[] {
  return snapshot.missions.map((m) => m.id).sort();
}

/** Another session's missions survive a publish from this one. */
test("a publish keeps the missions another publisher owns", () => {
  const onDisk = tagSnapshotPublisher(file([mission("MSN-mine"), mission("MSN-theirs")]), {
    ownerPid: 2000,
    publishedAtMs: 1_000,
  });
  const incoming = tagSnapshotPublisher(file([mission("MSN-mine")]), { ownerPid: PID, publishedAtMs: 2_000 });

  const merged = mergeSnapshotFiles(onDisk, incoming, { ownerPid: PID, publishedAtMs: 2_000 });

  assert.deepEqual(ids(merged), ["MSN-mine", "MSN-theirs"], "the file is a union, not a lottery");
});

/** The same mission from two publishers: the higher durable revision wins. */
test("the higher durable revision wins for a mission two publishers report", () => {
  const onDisk = tagSnapshotPublisher(file([mission("MSN-both", { revision: 7, status: "BLOCKED" })]), {
    ownerPid: 2000,
    publishedAtMs: 9_000,
  });
  const incoming = tagSnapshotPublisher(file([mission("MSN-both", { revision: 3, status: "RUNNING" })]), {
    ownerPid: PID,
    publishedAtMs: 10_000,
  });

  const merged = mergeSnapshotFiles(onDisk, incoming, { ownerPid: PID, publishedAtMs: 10_000 });

  assert.equal(merged.missions.length, 1);
  assert.equal(merged.missions[0]!.revision, 7, "the event-log ordinal decides, not who wrote last");
  assert.equal(merged.missions[0]!.status, "BLOCKED");
});

/** Same revision from both: this publisher is the authority for its own view. */
test("an equal revision resolves to the publisher that holds the mission", () => {
  const onDisk = tagSnapshotPublisher(file([mission("MSN-both", { revision: 4, status: "RUNNING" })]), {
    ownerPid: 2000,
    publishedAtMs: 1_000,
  });
  const incoming = tagSnapshotPublisher(file([mission("MSN-both", { revision: 4, status: "COMPLETE" })]), {
    ownerPid: PID,
    publishedAtMs: 2_000,
  });

  const merged = mergeSnapshotFiles(onDisk, incoming, { ownerPid: PID, publishedAtMs: 2_000 });

  assert.equal(merged.missions[0]!.status, "COMPLETE", "the holder's view of its own mission wins a tie");
});

/** A mission this session finished and dropped does not linger as a zombie. */
test("missions this publisher owned and no longer holds are dropped", () => {
  const onDisk = file([
    { ...mission("MSN-finished", { status: "COMPLETE" }), ownerPid: PID, publishedAtMs: 1_000 },
    { ...mission("MSN-theirs"), ownerPid: 2000, publishedAtMs: 1_000 },
  ]);
  const incoming = tagSnapshotPublisher(file([mission("MSN-new")]), { ownerPid: PID, publishedAtMs: 2_000 });

  const merged = mergeSnapshotFiles(onDisk, incoming, { ownerPid: PID, publishedAtMs: 2_000 });

  assert.deepEqual(ids(merged), ["MSN-new", "MSN-theirs"], "own entries drop; foreign entries survive");
});

/** Merging twice is the same as merging once — a republish is idempotent. */
test("the merge is idempotent", () => {
  const onDisk = tagSnapshotPublisher(file([mission("MSN-theirs"), mission("MSN-mine")]), {
    ownerPid: 2000,
    publishedAtMs: 1_000,
  });
  const incoming = tagSnapshotPublisher(file([mission("MSN-mine", { revision: 2 })]), {
    ownerPid: PID,
    publishedAtMs: 2_000,
  });

  const once = mergeSnapshotFiles(onDisk, incoming, { ownerPid: PID, publishedAtMs: 2_000 });
  const twice = mergeSnapshotFiles(once, incoming, { ownerPid: PID, publishedAtMs: 3_000 });

  assert.deepEqual(ids(twice), ids(once));
  assert.equal(twice.missions.find((m) => m.id === "MSN-mine")?.revision, 2);
});

/** A corrupt or absent file on disk is not a reason to publish nothing. */
test("an unreadable existing snapshot still publishes this publisher's view", () => {
  const incoming = tagSnapshotPublisher(file([mission("MSN-mine")]), { ownerPid: PID, publishedAtMs: 2_000 });

  const merged = mergeSnapshotFiles(null, incoming, { ownerPid: PID, publishedAtMs: 2_000 });

  assert.deepEqual(ids(merged), ["MSN-mine"]);
});

/** Foreign entries are stamped so the next publisher can tell whose they were. */
test("every published entry carries its publisher and publish time", () => {
  const incoming = tagSnapshotPublisher(file([mission("MSN-mine")]), { ownerPid: PID, publishedAtMs: 4_321 });

  assert.deepEqual(
    { pid: incoming.missions[0]!.ownerPid, at: incoming.missions[0]!.publishedAtMs },
    { pid: PID, at: 4_321 },
  );
});

/** The publisher's own storage-pressure state is what the plugin should read. */
test("the incoming publisher owns the storage-pressure block", () => {
  const onDisk = file([mission("MSN-theirs")], {
    storagePressure: { dirty: true, stale: true, staleAtMs: 1, republished: false, suspended: true },
  });
  const incoming = tagSnapshotPublisher(file([mission("MSN-mine")]), { ownerPid: PID, publishedAtMs: 2_000 });

  const merged = mergeSnapshotFiles(onDisk, incoming, { ownerPid: PID, publishedAtMs: 2_000 });

  assert.equal(merged.storagePressure, undefined, "another session's suspended write is not this session's state");
});

/**
 * The reported scenario, at the file level: two publishers on one `.pi-eng`
 * directory, each holding different live missions. Each publishes through the
 * read-merge-write path; the file must end up describing both views. Before the
 * merge, each write carried only its own missions and the file flipped between
 * partial views — which is what made a live, blocked mission read back as absent.
 */
test("two publishers writing one file leave both views published", async () => {
  const { mkdtemp, readFile, writeFile, rename } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-snapshot-two-writers-"));
  const path = join(dir, "orchestration-snapshot.json");

  const publish = async (ownerPid: number, missions: MissionSnapshotMission[], publishedAtMs: number) => {
    const existing = await readMissionSnapshotFile(path);
    const tag = { ownerPid, publishedAtMs };
    const merged = mergeSnapshotFiles(existing, tagSnapshotPublisher(file(missions), tag), tag);
    const temporary = `${path}.${ownerPid}.tmp`;
    await writeFile(temporary, JSON.stringify(merged, null, 2), "utf8");
    await rename(temporary, path);
    return merged;
  };

  await publish(1000, [mission("MSN-alpha"), mission("MSN-shared", { revision: 2 })], 1_000);
  await publish(2000, [mission("MSN-beta"), mission("MSN-shared", { revision: 5, status: "BLOCKED" })], 2_000);
  await publish(1000, [mission("MSN-alpha", { revision: 3 })], 3_000);

  const published = JSON.parse(await readFile(path, "utf8")) as MissionSnapshotFile;
  assert.deepEqual(ids(published), ["MSN-alpha", "MSN-beta", "MSN-shared"], "no publisher erases another's missions");
  assert.equal(published.missions.find((m) => m.id === "MSN-shared")?.revision, 5, "the durable ordinal decides");
  assert.equal(published.missions.find((m) => m.id === "MSN-shared")?.status, "BLOCKED");
  assert.equal(published.missions.find((m) => m.id === "MSN-alpha")?.revision, 3, "the holder updates its own");
});
