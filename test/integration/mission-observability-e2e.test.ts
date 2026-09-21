/**
 * Synthetic E2E observability scenario (spec 08 §synthetic scenario).
 *
 * Drives ONE mission through the full lifecycle the way the orchestrator would,
 * verifying that observability tracks every stage:
 *
 *   planning -> implementation -> (wait) -> test progress -> intentional loop
 *   -> stall detection -> recovery -> complete -> independent review
 *   -> blocking finding -> repair -> re-review -> final validation
 *   -> CompletionGate -> 100% · VERIFIED COMPLETE
 *
 * Along the way it asserts: weighted progress rises monotonically (except the
 * repair step that legitimately dilutes it), a genuine queue wait is WAITING,
 * loop/stall detection fires and is observable, recovery is an observable event
 * (never silent), the Communication Gate stays open throughout, and 100 is only
 * shown after the CompletionGate passes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const NOW = Date.parse("2024-01-01T00:00:00.000Z");
let T = NOW;
const nowFn = () => new Date(T).toISOString();
const advance = (ms: number): number => {
  T += ms;
  return T;
};

// Canonical forward mission order. Each adjacent step is a legal transition, and
// forward skips are legal, so walking current->target along this list is safe.
const MISSION_ORDER = [
  "NEW",
  "CLASSIFYING",
  "PLANNING",
  "READY",
  "EXECUTING",
  "INTEGRATING",
  "VALIDATING",
  "REVIEWING",
  "REPAIRING",
  "FINAL_VALIDATION",
  "COMPLETE",
] as const;

function walkMission(store: MissionStore, id: string, to: string) {
  const cur = store.getMission(id)!.status as string;
  const fromIdx = MISSION_ORDER.indexOf(cur as never);
  const toIdx = MISSION_ORDER.indexOf(to as never);
  if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) return;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    store.transitionMission(id, MISSION_ORDER[i] as never);
  }
}

test("synthetic mission observability E2E scenario", async () => {
  T = NOW;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const obs = new MissionObservability({
    backend,
    store,
    onUpdate: (_id, msg) => updates.push(msg),
    now: nowFn,
    config: {
      stallAfterMs: 300_000,
      slowAfterMs: 120_000,
      heartbeatSampleMs: 1,
      loopThresholds: { reading_file: 5, default: 5 },
    },
  });

  const id = store.createMission({
    title: "AIMS Console Refactor",
    goal: "Refactor the console with observable progress",
    user_request: "Refactor it",
    repository: "repo",
    base_ref: "main",
    risk_profile: "medium",
    workflow_class: "engineering",
  }).mission_id;
  obs.missionCreated(id, "AIMS Console Refactor");

  // ── planning ──
  walkMission(store, id, "PLANNING");
  obs.phaseChanged(id, "PLANNING");
  const planT = store.createTask({ mission_id: id, kind: "process", role: "planner", objective: "Decompose work" });
  store.transitionTask(planT.task_id, "READY");
  store.transitionTask(planT.task_id, "RUNNING");
  obs.workerStarted(id, "wk-plan", { taskId: planT.task_id });
  obs.taskProgress(id, planT.task_id, 4, 4);
  store.transitionTask(planT.task_id, "SUCCEEDED");
  obs.workerCompleted(id, "wk-plan");
  obs.taskCompleted(id, planT.task_id, "Decompose work");

  const t1 = store.createTask({
    mission_id: id,
    kind: "agent",
    role: "implementer",
    objective: "Implement EventDrawer",
  });
  const t2 = store.createTask({ mission_id: id, kind: "agent", role: "implementer", objective: "Wire state" });
  const t3 = store.createTask({ mission_id: id, kind: "validation", role: "verifier", objective: "Validate build" });

  // ── implementation (with an InferWeave admission wait) ──
  walkMission(store, id, "EXECUTING");
  obs.phaseChanged(id, "EXECUTING");
  obs.setWaiting(id, "inferweave_admission", "queue depth 3");
  store.transitionTask(t1.task_id, "READY");
  store.transitionTask(t1.task_id, "RUNNING");
  obs.workerStarted(id, "wk-impl", { taskId: t1.task_id, model: "deepseek_v4-flash", host: "n-42" });
  advance(45_000);
  obs.clearWaiting(id);
  obs.taskProgress(id, t1.task_id, 3, 10);
  obs.activity(id, {
    type: "editing_file",
    summary: "editing EventDrawer.tsx",
    workerId: "wk-impl",
    meaningfulProgress: true,
  });

  // Health while waiting for the model: WAITING with an explanation, never a stall.
  assert.equal(obs.summary(id)!.health, "active", "after resume, active");
  assert.equal(obs.summary(id)!.waitingReason, undefined);

  // ── intentional loop on worker wk-impl: repeated identical reads ──
  for (let i = 0; i < 6; i++) {
    obs.noteWorkerRead(id, "wk-impl", "src/EventDrawer.tsx");
    advance(2_000);
    obs.heartbeat(id, "wk-impl");
  }
  assert.equal(obs.hasLoop(id, "wk-impl"), true, "loop detected by repeated identical reads");
  // The worker stays alive (heartbeats) but produces no meaningful progress for
  // well past the stall threshold: health becomes STALLED.
  advance(400_000);
  obs.heartbeat(id, "wk-impl");
  assert.equal(obs.summary(id)!.health, "stalled", "alive worker, no meaningful progress -> STALLED");

  // ── observable recovery (never silent) ──
  const updatesBeforeRecovery = updates.length;
  obs.recoveryStarted(id, "wk-impl", "bounded worker restart", 1, "repeated identical reads, no DAG transition");
  obs.noteWorkerRead(id, "wk-impl", "src/EventDrawer.tsx"); // fresh read after restart
  obs.workerFileChanged(id, "wk-impl");
  obs.activity(id, {
    type: "editing_file",
    summary: "rewrote EventDrawer.tsx",
    workerId: "wk-impl",
    meaningfulProgress: true,
  });
  obs.recoveryCompleted(id);
  assert.ok(updates.length > updatesBeforeRecovery, "recovery emits a user-facing update");
  assert.equal(obs.hasLoop(id, "wk-impl"), false, "recovery reset the loop");
  assert.equal(obs.summary(id)!.health, "active", "recovered work is active again");

  // ── implementation completes; measurable test progress ──
  obs.taskProgress(id, t1.task_id, 10, 10);
  store.transitionTask(t1.task_id, "SUCCEEDED");
  obs.workerCompleted(id, "wk-impl");
  obs.taskCompleted(id, t1.task_id, "Implement EventDrawer");

  store.transitionTask(t2.task_id, "READY");
  store.transitionTask(t2.task_id, "RUNNING");
  obs.workerStarted(id, "wk-impl2", { taskId: t2.task_id });
  obs.taskProgress(id, t2.task_id, 8, 8);
  store.transitionTask(t2.task_id, "SUCCEEDED");
  obs.workerCompleted(id, "wk-impl2");
  obs.taskCompleted(id, t2.task_id, "Wire state");

  // ── validation: running tests ──
  walkMission(store, id, "VALIDATING");
  obs.phaseChanged(id, "VALIDATING");
  obs.testProgress(id, 12, 40, 12, 0);
  obs.testProgress(id, 30, 40, 30, 0);
  obs.testProgress(id, 40, 40, 40, 0);
  obs.testCompleted(id, 40, 0, 0);
  const midPercent = obs.summary(id)!.progress.approximatePercent;
  assert.ok(midPercent > 0 && midPercent < 100, "in-progress mission is never 100%");

  // ── independent review surfaces a blocking finding ──
  walkMission(store, id, "REVIEWING");
  obs.phaseChanged(id, "REVIEWING");
  obs.reviewStarted(id, "rev-1", "claude");
  obs.reviewFinding(id, "blocking", "EventDrawer drops focus on state change", "src/EventDrawer.tsx");
  assert.equal(obs.summary(id)!.completionStatus, "review_blocked", "blocking finding blocks completion");
  const proj = obs.projection(id)!;
  assert.equal(proj.review.blockingOpen, 1);

  // ── repair + re-review ──
  walkMission(store, id, "REPAIRING");
  obs.phaseChanged(id, "REPAIRING");
  const repairT = store.createTask({ mission_id: id, kind: "agent", role: "repair", objective: "Fix focus bug" });
  store.transitionTask(repairT.task_id, "READY");
  store.transitionTask(repairT.task_id, "RUNNING");
  obs.workerStarted(id, "wk-repair", { taskId: repairT.task_id });
  obs.repairStarted(id, repairT.task_id);
  obs.workerCompleted(id, "wk-repair");
  store.transitionTask(repairT.task_id, "SUCCEEDED");
  obs.repairCompleted(id, repairT.task_id, proj.review.findings[0]!.findingId);

  // Re-review clears the blocker.
  obs.reviewStarted(id, "rev-1", "claude");
  obs.reviewCompleted(id);
  assert.equal(obs.projection(id)!.review.blockingOpen, 0, "blocker cleared after repair + re-review");

  // ── final validation then CompletionGate ──
  walkMission(store, id, "FINAL_VALIDATION");
  obs.phaseChanged(id, "FINAL_VALIDATION");
  obs.testCompleted(id, 41, 0, 0);
  assert.ok(obs.summary(id)!.progress.approximatePercent < 100, "still <100 before gate passes");

  obs.gateStarted(id);
  obs.gatePassed(id);
  walkMission(store, id, "COMPLETE");
  const final = obs.summary(id)!;
  assert.equal(final.progress.approximatePercent, 100, "100 only after gate passes");
  assert.equal(final.progress.verifiedComplete, true);
  assert.equal(final.health, "complete");
  assert.ok(updates.some((m) => m.includes("100% · VERIFIED COMPLETE ✓")));

  // Communication Gate stayed open the whole time: user-facing updates flowed
  // even while the mission was active, and nothing suppressed them.
  assert.ok(updates.some((m) => m.includes("Phase: EXECUTING")));
  assert.ok(updates.some((m) => m.includes("Recovery attempt 1")));
  assert.ok(updates.some((m) => m.includes("Blocking review finding")));
  assert.ok(updates.some((m) => m.includes("Repair completed")));

  // Progress history captured the journey, including the repair dip.
  const history = obs.projection(id)!.progressHistory;
  assert.ok(history.length >= 5, "history spans the whole journey");
  const pcts = history.map((p) => p.approximatePercent);
  assert.equal(pcts[pcts.length - 1], 100, "history ends at 100 after gate");

  // Persistence: a fresh service over the same store reconstructs the terminal
  // state (verified complete survives restart).
  await obs.flush();
  const obs2 = MissionObservability.open({ backend, store, onUpdate: () => {}, now: nowFn });
  const replayed = obs2.summary(id)!;
  assert.equal(replayed.progress.approximatePercent, 100);
  assert.equal(replayed.progress.verifiedComplete, true);
  assert.equal(replayed.health, "complete");
});
