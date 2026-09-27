import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
