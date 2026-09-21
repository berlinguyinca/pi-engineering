/**
 * Unit tests for the observability pure modules: weighted DAG progress,
 * health derivation, loop/stall detection, and event persistence mapping.
 *
 * Covers spec 01 (weighted progress, measurable units, <100 before
 * verification, dynamic expansion), spec 03 (health states, heartbeat vs
 * meaningful progress, waiting not stalled, stall/loop thresholds), and
 * spec 05 (event persistence round-trip, additive types).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OBSERVABILITY_EVENT_TYPES,
  fromStoredEvent,
  newObservabilityEvent,
  storedTypeForEventType,
  toStoredEvent,
} from "../../src/orchestration/observability/events.ts";
import { deriveHealth } from "../../src/orchestration/observability/health.ts";
import { computeProgress, weightForTask } from "../../src/orchestration/observability/progress.ts";
import { WorkerLoopTracker } from "../../src/orchestration/observability/stall.ts";
import { DEFAULT_OBSERVABILITY_CONFIG } from "../../src/orchestration/observability/types.ts";
import type { OrchestrationTask } from "../../src/orchestration/types.ts";

function task(partial: Partial<OrchestrationTask> & Pick<OrchestrationTask, "task_id" | "status">): OrchestrationTask {
  return {
    mission_id: "MSN-test",
    kind: "agent",
    role: "implementer",
    objective: partial.task_id,
    depends_on: [],
    priority: 0,
    mutates_repo: true,
    write_domains: [],
    isolation: "worktree",
    execution_requirements: {},
    assigned_execution_id: null,
    artifacts: [],
    attempt: 0,
    max_attempts: 3,
    failure_policy: "retry",
    created_at: "2024-01-01T00:00:00Z",
    started_at: null,
    completed_at: null,
    steer_requests: [],
    ...partial,
  };
}

test("weightForTask uses explicit, then role, then kind, then 1", () => {
  const t = (role: string, kind: OrchestrationTask["kind"]) => ({ role, kind }) as OrchestrationTask;
  assert.equal(weightForTask(t("implementer", "agent"), 5), 5, "explicit wins");
  assert.equal(weightForTask(t("implementer", "agent")), 12, "role weight");
  assert.equal(weightForTask(t("mystery", "integration")), 5, "kind weight");
  assert.equal(weightForTask(t("mystery", "mystery" as OrchestrationTask["kind"])), 1, "fallback");
});

test("weighted progress credits completed nodes, clamps below 100 pre-verification", () => {
  const tasks = [
    task({ task_id: "A", status: "SUCCEEDED" }),
    task({ task_id: "B", status: "RUNNING", role: "implementer" }),
    task({ task_id: "C", status: "PENDING" }),
  ];
  const weights = { A: 12, B: 12, C: 12 };
  // A complete, B running without units gets 0.2 credit, C pending.
  const res = computeProgress({
    missionId: "MSN",
    tasks,
    missionStatus: "EXECUTING",
    verifiedComplete: false,
    completionStatus: "not_ready",
    weights,
    creditRunningWithoutUnits: true,
  });
  assert.equal(res.basis, "weighted_dag");
  assert.equal(res.approximatePercent, 40); // (12 + 2.4) / 36 = 40%
  assert.equal(res.verifiedComplete, false);
  assert.equal(res.tasks[0]!.state, "completed");
  assert.equal(res.tasks[1]!.state, "running");
  assert.equal(res.tasks[2]!.state, "pending");
});

test("measurable running units scale a task's weight fractionally", () => {
  const tasks = [task({ task_id: "A", status: "RUNNING", role: "implementer" })];
  const units = { A: { completed: 3, total: 10 } };
  const res = computeProgress({
    missionId: "MSN",
    tasks,
    missionStatus: "EXECUTING",
    verifiedComplete: false,
    completionStatus: "not_ready",
    weights: { A: 12 },
    units,
    creditRunningWithoutUnits: false,
  });
  // 3/10 * 12 = 3.6 => 30%
  assert.equal(res.approximatePercent, 30);
});

test("all tasks completed but unverified renders ~99, never 100", () => {
  const tasks = [task({ task_id: "A", status: "SUCCEEDED" }), task({ task_id: "B", status: "SUCCEEDED" })];
  const res = computeProgress({
    missionId: "MSN",
    tasks,
    missionStatus: "VALIDATING",
    verifiedComplete: false,
    completionStatus: "validating",
    weights: { A: 1, B: 1 },
  });
  assert.equal(res.approximatePercent, 99);
  assert.equal(res.verifiedComplete, false);
});

test("100 is only rendered after verifiedComplete", () => {
  const tasks = [task({ task_id: "A", status: "SUCCEEDED" })];
  const res = computeProgress({
    missionId: "MSN",
    tasks,
    missionStatus: "COMPLETE",
    verifiedComplete: true,
    completionStatus: "verified_complete",
    weights: { A: 1 },
  });
  assert.equal(res.approximatePercent, 100);
  assert.equal(res.verifiedComplete, true);
});

test("dynamic DAG expansion moves progress backward (repair adds weight)", () => {
  const base = [task({ task_id: "A", status: "SUCCEEDED", role: "implementer" })];
  const before = computeProgress({
    missionId: "MSN",
    tasks: base,
    missionStatus: "EXECUTING",
    verifiedComplete: false,
    completionStatus: "not_ready",
    weights: { A: 12 },
  });
  assert.equal(before.approximatePercent, 99, "unverified full-DAG is ~99, never 100");
  const expanded = [...base, task({ task_id: "R", status: "PENDING", role: "repair" })];
  const after = computeProgress({
    missionId: "MSN",
    tasks: expanded,
    missionStatus: "REPAIRING",
    verifiedComplete: false,
    completionStatus: "repairing",
    weights: { A: 12, R: 4 },
  });
  assert.ok(after.approximatePercent < before.approximatePercent, "repair weight dilutes progress");
});

test("legacy mission (no explicit weights) has inferred basis", () => {
  const tasks = [task({ task_id: "A", status: "SUCCEEDED" })];
  const res = computeProgress({
    missionId: "MSN",
    tasks,
    missionStatus: "COMPLETE",
    verifiedComplete: false,
    completionStatus: "not_ready",
    basis: "inferred",
  });
  assert.equal(res.basis, "inferred");
});

// ── health ────────────────────────────────────────────────────────────────

const t = (iso: string) => iso;

test("health: fresh meaningful progress => ACTIVE", () => {
  const h = deriveHealth({
    missionStatus: "EXECUTING",
    blocked: false,
    failed: false,
    complete: false,
    verifiedComplete: false,
    lastMeaningfulProgressAt: t("2024-01-01T00:01:00Z"),
    slowAfterMs: 120_000,
    stallAfterMs: 300_000,
    now: "2024-01-01T00:02:00Z",
    alive: true,
  });
  assert.equal(h.health, "active");
});

test("health: heartbeat without meaningful progress => SLOW then STALLED", () => {
  // 4 minutes since meaningful progress (past slow, under stall).
  const slow = deriveHealth({
    missionStatus: "EXECUTING",
    blocked: false,
    failed: false,
    complete: false,
    verifiedComplete: false,
    lastHeartbeatAt: t("2024-01-01T00:04:30Z"),
    lastMeaningfulProgressAt: t("2024-01-01T00:00:00Z"),
    slowAfterMs: 120_000,
    stallAfterMs: 300_000,
    now: "2024-01-01T00:04:30Z",
    alive: true,
  });
  assert.equal(slow.health, "slow");
  // 6 minutes => stalled.
  const stalled = deriveHealth({
    missionStatus: "EXECUTING",
    blocked: false,
    failed: false,
    complete: false,
    verifiedComplete: false,
    lastHeartbeatAt: t("2024-01-01T00:06:00Z"),
    lastMeaningfulProgressAt: t("2024-01-01T00:00:00Z"),
    slowAfterMs: 120_000,
    stallAfterMs: 300_000,
    now: "2024-01-01T00:06:00Z",
    alive: true,
  });
  assert.equal(stalled.health, "stalled");
});

test("health: a genuine waiting reason is WAITING, never STALLED", () => {
  const h = deriveHealth({
    missionStatus: "EXECUTING",
    waitingReason: "inferweave_admission",
    blocked: false,
    failed: false,
    complete: false,
    verifiedComplete: false,
    lastMeaningfulProgressAt: t("2024-01-01T00:00:00Z"),
    slowAfterMs: 120_000,
    stallAfterMs: 300_000,
    now: "2024-01-01T01:00:00Z",
    alive: true,
  });
  assert.equal(h.health, "waiting");
  assert.equal(h.waitingReason, "inferweave_admission");
});

test("health: slurm scheduler wait is WAITING, not stalled", () => {
  const h = deriveHealth({
    missionStatus: "EXECUTING",
    waitingReason: "slurm_scheduler",
    blocked: false,
    failed: false,
    complete: false,
    verifiedComplete: false,
    lastMeaningfulProgressAt: t("2024-01-01T00:00:00Z"),
    slowAfterMs: 120_000,
    stallAfterMs: 300_000,
    now: "2024-01-01T02:00:00Z",
    alive: true,
  });
  assert.equal(h.health, "waiting");
});

test("health: terminal states map directly", () => {
  assert.equal(
    deriveHealth({
      missionStatus: "COMPLETE",
      blocked: false,
      failed: false,
      complete: true,
      verifiedComplete: false,
      slowAfterMs: 1,
      stallAfterMs: 2,
      now: "2024-01-01T00:00:00Z",
      alive: false,
    }).health,
    "complete",
  );
  assert.equal(
    deriveHealth({
      missionStatus: "FAILED",
      blocked: false,
      failed: true,
      complete: false,
      verifiedComplete: false,
      slowAfterMs: 1,
      stallAfterMs: 2,
      now: "2024-01-01T00:00:00Z",
      alive: false,
    }).health,
    "failed",
  );
  assert.equal(
    deriveHealth({
      missionStatus: "BLOCKED",
      blocked: true,
      failed: false,
      complete: false,
      verifiedComplete: false,
      slowAfterMs: 1,
      stallAfterMs: 2,
      now: "2024-01-01T00:00:00Z",
      alive: false,
    }).health,
    "blocked",
  );
  assert.equal(
    deriveHealth({
      missionStatus: "WAITING_FOR_USER",
      blocked: false,
      failed: false,
      complete: false,
      verifiedComplete: false,
      slowAfterMs: 1,
      stallAfterMs: 2,
      now: "2024-01-01T00:00:00Z",
      alive: false,
    }).health,
    "waiting",
  );
});

// ── loop / stall detection ────────────────────────────────────────────────

function tracker(threshold = 4) {
  return new WorkerLoopTracker({
    ...DEFAULT_OBSERVABILITY_CONFIG,
    loopThresholds: { reading_file: threshold, tool_invocation: threshold, error: threshold, default: threshold },
  });
}

test("loop tracker flags repeated identical file reads above threshold", () => {
  const tr = tracker(4);
  for (let i = 0; i < 4; i++) tr.readFile("src/foo.ts");
  assert.equal(tr.hasLoop(), true);
  const signals = tr.signals();
  assert.ok(signals.some((s) => s.kind === "repeated_file_read" && s.count === 4));
});

test("file change resets the repeated-read family", () => {
  const tr = tracker(3);
  for (let i = 0; i < 3; i++) tr.readFile("src/foo.ts");
  assert.equal(tr.hasLoop(), true);
  tr.fileChanged();
  assert.equal(tr.hasLoop(), false);
});

test("distinct reads are not a loop; identical repeated tool calls are", () => {
  const tr = tracker(3);
  tr.readFile("a.ts");
  tr.readFile("b.ts");
  tr.readFile("c.ts");
  assert.equal(tr.hasLoop(), false, "distinct reads are not a loop");
  for (let i = 0; i < 3; i++) tr.toolCall("run:test --watch");
  assert.equal(tr.hasLoop(), true);
});

test("repeated errors cross threshold", () => {
  const tr = tracker(3);
  for (let i = 0; i < 3; i++) tr.error("EADDRINUSE:8080");
  const signals = tr.signals();
  assert.ok(signals.some((s) => s.kind === "repeated_error"));
});

// ── events ────────────────────────────────────────────────────────────────

test("observability event round-trips through the stored shape", () => {
  const ev = newObservabilityEvent({
    missionId: "MSN-1",
    type: "WORKER_ACTIVITY",
    summary: "editing EventDrawer.tsx",
    workerId: "wk-9",
    taskId: "tsk-1",
    metadata: { activityType: "editing_file", file: "EventDrawer.tsx" },
    meaningfulProgress: true,
  });
  const stored = toStoredEvent(ev, storedTypeForEventType(ev.type));
  assert.equal(stored.type, "mission.obs.worker");
  const back = fromStoredEvent(stored);
  assert.ok(back);
  assert.equal(back.missionId, "MSN-1");
  assert.equal(back.workerId, "wk-9");
  assert.equal(back.meaningfulProgress, true);
  assert.equal(back.metadata?.activityType, "editing_file");
});

test("all observability stored types are registered", () => {
  const types = [
    "mission.obs.created",
    "mission.obs.phase",
    "mission.obs.health",
    "mission.obs.task",
    "mission.obs.worker",
    "mission.obs.activity",
    "mission.obs.heartbeat",
    "mission.obs.test",
    "mission.obs.review",
    "mission.obs.recovery",
    "mission.obs.gate",
    "mission.obs.error",
  ];
  for (const ty of types) assert.equal(OBSERVABILITY_EVENT_TYPES.has(ty), true, ty);
});

test("non-observability stored events are ignored by fromStoredEvent", () => {
  const stored = {
    event_id: "e1",
    timestamp: "2024-01-01T00:00:00Z",
    type: "mission.created",
    project_id: null,
    run_id: "MSN",
    worker_id: null,
    payload: {},
  };
  assert.equal(fromStoredEvent(stored as never), null);
});
