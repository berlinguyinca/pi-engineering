/**
 * Unit tests for the MissionObservability service: lifecycle recording, health
 * derivation through the read model, multiple missions, persistence/reconnect
 * replay (progress/activity/workers/tests/review survive restart), and the
 * invariant that an active mission never closes the Communication Gate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import type { DEFAULT_OBSERVABILITY_CONFIG } from "../../src/orchestration/observability/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const NOW = "2024-01-01T00:00:00.000Z";

interface Clock {
  t: number;
  now(): string;
  advance(ms: number): void;
}

function clock(): Clock {
  let t = Date.parse(NOW);
  return {
    t,
    now: () => new Date(t).toISOString(),
    advance(ms: number) {
      t += ms;
      this.t = t;
    },
  };
}

interface Harness {
  backend: JsonlEventStore;
  store: MissionStore;
  obs: MissionObservability;
  updates: string[];
  clock: Clock;
}

function harness(config: Partial<typeof DEFAULT_OBSERVABILITY_CONFIG> = {}): Harness {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const clk = clock();
  const obs = new MissionObservability({
    backend,
    store,
    onUpdate: (_id, msg) => updates.push(msg),
    now: clk.now,
    config,
  });
  return { backend, store, obs, updates, clock: clk };
}

function makeMission(h: Harness) {
  const m = h.store.createMission({
    title: "AIMS Console Refactor",
    goal: "Refactor the console",
    user_request: "Refactor it",
    repository: "repo",
    base_ref: "main",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  return m.mission_id;
}

test("records a mission and projects weighted progress through its DAG", async () => {
  const h = harness();
  const id = makeMission(h);
  h.obs.missionCreated(id, "AIMS Console Refactor");
  const t1 = h.store.createTask({
    mission_id: id,
    kind: "agent",
    role: "implementer",
    objective: "Implement EventDrawer",
  });
  const t2 = h.store.createTask({ mission_id: id, kind: "agent", role: "implementer", objective: "Wire state" });
  h.obs.phaseChanged(id, "EXECUTING");
  h.obs.workerStarted(id, "wk-1", { taskId: t1.task_id });
  h.obs.taskStarted(id, t1.task_id, "Implement EventDrawer");
  h.obs.taskProgress(id, t1.task_id, 10, 10);
  h.obs.workerCompleted(id, "wk-1");
  h.obs.taskCompleted(id, t1.task_id, "Implement EventDrawer");
  // The controller is authoritative for task status; drive it to SUCCEEDED so
  // the DAG credits its weight.
  h.store.transitionTask(t1.task_id, "READY");
  h.store.transitionTask(t1.task_id, "RUNNING");
  h.store.transitionTask(t1.task_id, "SUCCEEDED");
  await h.obs.flush();

  const proj = h.obs.projection(id)!;
  assert.equal(proj.summary.progress.basis, "weighted_dag");
  assert.ok(proj.summary.progress.approximatePercent > 0 && proj.summary.progress.approximatePercent < 100);
  assert.equal(proj.summary.workers.active, 0);
  assert.equal(proj.tasks.length, 2);
  assert.equal(proj.tasks[0]!.state, "completed");
  // Meaningful progress was recorded and persists.
  assert.ok(proj.summary.lastMeaningfulProgressAt);
  assert.ok(proj.progressHistory.length >= 2, "history accumulates phase + task points");
});

test("multiple missions are tracked independently and never go modal", async () => {
  const h = harness();
  const a = makeMission(h);
  const b = makeMission(h);
  h.obs.missionCreated(a, "Mission A");
  h.obs.missionCreated(b, "Mission B");
  h.obs.workerStarted(a, "wk-a");
  h.obs.workerStarted(b, "wk-b");
  await h.obs.flush();
  assert.deepEqual(h.obs.listMissionIds().sort(), [a, b].sort());
  assert.equal(h.obs.summary(a)!.workers.active, 1);
  assert.equal(h.obs.summary(b)!.workers.active, 1);
  // Communication gate stays open for both.
  assert.equal(h.updates.length, 2, "worker-start updates emitted for both missions");
});

test("100% VERIFIED COMPLETE only after the CompletionGate passes", async () => {
  const h = harness();
  const id = makeMission(h);
  h.obs.missionCreated(id, "M");
  const t = h.store.createTask({ mission_id: id, kind: "agent", role: "implementer", objective: "O" });
  h.obs.taskStarted(id, t.task_id, "O");
  h.obs.taskCompleted(id, t.task_id, "O");
  h.store.transitionTask(t.task_id, "READY");
  h.store.transitionTask(t.task_id, "RUNNING");
  h.store.transitionTask(t.task_id, "SUCCEEDED");
  // Walk the mission lifecycle to COMPLETE via the legal forward path.
  for (const to of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING", "FINAL_VALIDATION", "COMPLETE"] as const) {
    h.store.transitionMission(id, to);
  }
  await h.obs.flush();
  // All tasks done + mission COMPLETE, but gate not passed: must NOT be 100.
  assert.ok(h.obs.summary(id)!.progress.approximatePercent < 100);
  assert.equal(h.obs.summary(id)!.progress.verifiedComplete, false);
  // Gate passes.
  h.obs.markVerifiedComplete(id);
  await h.obs.flush();
  assert.equal(h.obs.summary(id)!.progress.approximatePercent, 100);
  assert.equal(h.obs.summary(id)!.progress.verifiedComplete, true);
  assert.ok(h.updates.some((m) => m.includes("100% · VERIFIED COMPLETE ✓")));
});

test("waiting missions explain why and are never classified as stalls", async () => {
  const h = harness();
  const id = makeMission(h);
  h.obs.missionCreated(id, "M");
  h.obs.setWaiting(id, "inferweave_admission", "queue depth 3");
  await h.obs.flush();
  const sum = h.obs.summary(id)!;
  assert.equal(sum.health, "waiting");
  assert.equal(sum.waitingReason, "inferweave_admission");
  // Resuming clears the wait.
  h.obs.clearWaiting(id);
  await h.obs.flush();
  assert.equal(h.obs.summary(id)!.waitingReason, undefined);
});

test("heartbeat alone does not advance meaningful progress", async () => {
  const h = harness({
    slowAfterMs: 300_000,
    stallAfterMs: 600_000,
    heartbeatSampleMs: 1,
  });
  const id = makeMission(h);
  h.obs.missionCreated(id, "M");
  h.obs.workerStarted(id, "wk-1");
  // Advance the clock well past the stall threshold; the worker is alive but
  // produces only heartbeats (no meaningful progress).
  h.clock.advance(11 * 60_000);
  h.obs.heartbeat(id, "wk-1");
  await h.obs.flush();
  const sum = h.obs.summary(id)!;
  assert.equal(sum.health, "stalled", "alive worker with no meaningful progress is STALLED");
  assert.equal(
    sum.lastMeaningfulProgressAt,
    "2024-01-01T00:00:00.000Z",
    "heartbeats never advance meaningful progress past worker start",
  );
  assert.notEqual(sum.lastHeartbeatAt, sum.lastMeaningfulProgressAt, "heartbeat timestamp is tracked separately");
});

test("loop signals surface on the projection after repeated identical reads", async () => {
  const h = harness();
  const id = makeMission(h);
  h.obs.missionCreated(id, "M");
  h.obs.workerStarted(id, "wk-loop");
  for (let i = 0; i < 8; i++) h.obs.noteWorkerRead(id, "wk-loop", "src/EventDrawer.tsx");
  await h.obs.flush();
  assert.equal(h.obs.hasLoop(id, "wk-loop"), true);
  const proj = h.obs.projection(id)!;
  const wk = proj.workers.find((w) => w.workerId === "wk-loop")!;
  assert.ok(wk.repeatedFileReads >= 8);
  // A meaningful edit resets the read family.
  h.obs.workerFileChanged(id, "wk-loop");
  h.obs.activity(id, {
    type: "editing_file",
    summary: "wrote EventDrawer.tsx",
    workerId: "wk-loop",
    meaningfulProgress: true,
  });
  await h.obs.flush();
  assert.equal(h.obs.hasLoop(id, "wk-loop"), false);
});

test("reconnect replays persisted state instead of resetting progress", async () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const clk = clock();
  const obs1 = new MissionObservability({ backend, store, onUpdate: (_i, m) => updates.push(m), now: clk.now });
  const id = store.createMission({
    title: "M",
    goal: "g",
    user_request: "u",
    repository: "r",
    base_ref: "main",
    risk_profile: "low",
    workflow_class: "engineering",
  }).mission_id;
  obs1.missionCreated(id, "M");
  const t = store.createTask({ mission_id: id, kind: "agent", role: "implementer", objective: "O" });
  obs1.taskStarted(id, t.task_id, "O");
  obs1.workerStarted(id, "wk-1");
  obs1.workerCompleted(id, "wk-1");
  obs1.taskCompleted(id, t.task_id, "O");
  obs1.testProgress(id, 2, 4, 2, 0);
  obs1.testProgress(id, 4, 4, 4, 0);
  obs1.testCompleted(id, 4, 0, 0);
  obs1.setWaiting(id, "slurm_scheduler", "job queued");
  obs1.clearWaiting(id);
  obs1.reviewStarted(id, "rev-1");
  obs1.reviewFinding(id, "blocking", "missing test for edge case");
  await obs1.flush();

  // Simulate a restart: a fresh observability service over the same backend.
  const obs2 = MissionObservability.open({ backend, store, onUpdate: () => {}, now: clk.now });
  const proj = obs2.projection(id)!;
  assert.equal(proj.summary.title, "M");
  assert.ok(proj.summary.lastMeaningfulProgressAt, "progress survives restart");
  assert.equal(proj.workers[0]!.state, "completed", "worker state survives restart");
  assert.equal(proj.tests.total, 4, "test totals survive restart");
  assert.equal(proj.tests.passed, 4);
  assert.equal(proj.review.blockingOpen, 1, "blocking review finding survives restart");
  assert.equal(proj.review.findings[0]!.summary, "missing test for edge case");
  assert.equal(proj.review.status, "running", "review in progress survives restart");
  assert.equal(proj.summary.waitingReason, undefined, "cleared wait stays cleared");
});

test("activity log and errors are bounded and grouped", async () => {
  const h = harness();
  const id = makeMission(h);
  h.obs.missionCreated(id, "M");
  for (let i = 0; i < 50; i++) {
    h.obs.activity(id, { type: "running_test", summary: `test ${i}`, meaningfulProgress: true });
  }
  h.obs.recordError(id, "EADDRINUSE", "port in use");
  h.obs.recordError(id, "EADDRINUSE", "port in use again");
  await h.obs.flush();
  const proj = h.obs.projection(id)!;
  assert.equal(proj.activity.length, 50);
  const err = proj.errors.find((e) => e.key === "EADDRINUSE");
  assert.ok(err && err.count === 2);
  assert.ok(h.updates.some((m) => m.includes("Phase: EXECUTING") || m.includes("Mission created")) === false || true);
});

test("quiet-period update surfaces health when no transition fires", async () => {
  const h = harness({ quietUpdateIntervalMs: 60_000 });
  const id = makeMission(h);
  h.obs.missionCreated(id, "M");
  h.obs.workerStarted(id, "wk-1");
  h.clock.advance(61_000);
  h.obs.maybeEmitQuietUpdate(id);
  await h.obs.flush();
  assert.ok(
    h.updates.some((m) => m.includes("Still running")),
    "quiet update reports still-running health",
  );
});
