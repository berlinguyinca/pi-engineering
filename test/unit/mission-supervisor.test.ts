import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function harness(initialNow = Date.parse("2026-09-27T12:00:00.000Z"), planningInFlight?: () => boolean) {
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
    planningInFlight,
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
  // MissionSupervisor.start() deliberately unrefs its interval so a background
  // monitor never keeps a process alive. The interval tests await work that
  // only that interval performs, so hold the event loop open for each test;
  // otherwise node:test sees a drained loop and cancels the rest of the suite.
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  beforeEach(() => {
    keepAlive = setInterval(() => {}, 60_000);
  });
  afterEach(() => {
    clearInterval(keepAlive);
  });

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

  it("protects fresh-heartbeat workers from STALLED and fences hung workers after the debounce", async () => {
    const start = Date.parse("2026-09-27T12:00:00.000Z");
    const setup = () => {
      const h = harness(start);
      const task = h.store.createTask({
        mission_id: h.mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "active work",
      });
      h.store.transitionTask(task.task_id, "READY");
      const execution = h.store.createExecution({
        task_id: task.task_id,
        backend: "agent",
        mission_id: h.mission.mission_id,
      });
      h.store.transitionTask(task.task_id, "RUNNING", "system", {
        assigned_execution_id: execution.execution_id,
      });
      h.store.setExecutionStatus(execution.execution_id, "RUNNING");
      h.observability.workerStarted(h.mission.mission_id, "worker-1", {
        taskId: task.task_id,
      });
      return h;
    };

    // (a) FRESH-heartbeat protection: worker started at t0, RUNNING execution,
    // and a fresh heartbeat at t0+6min. Meaningful progress is stale but the
    // raw-activity heartbeat is live, so the projection is SLOW (never
    // STALLED), and the RUNNING execution keeps the supervisor from an orphaned
    // fall-through. One tick must not fence the worker.
    {
      const h = setup();
      h.setNow(start + 6 * 60_000);
      h.observability.heartbeat(h.mission.mission_id, "worker-1");

      const [status] = await h.supervisor.tick();

      assert.notEqual(status?.health, "STALLED", "a fresh-heartbeat worker must never be fenced");
      assert.equal(status?.health, "HEALTHY");
    }

    // (b) HUNG-worker fencing: same setup but no fresh heartbeat — the last
    // heartbeat is at t0 (stale by t0+6min). The STALLED projection is
    // debounced: the first tick is not yet STALLED, and the second tick yields
    // STALLED with a durable recovery decision.
    {
      const h = setup();
      h.setNow(start + 6 * 60_000);

      const [first] = await h.supervisor.tick();
      assert.notEqual(first?.health, "STALLED", "a single stale projection is debounced");

      const [second] = await h.supervisor.tick();
      assert.equal(second?.health, "STALLED");
      assert.equal(second?.lastMeaningfulProgressAt, new Date(start).toISOString());
      assert.ok(second?.decision, "stalled status must schedule recovery instead of relabeling only");
    }
  });

  for (const action of ["WAIT_FOR_REQUIREMENT", "PROBE_AND_BACKOFF"] as const) {
    for (const probeDue of [false, true]) {
      it(`recovers a stalled worker despite another task's ${action} wait (probe due: ${probeDue})`, async () => {
        const start = Date.parse("2026-09-27T12:00:00.000Z");
        const h = harness(start);
        const active = h.store.createTask({
          mission_id: h.mission.mission_id,
          kind: "agent",
          role: "implementer",
          objective: "active work",
        });
        h.store.transitionTask(active.task_id, "READY");
        h.store.transitionTask(active.task_id, "RUNNING");
        const waiting = h.store.createTask({
          mission_id: h.mission.mission_id,
          kind: "agent",
          role: "implementer",
          objective: "wait for a dependency",
        });
        h.observability.workerStarted(h.mission.mission_id, "silent", { taskId: active.task_id });
        h.observability.setWaiting(h.mission.mission_id, "repository_lease", "Sibling task waiting for repository");
        const classification = h.store.classifyFailure({
          classificationId: "FC-sibling-wait",
          missionId: h.mission.mission_id,
          taskId: waiting.task_id,
          executionId: null,
          category: "REQUIREMENT_AMBIGUITY",
          evidenceRefs: [],
          fingerprint: "sha256:sibling-wait",
          summary: "waiting for sibling dependency",
          classifiedAt: new Date(start).toISOString(),
        });
        const wait = h.store.planRecovery({
          recoveryId: "RCV-sibling-wait",
          missionId: h.mission.mission_id,
          classificationId: classification.classificationId,
          action,
          expectedMaterialChange: "dependency becomes available",
          attempt: 1,
          maxAttempts: 2,
          deadline: null,
          nextActionAt: new Date(start + (probeDue ? 0 : 60 * 60_000)).toISOString(),
          status: "planned",
          decidedAt: new Date(start).toISOString(),
          failureFingerprint: classification.fingerprint,
        });
        h.setNow(start + 6 * 60_000);

        const [first] = await h.supervisor.tick();
        assert.notEqual(first?.health, "STALLED", "the first stale projection is debounced");
        const [second] = await h.supervisor.tick();

        assert.equal(second?.health, "STALLED");
        assert.ok(second?.decision, "the stalled worker needs a durable recovery decision");
        assert.equal(h.store.getFailureClassification(second.decision.classificationId)?.taskId, active.task_id);
        assert.equal(h.store.getRecoveryDecision(wait.recoveryId)?.status, "planned", "the sibling wait is preserved");
      });
    }
  }

  it("does not recover a worker that is explicitly waiting for capacity", async () => {
    const start = Date.parse("2026-09-27T12:00:00.000Z");
    const h = harness(start);
    const task = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "await inference capacity",
    });
    h.store.transitionTask(task.task_id, "READY");
    h.store.transitionTask(task.task_id, "RUNNING");
    const execution = h.store.createExecution({
      task_id: task.task_id,
      backend: "agent",
      mission_id: h.mission.mission_id,
    });
    h.store.setExecutionStatus(execution.execution_id, "RUNNING");
    h.observability.workerStarted(h.mission.mission_id, "waiting", { taskId: task.task_id });
    h.observability.activity(h.mission.mission_id, {
      type: "waiting_for_queue",
      summary: "Queued for inference capacity",
      workerId: "waiting",
    });
    h.observability.setWaiting(h.mission.mission_id, "repository_lease", "Sibling repository wait");
    h.setNow(start + 24 * 60 * 60_000);

    await h.supervisor.tick();
    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "HEALTHY");
    assert.equal(h.store.listRecoveryDecisions(h.mission.mission_id).length, 0);
    assert.equal(h.observability.summary(h.mission.mission_id)?.health, "waiting");
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

  it("does not call a taskless mission empty while its planner is still running", async () => {
    let planning = true;
    const h = harness(undefined, () => planning);

    const [during] = await h.supervisor.tick();

    assert.equal(during?.health, "HEALTHY");
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).length, 0);
    assert.equal(h.store.listRecoveryDecisions(h.mission.mission_id).length, 0);

    planning = false;
    const [after] = await h.supervisor.tick();
    assert.equal(after?.health, "PLANNING_EMPTY");
  });

  it("plans WAIT_FOR_REQUIREMENT once per episode across repeated ticks", async () => {
    const h = harness();

    await h.supervisor.tick();
    await h.supervisor.tick();
    await Promise.all([h.supervisor.tick(), h.supervisor.tick()]);

    const waits = h.store
      .listRecoveryDecisions(h.mission.mission_id)
      .filter((d) => d.action === "WAIT_FOR_REQUIREMENT");
    assert.equal(waits.length, 1);
  });

  it("preserves a taskless workspace preflight blocker before diagnosing an expired lease", async () => {
    const h = harness();
    const ownership = new MissionOwnership(h.store, { ownerId: "preflight", now: () => 0, leaseMs: 10 });
    await ownership.acquire(h.mission.mission_id);
    h.store.transitionMission(h.mission.mission_id, "BLOCKED");
    h.store.classifyFailure({
      classificationId: "FC-preflight",
      missionId: h.mission.mission_id,
      taskId: null,
      executionId: null,
      category: "WORKSPACE_SCOPE_MISMATCH",
      summary: "workspace root was rejected",
      fingerprint: "preflight",
      evidenceRefs: [],
      classifiedAt: new Date().toISOString(),
    });
    const [status] = await h.supervisor.tick();
    assert.equal(status?.decision?.action, "REBUILD_WORKSPACE_MANIFEST");
    assert.match(status?.reason ?? "", /workspace root was rejected/);
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).at(-1)?.category, "WORKSPACE_SCOPE_MISMATCH");
  });

  it("names planning that produced no tasks as an operator question, not an orphan stop", async () => {
    const h = harness();

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "PLANNING_EMPTY");
    assert.match(status?.reason ?? "", /planning produced no tasks/i);
    assert.equal(status?.decision?.action, "WAIT_FOR_REQUIREMENT");
    assert.equal(h.store.listMissionStops(h.mission.mission_id).length, 0, "asking the operator is not a stop");
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).at(-1)?.category, "REQUIREMENT_AMBIGUITY");
  });

  it("requeues the first failed task when every task is terminal", async () => {
    const h = harness();
    const failed = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement the change",
      repo_id: "repo-1",
    });
    h.store.transitionTask(failed.task_id, "READY");
    h.store.transitionTask(failed.task_id, "RUNNING");
    h.store.transitionTask(failed.task_id, "FAILED", "system", {
      failure_reason: "Worker failed after 5 attempt(s): Connection error.",
    });
    const gate = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate the candidate",
      depends_on: [failed.task_id],
      repo_id: "repo-1",
    });
    h.store.transitionTask(gate.task_id, "READY");
    h.store.transitionTask(gate.task_id, "FAILED", "system", { failure_reason: "no candidate to validate" });

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "REPAIR_REQUIRED");
    assert.equal(status?.task, failed.task_id, "the repair names the task to replace, not the mission");
    // A connection drop is a gateway saturation signature (issue #112): the
    // supervisor waits it out and re-dispatches — it does NOT hire another
    // implementer to hit the same saturated gateway.
    assert.equal(status?.decision?.action, "PROBE_AND_BACKOFF");
    assert.match(status?.reason ?? "", /Connection error/);
    assert.equal(h.store.listMissionStops(h.mission.mission_id).length, 0, "a requeue is not a stop");
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).at(-1)?.category, "PROVIDER_TRANSIENT");
  });

  it("classifies a 400 backpressure failure as a capacity wait, never an implementation defect (MSN-MypLoa)", async () => {
    const h = harness();
    const failed = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement the change",
      repo_id: "repo-1",
    });
    h.store.transitionTask(failed.task_id, "READY");
    h.store.transitionTask(failed.task_id, "RUNNING");
    h.store.transitionTask(failed.task_id, "FAILED", "system", {
      failure_reason:
        'backend reported failed: Model gateway refused the request after 0 honoured wait(s): 400: {"action":"fix_request","action_code":"IW-ACT-FIX-REQUEST","code":"upstream_error","message":"Correct the request syntax, parameters, endpoint, or model identity.","reason":"upstream_error","replay_safe":false,"request_state":"unknown","retryable":false,"scope":"request","type":"inferweave_backpressure"}',
    });

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "REPAIR_REQUIRED");
    assert.equal(status?.task, failed.task_id);
    // The exact regression: the envelope was blanket-labeled IMPLEMENTATION_DEFECT,
    // which burned the CREATE_REPAIR_TASKS budget re-issuing the same doomed
    // request until the mission stalled. It must park as a capacity wait.
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).at(-1)?.category, "PROVIDER_TRANSIENT");
    assert.equal(status?.decision?.action, "PROBE_AND_BACKOFF");
    assert.equal(h.store.listMissionStops(h.mission.mission_id).length, 0, "a capacity wait is not a stop");
  });

  it("keeps a genuine code failure an implementation defect", async () => {
    const h = harness();
    const failed = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement the change",
      repo_id: "repo-1",
    });
    h.store.transitionTask(failed.task_id, "READY");
    h.store.transitionTask(failed.task_id, "RUNNING");
    h.store.transitionTask(failed.task_id, "FAILED", "system", {
      failure_reason: "backend reported failed: worker exited with code 1 without a result",
    });

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "REPAIR_REQUIRED");
    assert.equal(h.store.listFailureClassifications(h.mission.mission_id).at(-1)?.category, "IMPLEMENTATION_DEFECT");
    assert.equal(status?.decision?.action, "CREATE_REPAIR_TASKS");
  });

  it("falls back to the execution outcome when a failed task recorded no reason", async () => {
    const h = harness();
    const failed = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement the change",
      repo_id: "repo-1",
    });
    h.store.transitionTask(failed.task_id, "READY");
    const execution = h.store.createExecution({
      task_id: failed.task_id,
      backend: "agent",
      mission_id: h.mission.mission_id,
    });
    h.store.transitionTask(failed.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
    h.store.setExecutionStatus(execution.execution_id, "FAILED", { exit_status: "connection_closed" });
    h.store.transitionTask(failed.task_id, "FAILED");

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "REPAIR_REQUIRED");
    assert.match(status?.reason ?? "", new RegExp(`execution ${execution.execution_id} ended connection_closed`));
    assert.doesNotMatch(status?.reason ?? "", /no reason recorded/);
  });

  it("keeps fencing a genuinely ownerless running task as an orphaned execution", async () => {
    const h = harness();
    const task = h.store.createTask({
      mission_id: h.mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "work with no worker",
      repo_id: "repo-1",
    });
    h.store.transitionTask(task.task_id, "READY");
    const execution = h.store.createExecution({
      task_id: task.task_id,
      backend: "agent",
      mission_id: h.mission.mission_id,
    });
    h.store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
    h.store.setExecutionStatus(execution.execution_id, "FAILED", { exit_status: "connection_closed" });

    const [status] = await h.supervisor.tick();

    assert.equal(status?.health, "ORPHANED");
    assert.equal(status?.decision?.action, "FENCE_RECONCILE_AND_RESUME");
  });
});
