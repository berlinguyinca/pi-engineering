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

  it("treats an interval tick invalidated by resume as cancellation without an unhandled rejection", async () => {
    const h = harness();
    const originalFlush = h.store.flush.bind(h.store);
    let releaseFlush!: () => void;
    let flushEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      flushEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let blocked = false;
    h.store.flush = async () => {
      if (!blocked) {
        blocked = true;
        flushEntered();
        await gate;
      }
      await originalFlush();
    };
    const supervisor = new MissionSupervisor({
      store: h.store,
      observability: h.observability,
      intervalMs: 1,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      supervisor.start();
      await entered;
      supervisor.stop();
      h.store.resumeMission(h.mission.mission_id, "invalidate blocked interval tick");
      releaseFlush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.deepEqual(supervisor.diagnostics(), []);
    } finally {
      supervisor.stop();
      releaseFlush();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("surfaces unexpected interval tick failures through diagnostics and the error callback", async () => {
    const h = harness();
    let supervisor!: MissionSupervisor;
    const reported = new Promise<{ message: string }>((resolve) => {
      supervisor = new MissionSupervisor({
        store: h.store,
        observability: h.observability,
        intervalMs: 1,
        onError: resolve,
      });
      h.store.flush = async () => {
        supervisor.stop();
        throw new Error("injected interval failure");
      };
      supervisor.start();
    });

    const diagnostic = await reported;
    assert.match(diagnostic.message, /injected interval failure/);
    assert.match(supervisor.diagnostics()[0]?.message ?? "", /injected interval failure/);
  });

  it("captures an async error callback rejection without emitting an unhandled rejection", async () => {
    const h = harness();
    let callbackInvoked!: () => void;
    const invoked = new Promise<void>((resolve) => {
      callbackInvoked = resolve;
    });
    const supervisor = new MissionSupervisor({
      store: h.store,
      observability: h.observability,
      intervalMs: 1,
      onError: async () => {
        callbackInvoked();
        throw new Error("async callback failure");
      },
    });
    h.store.flush = async () => {
      supervisor.stop();
      throw new Error("injected interval failure");
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      supervisor.start();
      await invoked;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(unhandled, []);
      assert.deepEqual(supervisor.diagnostics(), [
        {
          occurredAt: supervisor.diagnostics()[0]?.occurredAt,
          name: "Error",
          message: "injected interval failure",
          callbackFailure: {
            occurredAt: supervisor.diagnostics()[0]?.callbackFailure?.occurredAt,
            name: "Error",
            message: "async callback failure",
          },
        },
      ]);
    } finally {
      supervisor.stop();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("caps overlapping interval failures as atomic incidents with their async callback failures", async () => {
    const h = harness();
    const failureCount = 125;
    let releaseCallbacks!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallbacks = resolve;
    });
    let callbackCount = 0;
    let reachedFailureCount!: () => void;
    const allCallbacksStarted = new Promise<void>((resolve) => {
      reachedFailureCount = resolve;
    });
    let flushCount = 0;
    let supervisor!: MissionSupervisor;
    supervisor = new MissionSupervisor({
      store: h.store,
      observability: h.observability,
      intervalMs: 1,
      onError: async (diagnostic) => {
        callbackCount++;
        if (callbackCount === failureCount) {
          supervisor.stop();
          reachedFailureCount();
        }
        await callbackGate;
        throw new Error(`callback rejected for ${diagnostic.message}`);
      },
    });
    h.store.flush = async () => {
      throw new Error(`tick root failure ${++flushCount}`);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      supervisor.start();
      await allCallbacksStarted;
      releaseCallbacks();
      for (
        let attempt = 0;
        attempt < 100 &&
        (supervisor.diagnostics().length < 100 ||
          supervisor.diagnostics().some((diagnostic) => !diagnostic.callbackFailure));
        attempt++
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const diagnostics = supervisor.diagnostics();
      assert.deepEqual(unhandled, []);
      assert.equal(diagnostics.length, 100, "incident cap remains bounded under a failure storm");
      for (const diagnostic of diagnostics) {
        assert.match(diagnostic.message, /^tick root failure \d+$/, "retained incident keeps the tick root cause");
        assert.match(
          diagnostic.callbackFailure?.message ?? "",
          /^callback rejected for tick root failure \d+$/,
          "retained incident keeps the corresponding callback failure",
        );
        assert.equal(
          diagnostic.callbackFailure?.message,
          `callback rejected for ${diagnostic.message}`,
          "root and callback details belong to the same incident",
        );
      }
    } finally {
      supervisor.stop();
      releaseCallbacks();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("shutdown blocks new ticks and drains an active status consumer before resolving", async () => {
    const h = harness();
    const task = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "drain before shutdown",
    });
    h.store.transitionTask(task.task_id, "READY");
    let entered!: () => void;
    let release!: () => void;
    const consumerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const consumerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const supervisor = new MissionSupervisor({
      store: h.store,
      observability: h.observability,
      onStatuses: async () => {
        entered();
        await consumerGate;
      },
    });

    const tick = supervisor.tick();
    await consumerEntered;
    const shutdown = supervisor.shutdown();
    let shutdownSettled = false;
    void shutdown.finally(() => {
      shutdownSettled = true;
    });

    await assert.rejects(supervisor.tick(), /shutting down/i);
    assert.equal(shutdownSettled, false, "shutdown must wait for the active consumer");
    release();
    await tick;
    await shutdown;
    assert.equal(shutdownSettled, true);
  });
});
