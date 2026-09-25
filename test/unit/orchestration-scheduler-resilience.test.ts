import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { GatewayResilienceConfig } from "../../src/resilience/config.ts";

/** A short, deterministic resilience config for tests (no jitter). */
const testResilience: GatewayResilienceConfig = {
  retry_window_ms: 1000,
  probe_interval_ms: 100,
  request_timeout_ms: 120_000,
  connect_timeout_ms: 10_000,
  jitter_ms: 0,
  circuit_breaker_threshold: 5,
  retry_transient_errors: true,
  preserve_mission_on_exhaustion: true,
  auto_resume_on_recovery: true,
};

interface Clocked {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function clock(): Clocked {
  let t = 0;
  return {
    now: () => t,
    // Each sleep advances the simulated wall clock by its duration, so the
    // retry window deterministically expires after enough probe waits.
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function makeMission(store: MissionStore) {
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
  return m;
}

/** A worker outcome that mimics a gateway-down failure: non-throwing, with the
 * worker's transient-infra marker. */
function transientOutcome() {
  return {
    executionId: "e",
    exitStatus: "failed" as const,
    summary: "Worker failed after 4 attempt(s): 503 no worker for model",
    artifactRefs: [],
    usage: {},
    error: "transient:server_unavailable",
  };
}

const successOutcome = {
  executionId: "e",
  exitStatus: "succeeded" as const,
  summary: "done",
  artifactRefs: [],
  usage: {},
};

describe("MissionScheduler resilience (time-based gateway window)", () => {
  it("pauses (not fails) the mission when the retry window exhausts while the gateway is down", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          return transientOutcome();
        },
      },
    };
    const broker = new ExecutionBroker({ store, backends });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      probe: { probe: async () => ({ healthy: false }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    // The gateway stayed down: the mission is paused (not failed), the task is
    // left resumable (RETRYING), and no progress was lost.
    assert.equal(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    assert.notEqual(store.getTask(t.task_id)!.status, "FAILED");
    assert.equal(store.getTask(t.task_id)!.status, "RETRYING");
    assert.ok(calls >= 1, "the worker was attempted at least once");
  });

  it("retries within the window and succeeds when the gateway recovers", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    let probeCalls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          // First real attempt hits the outage; after the gateway recovers the
          // retry succeeds.
          return calls < 2 ? transientOutcome() : successOutcome;
        },
      },
    };
    const broker = new ExecutionBroker({ store, backends });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      // Gateway recovers after a few probes.
      probe: { probe: async () => ({ healthy: ++probeCalls > 3 }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2, "exactly one retry after recovery");
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    // The mission is no longer parked.
    assert.notEqual(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    assert.notEqual(store.getMission(m.mission_id)!.status, "WAITING_FOR_LLM");
  });

  it("resumes a paused mission when the gateway returns healthy", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    let healthy = false;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          return healthy ? successOutcome : transientOutcome();
        },
      },
    };
    const broker = new ExecutionBroker({ store, backends });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      probe: { probe: async () => ({ healthy }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    // Gateway down: the mission pauses.
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");

    // Gateway recovers: resume re-runs the paused task and it succeeds.
    healthy = true;
    const status = await scheduler.resumePausedMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
    void status;
  });

  it("does not apply the resilience window to a non-transient failure", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          // A non-transient (no marker) failure fails the task immediately — the
          // time-based window must not retry it for the full 90 minutes.
          return {
            executionId: "e",
            exitStatus: "failed" as const,
            summary: "worker gave up",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    };
    const broker = new ExecutionBroker({ store, backends });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      probe: { probe: async () => ({ healthy: true }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 1, "no retry for a non-transient failure");
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
    // The worker's own summary is kept: the exit status alone hid the cause.
    const failed = store.getTask(t.task_id) as unknown as { failure_reason?: string };
    assert.equal(failed.failure_reason, "backend reported failed: worker gave up");
  });
  it("fails an unknown-model task with its real cause instead of parking it in the infra window", async () => {
    // The worker already spent its one catalog-resync retry. A healthy gateway
    // plus a model it does not know is a configuration problem: waiting 90
    // minutes (and pausing the mission as "infrastructure") hides it.
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          return {
            executionId: "e",
            exitStatus: "failed" as const,
            summary: 'Worker failed after 2 attempt(s): 404: {"code":"model_not_found"}',
            artifactRefs: [],
            usage: {},
            error: "transient:model_unavailable",
          };
        },
      },
    };
    const broker = new ExecutionBroker({ store, backends });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      probe: { probe: async () => ({ healthy: true }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 1, "no infra-window retry for an unknown model");
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
    assert.notEqual(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    const failed = store.getTask(t.task_id) as unknown as { failure_reason?: string };
    assert.match(failed.failure_reason ?? "", /model_not_found/);
  });
});
