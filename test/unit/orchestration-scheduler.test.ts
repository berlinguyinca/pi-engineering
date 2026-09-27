import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership, type OwnershipIdentity } from "../../src/orchestration/ownership.ts";
import { MissionScheduler, classifyFailure, domainsOverlap } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { GatewayResilienceConfig } from "../../src/resilience/config.ts";

const cancellationResilience: GatewayResilienceConfig = {
  retry_window_ms: 60_000,
  probe_interval_ms: 1_000,
  request_timeout_ms: 120_000,
  connect_timeout_ms: 10_000,
  jitter_ms: 0,
  circuit_breaker_threshold: 99,
  retry_transient_errors: true,
  preserve_mission_on_exhaustion: true,
  auto_resume_on_recovery: true,
};

function transientInfrastructureOutcome() {
  return {
    executionId: "e",
    exitStatus: "failed" as const,
    summary: "gateway unavailable",
    artifactRefs: [],
    usage: {},
    error: "transient:server_unavailable",
  };
}

/** Deterministic overlap barrier (see dag-parallel/blackhole tests). */
function parallelBarrier(needed: number, timeoutMs = 5000): { arrived: () => Promise<void> } {
  let count = 0;
  let release: () => void;
  let settled = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      release();
    }
  }, timeoutMs);
  return {
    async arrived() {
      count++;
      if (count >= needed && !settled) {
        settled = true;
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

function makeBroker(store: MissionStore, backends: BrokerBackends) {
  return new ExecutionBroker({ store, backends });
}

function createExecutingMission(store: MissionStore) {
  const mission = store.createMission({
    title: "concurrency limits",
    goal: "concurrency limits",
    user_request: "concurrency limits",
    repository: ".",
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.transitionMission(mission.mission_id, "CLASSIFYING");
  store.transitionMission(mission.mission_id, "PLANNING");
  store.transitionMission(mission.mission_id, "READY");
  store.transitionMission(mission.mission_id, "EXECUTING");
  return mission;
}

function delayedConcurrencyTracker(delayMs = 25) {
  let active = 0;
  let peak = 0;
  return {
    async run() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active--;
      return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
    },
    peak: () => peak,
  };
}

describe("MissionScheduler (spec 02)", () => {
  it("attaches checkpoint identity and checkpoints progress without passing acceptance", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    store.addAcceptanceCriterion(mission.mission_id, "the implementation is validated", undefined, "AC-1");
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "bounded implementation",
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      deliverables: ["implementation", "tests"],
      execution_budget_ms: 10_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      mutates_repo: false,
      isolation: "none",
      mission_generation: 3,
      fencing_token: 5,
    });
    const checkpoints = new CheckpointManager({ store });
    const broker = new ExecutionBroker({
      store,
      checkpoints,
      resolveRepository: async (repoId) => ({ repoId, root: "/repo", git: {} as never }),
      backends: {
        agent: {
          runAgent: async ({ onActivity }) => {
            onActivity?.({ kind: "state", summary: "implementation ready", meaningfulProgress: true });
            return {
              executionId: "worker",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: ["artifact://handoff"],
              usage: {},
            };
          },
        },
      },
    });

    await new MissionScheduler({ store, broker }).runMission(mission.mission_id);

    const execution = store.listExecutions(mission.mission_id, task.task_id)[0]!;
    assert.match(execution.checkpoint_id ?? "", /^TCP-/);
    const checkpoint = store.getTaskCheckpoint(execution.checkpoint_id!);
    assert.ok(checkpoint);
    assert.deepEqual(checkpoint.completedDeliverables, ["implementation", "tests"]);
    assert.deepEqual(checkpoint.artifactRefs, ["artifact://handoff"]);
    assert.equal(checkpoint.missionGeneration, task.mission_generation);
    assert.equal(checkpoint.candidateGeneration, task.candidate_generation);
    assert.equal(checkpoint.fencingToken, task.fencing_token);
    assert.equal(store.getMission(mission.mission_id)?.acceptance_criteria[0]?.status, "pending");
  });

  it("holds fenced mission and repository authority for the entire mutating dispatch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const ownership = new MissionOwnership(store, {
      ownerId: "scheduler-owner",
      leaseMs: 30,
      heartbeatMs: 5,
    });
    let identity = await ownership.acquire(mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "long mutation",
      mutates_repo: true,
      isolation: "none",
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          assert.equal(store.getRepositoryLeaseByRepoId("repo-1")?.missionId, mission.mission_id);
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      acquireAuthority: async (scheduled) => {
        const held = await ownership.maintain(identity, scheduled.mutates_repo ? "repo-1" : undefined);
        return {
          get missionIdentity() {
            return held.missionIdentity;
          },
          get repositoryIdentity() {
            return held.repositoryIdentity;
          },
          assertAuthoritative: () => held.assertAuthoritative(),
          onInvalidated: (listener) => held.onInvalidated(listener),
          close: async () => {
            const error = await held.close();
            identity = held.missionIdentity;
            return error;
          },
        };
      },
    });

    await scheduler.runMission(mission.mission_id);

    const settled = store.getTask(task.task_id)!;
    const execution = store.listExecutions(mission.mission_id, task.task_id)[0]!;
    assert.equal(settled.status, "SUCCEEDED", settled.failure_reason);
    assert.ok((settled.mission_generation ?? 0) > 0);
    assert.equal(execution.mission_generation, settled.mission_generation);
    assert.equal(execution.fencing_token, settled.fencing_token);
    assert.equal(store.getRepositoryLeaseByRepoId("repo-1"), undefined);
  });

  it("preserves task success and durably reports a repository release failure", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = createExecutingMission(store);
    class FailingRepositoryReleaseOwnership extends MissionOwnership {
      override async release(identity: OwnershipIdentity): Promise<void> {
        if ("repoId" in identity) throw new Error("injected repository release failure");
        await super.release(identity);
      }
    }
    const ownership = new FailingRepositoryReleaseOwnership(store, { ownerId: "controller-release-failure" });
    const missionIdentity = await ownership.acquire(mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "successful mutation with failed release",
      mutates_repo: true,
      isolation: "none",
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      acquireAuthority: async () => ownership.maintain(missionIdentity, "repo-release-failure"),
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
    await store.flush();
    const finding = MissionStore.open(backend)
      .listFindings(mission.mission_id)
      .find((candidate) => candidate.category === "ownership_release");
    assert.ok(finding, "repository release failure must be durable and operator-visible");
    assert.equal(finding.task_id, task.task_id);
    assert.match(finding.summary, /repository ownership release failed/i);
    assert.match(finding.evidence ?? "", /repo-release-failure/);
    assert.match(finding.evidence ?? "", /fencingToken.*1/);
    assert.match(finding.evidence ?? "", /injected repository release failure/);
  });

  it("cancels and rejects a late worker result after mission takeover", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const firstOwner = new MissionOwnership(store, {
      ownerId: "controller-a",
      leaseMs: 100,
      heartbeatMs: 10,
      now: () => now,
    });
    let identity = await firstOwner.acquire(mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "late mutation",
      mutates_repo: true,
      isolation: "none",
    });
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async ({ signal }) => {
          started();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { executionId: "late", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      acquireAuthority: async () => {
        const held = await firstOwner.maintain(identity, "repo-stale");
        return {
          get missionIdentity() {
            return held.missionIdentity;
          },
          get repositoryIdentity() {
            return held.repositoryIdentity;
          },
          assertAuthoritative: () => held.assertAuthoritative(),
          onInvalidated: (listener) => held.onInvalidated(listener),
          close: async () => {
            const error = await held.close();
            identity = held.missionIdentity;
            return error;
          },
        };
      },
    });
    const running = scheduler.runMission(mission.mission_id);
    await dispatched;

    now += 101;
    const secondOwner = new MissionOwnership(store, {
      ownerId: "controller-b",
      leaseMs: 100,
      heartbeatMs: 10,
      now: () => now,
    });
    const takeover = await secondOwner.acquire(mission.mission_id);
    await running;

    assert.equal(takeover.generation, 2);
    assert.notEqual(store.getTask(task.task_id)?.status, "SUCCEEDED");
    const execution = store.listExecutions(mission.mission_id, task.task_id)[0]!;
    assert.equal(execution.status, "CANCELED");
    assert.match(execution.exit_status ?? "", /late_result_rejected/);
  });

  it("serializes mutating dispatches from separate controllers by repository id", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const firstMission = createExecutingMission(store);
    const secondMission = createExecutingMission(store);
    const firstOwner = new MissionOwnership(store, { ownerId: "runtime-a", leaseMs: 1_000, heartbeatMs: 50 });
    const secondOwner = new MissionOwnership(store, { ownerId: "runtime-b", leaseMs: 1_000, heartbeatMs: 50 });
    let firstIdentity = await firstOwner.acquire(firstMission.mission_id);
    let secondIdentity = await secondOwner.acquire(secondMission.mission_id);
    const firstTask = store.createTask({
      mission_id: firstMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "first mutation",
      mutates_repo: true,
      isolation: "none",
    });
    const secondTask = store.createTask({
      mission_id: secondMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "second mutation",
      mutates_repo: true,
      isolation: "none",
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDispatched = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondCalls = 0;
    const schedulerFor = (
      missionOwner: MissionOwnership,
      identity: () => typeof firstIdentity,
      update: (next: typeof firstIdentity) => void,
      broker: ExecutionBroker,
    ) =>
      new MissionScheduler({
        store,
        broker,
        acquireAuthority: async () => {
          const held = await missionOwner.maintain(identity(), "repo-shared");
          return {
            get missionIdentity() {
              return held.missionIdentity;
            },
            get repositoryIdentity() {
              return held.repositoryIdentity;
            },
            assertAuthoritative: () => held.assertAuthoritative(),
            onInvalidated: (listener) => held.onInvalidated(listener),
            close: async () => {
              const error = await held.close();
              update(held.missionIdentity);
              return error;
            },
          };
        },
      });
    const firstScheduler = schedulerFor(
      firstOwner,
      () => firstIdentity,
      (next) => {
        firstIdentity = next;
      },
      makeBroker(store, {
        agent: {
          runAgent: async () => {
            firstStarted();
            await firstMayFinish;
            return { executionId: "first", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      }),
    );
    const secondScheduler = schedulerFor(
      secondOwner,
      () => secondIdentity,
      (next) => {
        secondIdentity = next;
      },
      makeBroker(store, {
        agent: {
          runAgent: async () => {
            secondCalls++;
            return { executionId: "second", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      }),
    );

    const firstRun = firstScheduler.runMission(firstMission.mission_id);
    await firstDispatched;
    await secondScheduler.runMission(secondMission.mission_id);
    assert.equal(secondCalls, 0);
    assert.equal(store.getTask(secondTask.task_id)?.status, "BLOCKED");
    assert.match(store.getTask(secondTask.task_id)?.failure_reason ?? "", /repo-shared.*mission/i);

    releaseFirst();
    await firstRun;
    assert.equal(store.getTask(firstTask.task_id)?.status, "SUCCEEDED");
  });
  it("runs independent tasks concurrently (parallelism)", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    // Backend (src/server) and frontend (src/web) — non-overlapping.
    const a = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "backend",
      write_domains: ["src/server/**"],
      mutates_repo: true,
      isolation: "none",
    });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "frontend",
      write_domains: ["src/web/**"],
      mutates_repo: true,
      isolation: "none",
    });
    let maxConcurrent = 0;
    let concurrent = 0;
    const barrier = parallelBarrier(2);
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Block until both agents are active: deterministic overlap.
          await barrier.arrived();
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(a.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
    assert.ok(maxConcurrent >= 2, `expected concurrent execution, saw ${maxConcurrent}`);
  });

  it("serializes overlapping write domains", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    // Both write src/shared — must NOT run concurrently.
    const a = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "a",
      write_domains: ["src/shared/**"],
      mutates_repo: true,
      isolation: "none",
    });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "b",
      write_domains: ["src/shared/util.ts"],
      mutates_repo: true,
      isolation: "none",
    });
    let maxConcurrent = 0;
    let concurrent = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(maxConcurrent, 1, `overlapping writes must serialize, saw ${maxConcurrent}`);
    assert.equal(store.getTask(a.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
  });

  it("respects dependency order", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const order: string[] = [];
    const a = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "scout", objective: "scout" });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "impl",
      depends_on: [a.task_id],
    });
    const c = store.createTask({
      mission_id: m.mission_id,
      kind: "review",
      role: "reviewer",
      objective: "review",
      depends_on: [b.task_id],
    });
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ role }) => {
          order.push(role);
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
      review: {
        runReview: async () => {
          order.push("reviewer");
          return { executionId: "e", exitStatus: "succeeded", summary: "reviewed", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.deepEqual(order, ["scout", "implementer", "reviewer"]);
    assert.equal(store.getTask(c.task_id)!.status, "SUCCEEDED");
  });

  it("retries transient failures then succeeds", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      max_attempts: 3,
    });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          if (calls === 1) throw new Error("transient 429 rate limited");
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(t.task_id)!.attempt, 2);
  });

  it("fails a task after exhausting retries", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      max_attempts: 2,
    });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          throw new Error("transient 429 rate limited");
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
  });

  it("cancels active mission executions when the caller aborts", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "long-running work",
    });
    let backendSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async ({ signal }) => {
          backendSignal = signal;
          markStarted();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { executionId: "e", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
        },
      },
    });
    const scheduler = new MissionScheduler({ store, broker });
    const controller = new AbortController();
    const running = scheduler.runMission(mission.mission_id, controller.signal);

    await started;
    controller.abort();
    await running;

    assert.equal(backendSignal?.aborted, true, "the active backend must receive cancellation");
    assert.equal(store.getTask(task.task_id)?.status, "CANCELED");
  });

  it("cancels promptly during resilience backoff and releases scheduler capacity", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const firstMission = createExecutingMission(store);
    const firstTask = store.createTask({
      mission_id: firstMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "retrying work",
    });
    let enterBackoff!: () => void;
    const backoffStarted = new Promise<void>((resolve) => {
      enterBackoff = resolve;
    });
    const neverCompletes = new Promise<void>(() => undefined);
    const broker = makeBroker(store, {
      agent: {
        runAgent: async ({ objective }) =>
          objective === "retrying work"
            ? transientInfrastructureOutcome()
            : { executionId: "e2", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 1 },
      resilience: cancellationResilience,
      sleep: async () => {
        enterBackoff();
        await neverCompletes;
      },
    });
    const controller = new AbortController();
    const running = scheduler.runMission(firstMission.mission_id, controller.signal);

    await backoffStarted;
    controller.abort();
    await running;

    assert.equal(store.getTask(firstTask.task_id)?.status, "CANCELED");

    const secondMission = createExecutingMission(store);
    const secondTask = store.createTask({
      mission_id: secondMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "fresh work",
    });
    await scheduler.runMission(secondMission.mission_id);
    assert.equal(store.getTask(secondTask.task_id)?.status, "SUCCEEDED", "canceled work must release maxActive");
  });

  it("cancels promptly while a recovery probe is pending", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "probe-gated work",
    });
    let probeStarted!: () => void;
    const probing = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const broker = makeBroker(store, {
      agent: { runAgent: async () => transientInfrastructureOutcome() },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: cancellationResilience,
      sleep: async () => undefined,
      probe: {
        probe: async () => {
          probeStarted();
          await new Promise<void>(() => undefined);
          return { healthy: false };
        },
      },
    });
    const controller = new AbortController();
    const running = scheduler.runMission(mission.mission_id, controller.signal);

    await probing;
    controller.abort();
    await running;

    assert.equal(store.getTask(task.task_id)?.status, "CANCELED");
  });

  it("enforces the agent cap when several delayed agents become runnable together", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 3; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: `agent-${i}`,
        objective: `agent ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { agent: { runAgent: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxAgents: 1, maxPerRole: 10 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 1, "no more than maxAgents agent executions may overlap");
  });

  it("enforces the subprocess cap when delayed process tasks become runnable together", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 3; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "process",
        role: `process-${i}`,
        objective: `process ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { process: { runProcess: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxSubprocesses: 1, maxPerRole: 10 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 1, "no more than maxSubprocesses process executions may overlap");
  });

  it("enforces the per-role cap when delayed tasks share a role", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 3; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: `implementation ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { agent: { runAgent: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxAgents: 10, maxPerRole: 1 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 1, "no more than maxPerRole executions for one role may overlap");
  });

  it("enforces the aggregate cap when delayed tasks become runnable together", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 4; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: `aggregate-${i}`,
        objective: `aggregate ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { agent: { runAgent: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 2, maxAgents: 10, maxPerRole: 10 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 2, "no more than maxActive executions may overlap");
  });
});

describe("write-domain conflict detection", () => {
  it("detects overlapping and disjoint domains", () => {
    assert.ok(domainsOverlap(["src/server/**"], ["src/server/api.ts"]));
    assert.ok(domainsOverlap(["src/shared/"], ["src/shared/util.ts"]));
    assert.ok(!domainsOverlap(["src/server/**"], ["src/web/**"]));
    assert.ok(domainsOverlap(["src/a"], ["src/a/b.ts"]));
  });
});

describe("failure classifier (spec 02)", () => {
  it("classifies transient vs merge vs test failures", () => {
    const task = { failure_policy: "retry" } as never;
    assert.equal(classifyFailure(new Error("429 rate limit"), task).action, "retry");
    assert.equal(classifyFailure(new Error("merge conflict in src/a.ts"), task).action, "repair");
    assert.equal(classifyFailure(new Error("test failed: expected 1 got 2"), task).action, "repair");
    assert.equal(classifyFailure(new Error("context overflow max tokens"), task).action, "retry");
  });
});
