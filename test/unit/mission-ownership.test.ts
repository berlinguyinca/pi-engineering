import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

function mission(store: MissionStore, missionId: string) {
  return store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "test durable ownership",
    user_request: "test durable ownership",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
}

describe("MissionOwnership", () => {
  it("renews a lease without changing its generation or fencing token", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    const ownership = new MissionOwnership(store, { ownerId: "controller-a", now: () => now, leaseMs: 60_000 });

    const acquired = await ownership.acquire("M-1");
    now += 30_000;
    const renewed = await ownership.renew(acquired);

    assert.equal(renewed.generation, 1);
    assert.equal(renewed.fencingToken, 1);
    assert.equal(renewed.renewBy, "2026-09-26T10:01:30.000Z");
    assert.deepEqual(store.getMissionLease("M-1"), renewed);
  });

  it("expires an overdue lease and reacquires it with a higher epoch", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    const firstOwner = new MissionOwnership(store, { ownerId: "controller-a", now: () => now, leaseMs: 10_000 });
    const first = await firstOwner.acquire("M-1");

    now += 10_001;
    assert.throws(() => firstOwner.assertAuthoritative(first), /expired/i);
    await assert.rejects(() => firstOwner.renew(first), /expired/i);
    const secondOwner = new MissionOwnership(store, { ownerId: "controller-b", now: () => now, leaseMs: 10_000 });
    const second = await secondOwner.acquire("M-1");

    assert.equal(second.generation, 2);
    assert.equal(second.fencingToken, 2);
    assert.equal(second.ownerId, "controller-b");
  });

  it("serializes repository mutation authority by repoId across missions", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    const store = MissionStore.open(JsonlEventStore.inMemory());
    mission(store, "M-1");
    mission(store, "M-2");
    const owner = new MissionOwnership(store, { ownerId: "controller", leaseMs: 60_000 });
    const firstMission = await owner.acquire("M-1");
    const secondMission = await owner.acquire("M-2");
    await owner.acquireRepository(firstMission, "repo-shared");

    await assert.rejects(() => owner.acquireRepository(secondMission, "repo-shared"), /repo-shared.*M-1/i);
  });

  it("rejects an old fencing token after takeover and process restart", async () => {
    const { MissionOwnership } = await import("../../src/orchestration/ownership.ts");
    const dir = await mkdtemp(join(tmpdir(), "pie-ownership-restart-"));
    const file = join(dir, "events.jsonl");
    let now = Date.parse("2026-09-26T10:00:00.000Z");

    const backend1 = await JsonlEventStore.open(file);
    const store1 = MissionStore.open(backend1);
    mission(store1, "M-1");
    const ownership1 = new MissionOwnership(store1, { ownerId: "controller-a", now: () => now, leaseMs: 10_000 });
    const stale = await ownership1.acquire("M-1");
    await store1.flush();
    backend1.close();

    now += 10_001;
    const backend2 = await JsonlEventStore.open(file);
    const store2 = MissionStore.open(backend2);
    const ownership2 = new MissionOwnership(store2, { ownerId: "controller-b", now: () => now, leaseMs: 10_000 });
    const current = await ownership2.acquire("M-1");

    assert.equal(current.generation, 2);
    assert.throws(() => ownership2.assertAuthoritative(stale), /stale.*fencing/i);
    assert.doesNotThrow(() => ownership2.assertAuthoritative(current));
    backend2.close();
  });

  it("keeps a shared runtime writer lock until the final runtime closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pie-runtime-ownership-"));
    const workDir = join(root, ".pi-eng");
    const file = join(workDir, "orchestration.jsonl");
    const first = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
    const second = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });

    await first.close();
    await assert.rejects(() => JsonlEventStore.open(file), /already open|writer lock/i);
    await second.close();

    const afterFinalClose = await JsonlEventStore.open(file);
    afterFinalClose.close();
  });
});
