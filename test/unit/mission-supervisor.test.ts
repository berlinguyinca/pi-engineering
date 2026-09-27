import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function harness(initialNow = Date.parse("2026-09-27T12:00:00.000Z")) {
  let currentNow = initialNow;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "supervised mission",
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
  const observability = new MissionObservability({
    backend,
    store,
    now: () => new Date(currentNow).toISOString(),
    config: { slowAfterMs: 120_000, stallAfterMs: 300_000 },
  });
  observability.missionCreated(mission.mission_id, mission.title);
  const supervisor = new MissionSupervisor({
    store,
    observability,
    now: () => currentNow,
  });
  return {
    backend,
    store,
    mission,
    observability,
    supervisor,
    setNow(value: number) {
      currentNow = value;
    },
  };
}

describe("MissionSupervisor", () => {
  it("schedules durable orphan recovery for zero-worker runnable work", async () => {
    const h = harness();
    const task = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "runnable work",
      repo_id: "repo-1",
    });
    h.store.transitionTask(task.task_id, "READY");

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "ORPHANED");
    assert.equal(status?.decision?.action, "FENCE_RECONCILE_AND_RESUME");
    assert.equal(h.store.listRecoveryDecisions(h.mission.mission_id).length, 1);
    assert.equal(status?.task, task.task_id);
  });

  it("schedules durable deadlock repair when dependencies cannot become runnable", async () => {
    const h = harness();
    h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "blocked by missing predecessor",
      depends_on: ["TSK-missing"],
    });

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "DEADLOCKED");
    assert.equal(status?.decision?.action, "REPAIR_BLOCKED_MISSION");
  });

  it("treats transitive successful supersession leaves as satisfied dependencies", async () => {
    const h = harness();
    const original = h.store.createTask({
      task_id: "TSK-original",
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "original work",
      repo_id: "repo-1",
    });
    h.store.transitionTask(original.task_id, "READY");
    h.store.transitionTask(original.task_id, "RUNNING");
    h.store.transitionTask(original.task_id, "FAILED");
    const firstReplacement = h.store.createTask({
      task_id: "TSK-replacement-1",
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "first replacement",
      repo_id: "repo-1",
    });
    h.store.transitionTask(firstReplacement.task_id, "READY");
    h.store.transitionTask(firstReplacement.task_id, "RUNNING");
    h.store.transitionTask(firstReplacement.task_id, "FAILED");
    h.store.supersedeTask({
      supersessionId: "SUP-original",
      missionId: h.mission.mission_id,
      failedTaskId: original.task_id,
      replacementTaskIds: [firstReplacement.task_id],
      repoId: "repo-1",
      acceptanceIds: [],
      coverageFingerprint: taskCoverageFingerprint(original),
      reason: "replace original",
      createdAt: "2026-09-27T12:00:00.000Z",
    });
    const leaf = h.store.createTask({
      task_id: "TSK-replacement-2",
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "successful leaf",
      repo_id: "repo-1",
    });
    h.store.transitionTask(leaf.task_id, "READY");
    h.store.transitionTask(leaf.task_id, "RUNNING");
    h.store.transitionTask(leaf.task_id, "SUCCEEDED");
    h.store.supersedeTask({
      supersessionId: "SUP-replacement",
      missionId: h.mission.mission_id,
      failedTaskId: firstReplacement.task_id,
      replacementTaskIds: [leaf.task_id],
      repoId: "repo-1",
      acceptanceIds: [],
      coverageFingerprint: taskCoverageFingerprint(firstReplacement),
      reason: "replace failed replacement",
      createdAt: "2026-09-27T12:00:01.000Z",
    });
    const dependent = h.store.createTask({
      task_id: "TSK-dependent",
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "depends on recovered work",
      depends_on: [original.task_id],
      repo_id: "repo-1",
    });
    h.store.transitionTask(dependent.task_id, "READY");

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "ORPHANED");
    assert.equal(status?.task, dependent.task_id);
    assert.equal(status?.decision?.action, "FENCE_RECONCILE_AND_RESUME");
  });

  it("detects an expired controller lease independently of worker events", async () => {
    let clock = Date.parse("2026-09-27T12:00:00.000Z");
    const h = harness(clock);
    const ownership = new MissionOwnership(h.store, {
      ownerId: "controller-a",
      leaseMs: 1_000,
      heartbeatMs: 100,
      now: () => clock,
    });
    await ownership.acquire(h.mission.mission_id);
    clock += 1_001;
    h.setNow(clock);

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "CONTROLLER_DISCONNECTED");
    assert.match(status?.reason ?? "", /controller.*expired/i);
    assert.ok(status?.decision);
  });

  it("treats heartbeat as liveness while meaningful-progress age drives STALLED recovery", async () => {
    const start = Date.parse("2026-09-27T12:00:00.000Z");
    const h = harness(start);
    h.observability.workerStarted(h.mission.mission_id, "worker-1");
    h.setNow(start + 6 * 60_000);
    h.observability.heartbeat(h.mission.mission_id, "worker-1");

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "STALLED");
    assert.equal(status?.lastMeaningfulProgressAt, new Date(start).toISOString());
    assert.ok(status?.decision, "stalled status must schedule recovery instead of relabeling only");
  });

  it("turns a named wait past its deadline into an actionable stop", async () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    const h = harness(now);
    const classification = h.store.classifyFailure({
      classificationId: "FC-wait",
      missionId: h.mission.mission_id,
      taskId: null,
      executionId: null,
      category: "REQUIREMENT_AMBIGUITY",
      evidenceRefs: [],
      fingerprint: "sha256:wait",
      summary: "waiting for the named API contract",
      classifiedAt: new Date(now - 10_000).toISOString(),
    });
    h.store.planRecovery({
      recoveryId: "RCV-wait",
      missionId: h.mission.mission_id,
      classificationId: classification.classificationId,
      action: "WAIT_FOR_REQUIREMENT",
      expectedMaterialChange: "receive the API contract",
      attempt: 1,
      maxAttempts: 2,
      deadline: new Date(now - 1).toISOString(),
      nextActionAt: new Date(now - 1).toISOString(),
      status: "planned",
      decidedAt: new Date(now - 10_000).toISOString(),
      failureFingerprint: classification.fingerprint,
    });

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "EXPIRED_WAIT");
    assert.equal(status?.decision?.action, "STOP");
    assert.equal(h.store.listMissionStops(h.mission.mission_id).length, 1);
    assert.match(status?.nextAction ?? "", /resume/i);
  });

  it("reconciles before dispatch and repeated ticks are idempotent", async () => {
    const h = harness();
    const task = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "startup work",
    });
    h.store.transitionTask(task.task_id, "READY");
    let observedDecisions = 0;

    await h.supervisor.reconcileOnStartup(async () => {
      observedDecisions = h.store.listRecoveryDecisions(h.mission.mission_id).length;
    });
    await h.supervisor.tick();

    assert.equal(observedDecisions, 1, "startup reconciliation must durably schedule recovery before dispatch");
    assert.equal(h.store.listRecoveryDecisions(h.mission.mission_id).length, 1);
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).length, 1);
  });

  it("durably recovers an executing mission with zero tasks instead of reporting healthy", async () => {
    const h = harness();

    const [status] = await h.supervisor.tick();

    assert.notEqual(status?.health, "HEALTHY");
    assert.notEqual(status?.action, "MONITOR");
    assert.ok(status?.decision ?? h.store.listMissionStops(h.mission.mission_id).at(-1));
  });

  it("keeps concurrent targeted ticks scoped to their requested missions", async () => {
    const h = harness();
    const second = h.store.createMission({
      title: "second mission",
      goal: "finish second",
      user_request: "finish second",
      repository: "/repo",
      base_ref: "main",
      risk_profile: "medium",
      workflow_class: "engineering",
    });
    for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
      h.store.transitionMission(second.mission_id, status);
    }

    const [firstStatuses, secondStatuses] = await Promise.all([
      h.supervisor.tick(h.mission.mission_id),
      h.supervisor.tick(second.mission_id),
    ]);

    assert.deepEqual(
      firstStatuses.map((status) => status.missionId),
      [h.mission.mission_id],
    );
    assert.deepEqual(
      secondStatuses.map((status) => status.missionId),
      [second.mission_id],
    );
  });

  it("does not let a startup tick for a new resumption reuse an in-flight stale decision", async () => {
    const h = harness();
    const task = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "generation-scoped work",
    });
    h.store.transitionTask(task.task_id, "READY");
    const originalFlush = h.store.flush.bind(h.store);
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let flushes = 0;
    h.store.flush = async () => {
      if (flushes++ === 0) {
        firstEntered();
        await gate;
      }
      await originalFlush();
    };

    const stale = h.supervisor.tick(h.mission.mission_id);
    await firstBlocked;
    h.store.resumeMission(h.mission.mission_id, "new supervisor generation");
    let dispatched = 0;
    const current = h.supervisor.reconcileOnStartup(() => {
      dispatched++;
    });
    releaseFirst();

    await assert.rejects(stale, /stale supervisor resumption/i);
    const [currentStatus] = await current;
    assert.equal(dispatched, 1);
    assert.equal(currentStatus?.decision?.resumptionGeneration, 1);
    const decisions = h.store.listRecoveryDecisions(h.mission.mission_id);
    assert.deepEqual(
      decisions.map((decision) => decision.resumptionGeneration),
      [0, 1],
    );
    assert.notEqual(decisions[0]?.recoveryId, decisions[1]?.recoveryId);
  });
});
