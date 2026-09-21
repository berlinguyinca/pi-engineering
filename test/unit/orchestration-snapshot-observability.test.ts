/**
 * Tests for the additive v2 mission-snapshot contract: the observability
 * section is emitted when present, absent for legacy publishers, and the base
 * mission/task/finding shape is unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  buildMissionSnapshotFile,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function mission(store: MissionStore, title: string) {
  return store.createMission({
    title,
    goal: "goal",
    user_request: "ur",
    repository: "repo",
    base_ref: "main",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
}

test("snapshot contract bumped to v2 and is additive", async () => {
  assert.equal(MISSION_SNAPSHOT_CONTRACT_VERSION, 2);
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const m = mission(store, "M");
  const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "O" });
  const file = buildMissionSnapshotFile([
    { mission: m, tasks: store.listTasks(m.mission_id), findings: [], observability: null },
  ]);
  const snap = file.missions[0]!;
  assert.equal(snap.observability, undefined, "null projection yields no observability section");
  assert.equal(snap.id, m.mission_id);
  assert.equal(snap.tasks[0]!.id, t.task_id, "base task shape unchanged");
  assert.equal(file.contractVersion, 2);
});

test("snapshot includes full observability section when projection present", async () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const obs = new MissionObservability({ backend, store, onUpdate: (_i, m) => updates.push(m) });
  const m = mission(store, "AIMS Console Refactor");
  obs.missionCreated(m.mission_id, "AIMS Console Refactor");
  const t = store.createTask({
    mission_id: m.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "Implement EventDrawer",
  });
  obs.workerStarted(m.mission_id, "wk-1", { taskId: t.task_id, model: "claude" });
  obs.activity(m.mission_id, {
    type: "editing_file",
    summary: "editing EventDrawer.tsx",
    workerId: "wk-1",
    meaningfulProgress: true,
  });
  obs.testProgress(m.mission_id, 12, 40, 12, 0);
  obs.testProgress(m.mission_id, 34, 40, 34, 0);
  store.transitionTask(t.task_id, "READY");
  store.transitionTask(t.task_id, "RUNNING");
  await obs.flush();

  const proj = obs.projection(m.mission_id)!;
  const file = buildMissionSnapshotFile([
    { mission: m, tasks: store.listTasks(m.mission_id), findings: [], observability: proj },
  ]);
  const ob = file.missions[0]!.observability!;
  assert.ok(ob, "observability section present");
  assert.ok(ob.progress.approximatePercent >= 0 && ob.progress.approximatePercent < 100);
  assert.equal(ob.progress.basis, "weighted_dag");
  assert.equal(ob.currentActivity?.summary, "editing EventDrawer.tsx");
  assert.equal(ob.workers.active, 1);
  assert.equal(ob.workerDetails[0]!.model, "claude");
  assert.equal(ob.tests.completed, 34);
  assert.equal(ob.tests.total, 40);
  assert.ok(ob.progressHistory.length >= 1);
  assert.equal(ob.review.blockingOpen, 0);
});
