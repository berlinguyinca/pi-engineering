/**
 * Tests for the additive mission-snapshot contract: the observability
 * section is emitted when present, absent for legacy publishers, and the base
 * mission/task/finding shape is unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { latestTaskCheckpoints } from "../../src/orchestration/checkpoints.ts";
import {
  MISSION_SNAPSHOT_CONTRACT_VERSION,
  buildMissionSnapshotFile,
} from "../../src/orchestration/missionSnapshot.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { attentionFromSummary } from "../../src/orchestration/observability/attention.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import type { TaskCheckpoint } from "../../src/orchestration/types.ts";
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

function checkpoint(overrides: Partial<TaskCheckpoint> & Pick<TaskCheckpoint, "checkpointId">): TaskCheckpoint {
  return {
    executionId: "EXE-default",
    missionId: "MSN-checkpoints",
    taskId: "TSK-checkpoints",
    repoId: "repo-1",
    baseSha: "base",
    candidateSha: null,
    branch: null,
    worktree: null,
    committedChanges: [],
    preservedUncommittedChanges: [],
    completedDeliverables: [],
    remainingDeliverables: [],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: [],
    artifactHashes: [],
    workerId: null,
    sessionId: null,
    model: null,
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-09-27T12:00:00.000Z",
    ...overrides,
  };
}

test("latest checkpoints use cross-execution chronology and durable order instead of unrelated sequence", () => {
  const oldExecution = checkpoint({
    checkpointId: "CHK-old-execution",
    executionId: "EXE-old",
    sequence: 5,
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  const recoveryExecution = checkpoint({
    checkpointId: "CHK-recovery",
    executionId: "EXE-recovery",
    sequence: 1,
    createdAt: "2026-09-27T12:01:00.000Z",
  });
  assert.equal(latestTaskCheckpoints([oldExecution, recoveryExecution])[0]?.checkpointId, "CHK-recovery");

  const sameTimeLaterEvent = checkpoint({
    checkpointId: "CHK-same-time-later-event",
    executionId: "EXE-later",
    sequence: 0,
    createdAt: recoveryExecution.createdAt,
  });
  const durableOrder = [oldExecution, recoveryExecution, sameTimeLaterEvent];
  assert.equal(latestTaskCheckpoints(durableOrder)[0]?.checkpointId, "CHK-same-time-later-event");
  assert.equal(
    latestTaskCheckpoints(structuredClone(durableOrder))[0]?.checkpointId,
    "CHK-same-time-later-event",
    "replay of the same durable event order selects the same checkpoint",
  );
});

test("equal-time checkpoint lineage updates retain durable event order live and after reopen", async () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const m = mission(store, "Durably ordered checkpoints");
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(m.mission_id, status);
  }
  const task = store.createTask({
    task_id: "TSK-checkpoint-order",
    mission_id: m.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "retain the newest lineage event",
  });
  store.checkpointTask(
    checkpoint({
      checkpointId: "CHK-A",
      executionId: "EXE-A",
      missionId: m.mission_id,
      taskId: task.task_id,
      artifactRefs: ["artifact://A1"],
      sequence: 1,
    }),
  );
  store.checkpointTask(
    checkpoint({
      checkpointId: "CHK-B",
      executionId: "EXE-B",
      missionId: m.mission_id,
      taskId: task.task_id,
      artifactRefs: ["artifact://B1"],
      sequence: 1,
    }),
  );
  store.checkpointTask(
    checkpoint({
      checkpointId: "CHK-A",
      executionId: "EXE-A",
      missionId: m.mission_id,
      taskId: task.task_id,
      artifactRefs: ["artifact://A2"],
      sequence: 2,
    }),
  );
  const observability = new MissionObservability({ backend, store });
  observability.missionCreated(m.mission_id, m.title);
  await observability.flush();

  assert.equal(latestTaskCheckpoints(store.listTaskCheckpoints(m.mission_id))[0]?.artifactRefs[0], "artifact://A2");
  assert.deepEqual(observability.projection(m.mission_id)?.summary.preservedWork, ["artifact://A2"]);
  const [liveStatus] = await new MissionSupervisor({ store, observability }).tick(m.mission_id);
  assert.deepEqual(liveStatus?.preservedWork, ["artifact://A2"]);

  await observability.flush();
  const reopenedStore = MissionStore.open(backend);
  const reopenedObservability = MissionObservability.open({ backend, store: reopenedStore });
  assert.equal(
    latestTaskCheckpoints(reopenedStore.listTaskCheckpoints(m.mission_id))[0]?.artifactRefs[0],
    "artifact://A2",
  );
  assert.deepEqual(reopenedObservability.projection(m.mission_id)?.summary.preservedWork, ["artifact://A2"]);
  const [reopenedStatus] = await new MissionSupervisor({
    store: reopenedStore,
    observability: reopenedObservability,
  }).tick(m.mission_id);
  assert.deepEqual(reopenedStatus?.preservedWork, ["artifact://A2"]);
});

test("snapshot contract remains additive after the reliability bump", async () => {
  assert.equal(MISSION_SNAPSHOT_CONTRACT_VERSION, 3);
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const m = mission(store, "M");
  const t = store.createTask({
    mission_id: m.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "O",
  });
  const file = buildMissionSnapshotFile([
    {
      mission: m,
      tasks: store.listTasks(m.mission_id),
      findings: [],
      observability: null,
    },
  ]);
  const snap = file.missions[0]!;
  assert.equal(snap.observability, undefined, "null projection yields no observability section");
  assert.equal(snap.id, m.mission_id);
  assert.equal(snap.tasks[0]!.id, t.task_id, "base task shape unchanged");
  assert.equal(file.contractVersion, 3);
});

test("snapshot includes full observability section when projection present", async () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const updates: string[] = [];
  const obs = new MissionObservability({
    backend,
    store,
    onUpdate: (_i, m) => updates.push(m),
  });
  const m = mission(store, "AIMS Console Refactor");
  obs.missionCreated(m.mission_id, "AIMS Console Refactor");
  const t = store.createTask({
    mission_id: m.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "Implement EventDrawer",
  });
  obs.workerStarted(m.mission_id, "wk-1", {
    taskId: t.task_id,
    model: "claude",
  });
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
    {
      mission: m,
      tasks: store.listTasks(m.mission_id),
      findings: [],
      observability: proj,
    },
  ]);
  const ob = file.missions[0]!.observability!;
  assert.ok(ob, "observability section present");
  assert.ok(ob.progress.approximatePercent >= 0 && ob.progress.approximatePercent < 100);
  assert.equal(ob.progress.basis, "weighted_dag");
  assert.ok(ob.acceptanceCoverage);
  assert.ok(ob.workflowProgress);
  assert.equal(typeof ob.action, "string");
  assert.equal(typeof ob.reason, "string");
  assert.equal(typeof ob.recoveryAttempt.attempt, "number");
  assert.equal(typeof ob.recoveryAttempt.maxAttempts, "number");
  assert.equal(typeof ob.nextAction, "string");
  assert.ok("nextActionAt" in ob);
  assert.ok("owner" in ob);
  assert.ok("repository" in ob);
  assert.ok("task" in ob);
  assert.ok(Array.isArray(ob.preservedWork));
  assert.equal(ob.currentActivity?.summary, "editing EventDrawer.tsx");
  assert.equal(ob.workers.active, 1);
  assert.equal(ob.workerDetails[0]!.model, "claude");
  assert.equal(ob.tests.completed, 34);
  assert.equal(ob.tests.total, 40);
  assert.ok(ob.progressHistory.length >= 1);
  assert.equal(ob.review.blockingOpen, 0);
});

test("snapshot writes nullable timing fields and combines checkpoint and stopped work during recovery", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const obs = new MissionObservability({ backend, store });
  const m = mission(store, "Recoverable mission");
  obs.missionCreated(m.mission_id, m.title);
  const task = store.createTask({
    task_id: "TSK-preserved",
    mission_id: m.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "preserve work",
    repo_id: "repo-1",
  });
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: m.mission_id,
    backend: "agent",
  });
  store.checkpointTask({
    checkpointId: "CHK-preserved",
    executionId: execution.execution_id,
    missionId: m.mission_id,
    taskId: task.task_id,
    repoId: "repo-1",
    baseSha: "base",
    candidateSha: "candidate",
    branch: "branch-preserved",
    worktree: "/tmp/worktree-preserved",
    committedChanges: ["commit-preserved"],
    preservedUncommittedChanges: ["artifact://dirty.patch"],
    completedDeliverables: [],
    remainingDeliverables: ["finish"],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: ["artifact://checkpoint"],
    artifactHashes: [],
    workerId: null,
    sessionId: null,
    model: null,
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  store.stopMission(m.mission_id, {
    reason: "operator input required",
    preservedWork: ["artifact://stopped-work"],
    attemptedRecoveries: [],
    resumeCondition: "provide input",
  });
  store.resumeMission(m.mission_id, "input arrived", "operator");
  const classification = store.classifyFailure({
    classificationId: "FC-recovery",
    missionId: m.mission_id,
    taskId: task.task_id,
    executionId: null,
    category: "ORPHANED_EXECUTION",
    evidenceRefs: [],
    fingerprint: "sha256:ongoing",
    summary: "ongoing recovery",
    classifiedAt: "2026-09-27T12:00:01.000Z",
  });
  store.planRecovery({
    recoveryId: "RCV-ongoing",
    missionId: m.mission_id,
    classificationId: classification.classificationId,
    action: "FENCE_RECONCILE_AND_RESUME",
    expectedMaterialChange: "resume preserved work",
    attempt: 1,
    maxAttempts: 2,
    deadline: "2026-09-27T12:10:00.000Z",
    nextActionAt: "2026-09-27T12:01:00.000Z",
    status: "planned",
    decidedAt: "2026-09-27T12:00:01.000Z",
    resumptionGeneration: 1,
  });

  const projection = obs.projection(m.mission_id)!;
  const snapshot = buildMissionSnapshotFile([{ mission: m, tasks: [task], findings: [], observability: projection }])
    .missions[0]!.observability!;

  assert.equal(snapshot.lastMeaningfulProgressAt, null);
  assert.equal(snapshot.nextActionAt, "2026-09-27T12:01:00.000Z");
  assert.ok(snapshot.preservedWork.includes("/tmp/worktree-preserved"));
  assert.ok(snapshot.preservedWork.includes("branch-preserved"));
  assert.ok(snapshot.preservedWork.includes("artifact://stopped-work"));
});

test("snapshot includes timestamps needed for clients to animate mission activity without new writes", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const obs = new MissionObservability({ backend, store });
  const m = mission(store, "live snapshot");
  obs.missionCreated(m.mission_id, m.title);
  const projection = obs.projection(m.mission_id)!;
  projection.summary.waitingSince = "2026-10-20T12:00:00Z";
  projection.workers = [
    {
      workerId: "worker",
      state: "running",
      lastOutputAt: "2026-10-20T12:00:05Z",
      currentActivityStartedAt: "2026-10-20T12:00:02Z",
      repeatedFileReads: 0,
      repeatedToolCalls: 0,
      repeatedErrors: 0,
      repeatedCycles: 0,
    },
  ];
  projection.summary.currentActivity = { type: "running_command", summary: "running tests", workerId: "worker" };
  const snapshot = buildMissionSnapshotFile([{ mission: m, tasks: [], findings: [], observability: projection }])
    .missions[0]!.observability!;
  assert.equal(snapshot.waitingSince, "2026-10-20T12:00:00Z");
  assert.equal(snapshot.lastOutputAt, "2026-10-20T12:00:05Z");
  assert.equal(snapshot.currentActivityStartedAt, "2026-10-20T12:00:02Z");
});

function parkedAtCap(store: MissionStore, missionId: string, resumptionGeneration: number) {
  const classification = store.classifyFailure({
    classificationId: `FC-cap-${resumptionGeneration}`,
    missionId,
    taskId: null,
    executionId: null,
    category: "PROVIDER_TRANSIENT",
    evidenceRefs: [],
    fingerprint: "sha256:cap",
    summary: "gateway returned 503",
    classifiedAt: "2026-10-27T12:00:00.000Z",
  });
  store.planRecovery({
    recoveryId: `RCV-cap-${resumptionGeneration}`,
    missionId,
    classificationId: classification.classificationId,
    action: "PROBE_AND_BACKOFF",
    expectedMaterialChange: "probe the gateway",
    attempt: 9,
    maxAttempts: 8,
    deadline: null,
    nextActionAt: "2026-10-27T12:05:00.000Z",
    status: "planned",
    decidedAt: "2026-10-27T12:00:00.000Z",
    ...(resumptionGeneration > 0 ? { resumptionGeneration } : {}),
  });
}

test("a durably stopped mission at the cap keeps recovery_exhausted, a live park says it resumes", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const obs = new MissionObservability({ backend, store });
  const m = mission(store, "Parked then stopped");
  obs.missionCreated(m.mission_id, m.title);
  const now = Date.parse("2026-10-27T12:01:00.000Z");
  parkedAtCap(store, m.mission_id, 0);

  const live = attentionFromSummary(obs.projection(m.mission_id)!.summary, { now });
  assert.equal(live?.evidence[0]?.kind, "capacity_wait");
  assert.match(live!.reason, /resumes once the gateway probe succeeds/);

  store.stopMission(m.mission_id, {
    reason: "gate repair refused",
    preservedWork: [],
    attemptedRecoveries: [],
    resumeCondition: "cancel the mission",
  });
  const stopped = obs.projection(m.mission_id)!.summary;
  assert.equal(stopped.action, "STOP");
  const attention = attentionFromSummary(stopped, { now });
  assert.equal(attention?.evidence[0]?.kind, "recovery_exhausted");
  assert.doesNotMatch(attention!.reason, /resume automatically/);

  // An operator resume starts a new generation; a fresh park there is live again.
  store.resumeMission(m.mission_id, "operator resumed", "operator");
  parkedAtCap(store, m.mission_id, 1);
  const resumed = attentionFromSummary(obs.projection(m.mission_id)!.summary, { now });
  assert.equal(resumed?.evidence[0]?.kind, "capacity_wait");
});

test("the wait category comes from the classification behind the current decision, not the newest one", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const obs = new MissionObservability({ backend, store });
  const m = mission(store, "Newer unrelated classification");
  obs.missionCreated(m.mission_id, m.title);
  const now = Date.parse("2026-10-27T12:01:00.000Z");
  parkedAtCap(store, m.mission_id, 0);
  store.classifyFailure({
    classificationId: "FC-disk",
    missionId: m.mission_id,
    taskId: null,
    executionId: null,
    category: "DISK_SUSPENDED",
    evidenceRefs: [],
    fingerprint: "sha256:disk",
    summary: "disk full",
    classifiedAt: "2026-10-27T12:00:30.000Z",
  });

  const summary = obs.projection(m.mission_id)!.summary;
  assert.equal(summary.failureCategory, "PROVIDER_TRANSIENT");
  const attention = attentionFromSummary(summary, { now });
  assert.match(attention!.reason, /^waiting for capacity: probe 9/);
  assert.doesNotMatch(attention!.reason, /disk/);
  // The summary reason must come from the same classification as the lead.
  assert.equal(summary.reason, "gateway returned 503");
});

test("no current-generation recovery means no failureCategory", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const obs = new MissionObservability({ backend, store });
  const m = mission(store, "Resumed generation");
  obs.missionCreated(m.mission_id, m.title);
  parkedAtCap(store, m.mission_id, 0);
  store.stopMission(m.mission_id, {
    reason: "operator input required",
    preservedWork: [],
    attemptedRecoveries: [],
    resumeCondition: "provide input",
  });
  store.resumeMission(m.mission_id, "input arrived", "operator");

  assert.equal(obs.projection(m.mission_id)!.summary.failureCategory, undefined);
});
