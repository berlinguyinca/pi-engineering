import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function newStore() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "lane events",
    goal: "lane events",
    user_request: "lane events",
    repository: ".",
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  return { backend, store, missionId: mission.mission_id };
}

describe("lane events on the mission event stream", () => {
  it("records a lane.acquired event with actor=system and payload", async () => {
    const { backend, store, missionId } = newStore();
    store.recordLaneEvent("lane.acquired", missionId, {
      repo_id: "repo:/x",
      task_id: "TSK-1",
      domains: ["src/a"],
      fence: 1,
    });
    await store.flush();
    const event = backend.all().find((e) => e.type === "lane.acquired");
    assert.ok(event, "lane.acquired event present");
    assert.equal(event.payload.actor, "system");
    assert.equal(event.run_id, missionId);
    assert.equal(event.payload.repo_id, "repo:/x");
    assert.equal(event.payload.task_id, "TSK-1");
    assert.deepEqual(event.payload.domains, ["src/a"]);
  });

  it("carries blocking claims on a lane.wait event", async () => {
    const { backend, store, missionId } = newStore();
    store.recordLaneEvent("lane.wait", missionId, {
      task_id: "TSK-2",
      repo_id: "repo:/x",
      blocking_claims: [{ taskId: "TSK-1", ownerId: "hostA/o", domain: "src/a" }],
    });
    await store.flush();
    const event = backend.all().find((e) => e.type === "lane.wait");
    assert.ok(event);
    const blocking = event.payload.blocking_claims as Array<Record<string, unknown>>;
    assert.equal(blocking[0]?.taskId, "TSK-1");
    assert.equal(blocking[0]?.ownerId, "hostA/o");
  });

  it("emits all five lane event kinds", async () => {
    const { backend, store, missionId } = newStore();
    store.recordLaneEvent("lane.acquired", missionId, { task_id: "T1" });
    store.recordLaneEvent("lane.released", missionId, { task_id: "T1" });
    store.recordLaneEvent("lane.wait", missionId, { task_id: "T2", blocking_claims: [] });
    store.recordLaneEvent("lane.stale_taken", missionId, { owner_id: "hostX/o", task_id: "T3" });
    store.recordLaneEvent("lane.index_corrupt", missionId, { repo_id: "repo:/bad" });
    await store.flush();
    const types = new Set(backend.all().map((e) => e.type));
    for (const expected of [
      "lane.acquired",
      "lane.released",
      "lane.wait",
      "lane.stale_taken",
      "lane.index_corrupt",
    ] as const) {
      assert.ok(types.has(expected), `expected ${expected} in events`);
    }
  });
});
