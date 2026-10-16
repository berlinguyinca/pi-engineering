import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

/**
 * Regression tests for the orphan-recovery misfire (Bug 2): when a dispatch
 * authority is invalidated (controller disconnect / lease lapse), the owning
 * task must be left resumable (RETRYING) rather than CANCELED, and mission
 * recovery must re-queue it to READY so the SAME task is re-run instead of the
 * mission advancing to its next phase (e.g. dispatching an integrator against
 * an empty candidate branch).
 */
function harness() {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "orphan recovery mission",
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
  return { backend, store, mission };
}

function makeImplementer(store: MissionStore, missionId: string) {
  const task = store.createTask({
    mission_id: missionId,
    kind: "agent",
    role: "implementer",
    objective: "do the work",
    repo_id: "repo-1",
  });
  store.transitionTask(task.task_id, "READY");
  store.transitionTask(task.task_id, "RUNNING");
  return task;
}

describe("orphan recovery: resumable re-queue", () => {
  it("requeues a RETRYING (resumable) task back to READY so it can be re-run", () => {
    const { store, mission } = harness();
    const task = makeImplementer(store, mission.mission_id);
    // A controller-disconnect cancel leaves the task resumable (RETRYING).
    store.transitionTask(task.task_id, "RETRYING", "system", {
      failure_reason: "dispatch authority invalidated; resumable",
    });
    assert.equal(store.getTask(task.task_id)?.status, "RETRYING");

    const requeued = store.requeueResumableTasks(mission.mission_id);

    assert.deepEqual(requeued, [task.task_id]);
    assert.equal(store.getTask(task.task_id)?.status, "READY");
  });

  it("requeueing is idempotent and does not touch non-RETRYING tasks", () => {
    const { store, mission } = harness();
    const retrying = makeImplementer(store, mission.mission_id);
    store.transitionTask(retrying.task_id, "RETRYING");
    const succeeded = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "already done",
      repo_id: "repo-1",
    });
    store.transitionTask(succeeded.task_id, "READY");
    store.transitionTask(succeeded.task_id, "RUNNING");
    store.transitionTask(succeeded.task_id, "SUCCEEDED");

    const first = store.requeueResumableTasks(mission.mission_id);
    assert.deepEqual(first, [retrying.task_id]);
    // Second pass: the task is READY now, so nothing is re-queued.
    const second = store.requeueResumableTasks(mission.mission_id);
    assert.deepEqual(second, []);
    // The SUCCEEDED task is untouched.
    assert.equal(store.getTask(succeeded.task_id)?.status, "SUCCEEDED");
  });

  it("recovers an orphaned task left RETRYING by a resumable cancel (full reconciliation path)", () => {
    const { store, mission } = harness();
    const task = makeImplementer(store, mission.mission_id);
    // Simulate the orphan: the resumable cancel left the task RETRYING (not CANCELED).
    store.transitionTask(task.task_id, "RETRYING", "system", {
      failure_reason: "dispatch authority invalidated; resumable",
    });

    // This mirrors the recovery path: reconcile running orphans, then re-queue
    // resumable tasks. The orphaned task ends READY (re-runnable), and the
    // re-queue is a material change the recovery can act on.
    const reconciled = store.reconcileOrphanedExecutions(mission.mission_id);
    const requeued = store.requeueResumableTasks(mission.mission_id);

    const materialDelta = reconciled.length > 0 || requeued.length > 0;
    assert.equal(materialDelta, true, "re-queueing the orphaned task must be a material delta");
    assert.deepEqual(requeued, [task.task_id]);
    assert.equal(store.getTask(task.task_id)?.status, "READY");
  });

  it("does NOT requeue a terminally CANCELED task (the pre-fix bug leaves it stuck)", () => {
    const { store, mission } = harness();
    const task = makeImplementer(store, mission.mission_id);
    // Pre-fix behavior: the orphaned task was CANCELED (terminal).
    store.transitionTask(task.task_id, "CANCELED");

    const requeued = store.requeueResumableTasks(mission.mission_id);

    assert.deepEqual(requeued, [], "a CANCELED task must not be resurrected by requeueing");
    assert.equal(store.getTask(task.task_id)?.status, "CANCELED");
  });
});
