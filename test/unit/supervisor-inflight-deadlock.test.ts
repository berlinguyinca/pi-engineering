/**
 * A dependent task waiting on a task that is RUNNING is not a deadlock. The window is real: a worker's execution row
 * settles before its task row does (the change observer and result capture run git in between), and the slower that
 * git is the wider the window. A supervisor tick landing in it used to BLOCK a healthy mission, after which the
 * runtime's own finalize failed with "illegal mission transition BLOCKED -> FINAL_VALIDATION".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function fixture(): { store: MissionStore; supervisor: MissionSupervisor; missionId: string; dependency: string } {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "inflight",
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
  const first = store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "work whose execution row has settled",
    repo_id: "repo-1",
  });
  store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "reviewer",
    objective: "waits on the implementer",
    repo_id: "repo-1",
    depends_on: [first.task_id],
  });
  store.transitionTask(first.task_id, "READY");
  store.transitionTask(first.task_id, "RUNNING");
  const observability = new MissionObservability({ backend, store });
  observability.missionCreated(mission.mission_id, mission.title);
  return {
    store,
    supervisor: new MissionSupervisor({ store, observability }),
    missionId: mission.mission_id,
    dependency: first.task_id,
  };
}

describe("MissionSupervisor: a dependency still RUNNING is not a deadlock", () => {
  it("does not BLOCK the mission while the task it waits on is RUNNING with no live execution row", async () => {
    const { store, supervisor, missionId } = fixture();
    await supervisor.tick(missionId).catch(() => []);
    assert.notEqual(store.getMission(missionId)?.status, "BLOCKED");
    assert.equal(
      store.listFailureClassifications(missionId).some((c) => c.category === "DEADLOCKED_DAG"),
      false,
    );
  });
});

describe("MissionSupervisor: a controller that is driving the mission is not an orphan", () => {
  function finishing(runInFlight?: (id: string) => boolean): {
    store: MissionStore;
    supervisor: MissionSupervisor;
    id: string;
  } {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "finishing",
      goal: "finish",
      user_request: "finish",
      repository: "/repo",
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering",
    });
    for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING", "VALIDATING"] as const) {
      store.transitionMission(mission.mission_id, status);
    }
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "done",
      repo_id: "repo-1",
    });
    store.transitionTask(task.task_id, "READY");
    store.transitionTask(task.task_id, "RUNNING");
    store.transitionTask(task.task_id, "SUCCEEDED");
    const observability = new MissionObservability({ backend, store });
    observability.missionCreated(mission.mission_id, mission.title);
    return {
      store,
      id: mission.mission_id,
      supervisor: new MissionSupervisor({ store, observability, ...(runInFlight ? { runInFlight } : {}) }),
    };
  }

  it("leaves a VALIDATING mission alone while its run is live", async () => {
    const { store, supervisor, id } = finishing(() => true);
    const [status] = await supervisor.tick(id);
    assert.notEqual(status?.health, "ORPHANED");
    assert.equal(store.listRecoveryDecisions(id).length, 0);
  });

  it("still calls the same mission an orphan when no run is live", async () => {
    const { supervisor, id } = finishing(() => false);
    const [status] = await supervisor.tick(id);
    assert.equal(status?.health, "ORPHANED");
  });
});
