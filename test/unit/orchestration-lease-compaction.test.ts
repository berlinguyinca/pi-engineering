import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compactLeaseEvents } from "../../src/orchestration/leaseCompaction.ts";
import { runMissionsCommand } from "../../src/orchestration/missionCancelCli.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function newMission(store: MissionStore, missionId: string) {
  return store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "lease churn",
    user_request: "lease churn",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
}

async function replay(file: string): Promise<MissionStore> {
  const backend = await JsonlEventStore.openReadOnly(file);
  try {
    return MissionStore.fromEvents(backend.all());
  } finally {
    backend.close();
  }
}

async function churnedLog(cycles: number): Promise<{ file: string; digest: string; revision: number }> {
  const dir = await mkdtemp(join(tmpdir(), "lease-compaction-"));
  const file = join(dir, "events.jsonl");
  const backend = await JsonlEventStore.open(file);
  const store = MissionStore.open(backend);
  newMission(store, "MSN-a");
  newMission(store, "MSN-b");
  const ownership = new MissionOwnership(store, { ownerId: "controller" });
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const missionId of ["MSN-a", "MSN-b"]) {
      const lease = await ownership.acquire(missionId);
      await ownership.acquireRepository(lease, `repo-${missionId}`);
      await ownership.release(lease);
    }
  }
  await ownership.acquire("MSN-a");
  await store.flush();
  const revision = store.getMission("MSN-a")!.revision;
  backend.close();
  return { file, digest: (await replay(file)).stateDigest(), revision };
}

describe("lease event compaction", () => {
  it("shrinks a churned log, keeps replayed state identical, and is dry-run by default", async () => {
    const { file, digest, revision } = await churnedLog(6);
    const originalBytes = (await stat(file)).size;

    const dry = await compactLeaseEvents(file);
    assert.equal(dry.applied, false);
    assert.equal(dry.stateIdentical, true);
    assert.ok(dry.leaseEventsAfter < dry.leaseEventsBefore / 3, "most lease events fold away");
    assert.equal((await stat(file)).size, originalBytes, "dry run leaves the log untouched");

    const done = await compactLeaseEvents(file, { apply: true });
    assert.equal(done.applied, true);
    assert.equal(done.backup, `${file}.bak`);
    assert.equal((await stat(`${file}.bak`)).size, originalBytes);
    assert.ok((await stat(file)).size < originalBytes);

    const replayed = await replay(file);
    assert.equal(replayed.stateDigest(), digest);
    assert.equal(replayed.getMission("MSN-a")!.revision, revision, "folded events still count toward the revision");

    const again = await compactLeaseEvents(file);
    assert.equal(again.leaseEventsAfter, again.leaseEventsBefore, "compaction is idempotent");
  });

  it("replays an old-format log and its compacted form to the same lease state", async () => {
    const { file } = await churnedLog(3);
    const before = await replay(file);
    await compactLeaseEvents(file, { apply: true });
    const after = await replay(file);
    assert.equal(after.stateDigest(), before.stateDigest());
    assert.deepEqual(after.getLatestMissionLease("MSN-a"), before.getLatestMissionLease("MSN-a"));
    assert.deepEqual(after.getMissionLease("MSN-a"), before.getMissionLease("MSN-a"));
    assert.deepEqual(after.getLatestRepositoryLease("repo-MSN-b"), before.getLatestRepositoryLease("repo-MSN-b"));
  });

  it("keeps malformed lines it cannot interpret", async () => {
    const { file } = await churnedLog(2);
    await appendFile(file, "{not json\n");
    const report = await compactLeaseEvents(file, { apply: true });
    assert.equal(report.applied, true);
    assert.match(await readFile(file, "utf8"), /\{not json/);
  });

  it("is exposed as `missions compact-leases` and does not write without --apply", async () => {
    const { file } = await churnedLog(2);
    const original = await readFile(file, "utf8");
    let out = "";
    const code = await runMissionsCommand(["compact-leases", "--file", file], {
      write: (text) => {
        out += text;
      },
    });
    assert.equal(code, 0);
    assert.match(out, /Would compact/);
    assert.equal(await readFile(file, "utf8"), original);
    const missing = await runMissionsCommand(["compact-leases"], { error: () => undefined });
    assert.equal(missing, 2);
  });
});

describe("lease events are not emitted when nothing changes", () => {
  it("does not append a second fence for a lease that is no longer held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lease-noop-"));
    const backend = await JsonlEventStore.open(join(dir, "events.jsonl"));
    const store = MissionStore.open(backend);
    newMission(store, "MSN-a");
    const ownership = new MissionOwnership(store, { ownerId: "controller" });
    const lease = await ownership.acquire("MSN-a");
    store.transitionMissionLease("fenced", lease);
    await store.flush();
    const count = backend.count();
    store.transitionMissionLease("fenced", lease);
    store.transitionMissionLease("expired", lease);
    await store.flush();
    assert.equal(backend.count(), count, "fencing or expiring an unheld lease appends nothing");
    backend.close();
  });
});
