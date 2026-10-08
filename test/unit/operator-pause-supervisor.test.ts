/**
 * A mission the operator paused is never resumed by the supervisor, even in
 * the window between the interrupt and the durable stop: interrupted tasks are
 * already RETRYING with no worker, which otherwise reads as an orphan.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

describe("MissionSupervisor: operator pause", () => {
  it("skips a mission with an operator pause recorded but no stop yet", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "paused",
      goal: "finish",
      user_request: "finish",
      repository: "/repo",
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering",
    });
    for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
      store.transitionMission(mission.mission_id, status);
    }
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "interrupted work",
      repo_id: "repo-1",
    });
    store.transitionTask(task.task_id, "READY");
    store.transitionTask(task.task_id, "RUNNING");
    store.markOperatorPause(mission.mission_id);
    store.transitionTask(task.task_id, "RETRYING");
    const observability = new MissionObservability({ backend, store });
    observability.missionCreated(mission.mission_id, mission.title);
    const supervisor = new MissionSupervisor({ store, observability });

    const [status] = await supervisor.tick();

    assert.notEqual(status?.health, "ORPHANED");
    assert.equal(status?.decision, undefined);
    assert.equal(store.listRecoveryDecisions(mission.mission_id).length, 0);
    await store.flush();
    assert.ok(MissionStore.open(backend).getMission(mission.mission_id)?.operator_paused_at, "durable");
  });
});
