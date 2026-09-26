import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
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
