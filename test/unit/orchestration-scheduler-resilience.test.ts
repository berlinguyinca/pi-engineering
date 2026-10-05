import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  MissionScheduler,
  type MissionSchedulerStatusNotice,
  UNLISTED_PROBES_BEFORE_VERIFY,
} from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { GatewayResilienceConfig } from "../../src/resilience/config.ts";
import type { ProbeResult } from "../../src/resilience/probe.ts";

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

  it("reports why a mission has no active worker and what recovery will happen next", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    const notices: MissionSchedulerStatusNotice[] = [];
    const broker = new ExecutionBroker({
      store,
      backends: { agent: { runAgent: async () => transientOutcome() } },
    });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      probe: { probe: async () => ({ healthy: false }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
      onStatus: (notice) => {
        notices.push(notice);
      },
    });

    await scheduler.runMission(m.mission_id);

    assert.ok(
      notices.some(
        (notice) =>
          notice.status === "WAITING_FOR_LLM" &&
          notice.action === "retrying" &&
          typeof notice.reason === "string" &&
          typeof notice.nextActionAt === "number",
      ),
      JSON.stringify(notices),
    );
    assert.ok(
      notices.some(
        (notice) => notice.status === "PAUSED_INFRASTRUCTURE" && notice.action === "paused" && notice.terminal === true,
      ),
      JSON.stringify(notices),
    );
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
    const notices: MissionSchedulerStatusNotice[] = [];
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      // Gateway recovers after a few probes.
      probe: { probe: async () => ({ healthy: ++probeCalls > 3 }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
      onStatus: (notice) => {
        notices.push(notice);
      },
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2, "exactly one retry after recovery");
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    // The mission is no longer parked.
    assert.notEqual(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    assert.notEqual(store.getMission(m.mission_id)!.status, "WAITING_FOR_LLM");
    assert.ok(
      notices.some(
        (notice) => notice.status === "EXECUTING" && notice.action === "resumed" && notice.terminal === false,
      ),
      JSON.stringify(notices),
    );
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
  it("parks (not fails) a mid-session stream cut in the resilience window", async () => {
    // A gateway that closes the SSE stream after the worker ran tools reports
    // `truncated_after_progress`. That is a transport hiccup: the task must
    // enter the time-based outage window and pause with the mission when the
    // gateway stays down — not fail the task and leave the mission with no
    // candidate (the old death spiral into a permanent BLOCKED).
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
            summary: "Worker returned no worker_result. Stream ended without finish_reason",
            artifactRefs: [],
            usage: {},
            error: "truncated_after_progress",
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
      probe: { probe: async () => ({ healthy: false }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    assert.notEqual(store.getTask(t.task_id)!.status, "FAILED");
    assert.equal(store.getTask(t.task_id)!.status, "RETRYING");
    assert.ok(calls >= 1, "the worker was attempted at least once");
  });

  it("recovers a mid-session stream cut when the gateway returns healthy", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    let probeCalls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          return calls < 2
            ? {
                executionId: "e",
                exitStatus: "failed" as const,
                summary: "Worker returned no worker_result. Stream ended without finish_reason",
                artifactRefs: [],
                usage: {},
                error: "truncated_after_progress",
              }
            : successOutcome;
        },
      },
    };
    const broker = new ExecutionBroker({ store, backends });
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: testResilience,
      probe: { probe: async () => ({ healthy: ++probeCalls > 3 }) },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2, "one truncation, one successful relaunch after the probe recovers");
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.notEqual(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
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
  // Issue #76: a gateway that answers but no longer lists the mission's model
  // said "not served" forever, so no worker ran, model_not_found never
  // surfaced, and the mission paused instead of failing.
  const unlisted: ProbeResult = {
    healthy: false,
    reason: "model m is not served",
    authoritative: true,
    model_unlisted: true,
    model_id: "m",
  };
  const down: ProbeResult = { healthy: false, reason: "gateway unreachable: ECONNREFUSED", authoritative: true };
  const noSlots: ProbeResult = { healthy: false, reason: "model m has no capacity (0 slots)", authoritative: true };
  const modelNotFound = {
    executionId: "e",
    exitStatus: "failed" as const,
    summary: 'Worker failed after 2 attempt(s): 404: {"code":"model_not_found"}',
    artifactRefs: [],
    usage: {},
    error: "transient:model_unavailable",
  };
  type Outcome = ReturnType<typeof transientOutcome> | typeof successOutcome | typeof modelNotFound;

  /**
   * `outcomes` are the agent's answers in order (the last repeats); `probes`
   * the probe's answers in order (the last repeats). Records how many probes
   * had been made when each agent attempt started.
   */
  function unlistedScheduler(
    outcomes: Outcome[],
    probes: ProbeResult[],
    resilience: GatewayResilienceConfig = testResilience,
  ) {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    let probeCalls = 0;
    const probesAtAttempt: number[] = [];
    const notices: MissionSchedulerStatusNotice[] = [];
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          probesAtAttempt.push(probeCalls);
          return outcomes[Math.min(calls++, outcomes.length - 1)]!;
        },
      },
    };
    const clk = clock();
    const scheduler = new MissionScheduler({
      store,
      broker: new ExecutionBroker({ store, backends }),
      resilience,
      probe: { probe: async () => probes[Math.min(probeCalls++, probes.length - 1)]! },
      now: clk.now,
      sleep: clk.sleep,
      rand: () => 0,
      onStatus: (notice) => {
        notices.push(notice);
      },
    });
    return {
      store,
      m,
      t,
      scheduler,
      notices,
      probesAtAttempt,
      calls: () => calls,
      probeCalls: () => probeCalls,
    };
  }

  it("a model removed from the catalog mid-outage fails with model_not_found instead of pausing", async () => {
    const { store, m, t, scheduler, calls } = unlistedScheduler([transientOutcome(), modelNotFound], [unlisted]);
    await scheduler.runMission(m.mission_id);
    assert.equal(calls(), 2, "one verification attempt was let through the probe gate");
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
    // The failed task leaves the resilience window: the mission is un-parked.
    assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
    const failed = store.getTask(t.task_id) as unknown as { failure_reason?: string };
    assert.match(failed.failure_reason ?? "", /model_not_found/);
  });

  it("a legacy alias that routes but is not listed completes instead of pausing", async () => {
    const { store, m, t, scheduler, calls } = unlistedScheduler([transientOutcome(), successOutcome], [unlisted]);
    await scheduler.runMission(m.mission_id);
    assert.equal(calls(), 2);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
  });

  it("a gateway that is down (not merely unlisting the model) gets no verification attempt", async () => {
    const { store, m, scheduler, calls } = unlistedScheduler([transientOutcome()], [down]);
    await scheduler.runMission(m.mission_id);
    assert.equal(calls(), 1, "only the original attempt; the gate waited out the outage");
    assert.equal(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
  });

  it("lets the verification attempt through on exactly the threshold-th unlisted probe, and says so", async () => {
    const { scheduler, m, probesAtAttempt, notices } = unlistedScheduler(
      [transientOutcome(), successOutcome],
      [unlisted],
    );
    await scheduler.runMission(m.mission_id);
    assert.deepEqual(probesAtAttempt, [0, UNLISTED_PROBES_BEFORE_VERIFY]);
    assert.ok(
      notices.some(
        (n) =>
          n.action === "retrying" &&
          n.terminal === false &&
          /model m is not listed by the gateway; trying it once to confirm/.test(n.reason),
      ),
      JSON.stringify(notices),
    );
  });

  it("a verification attempt that comes back transient resets the count, stays bounded, and ends paused", async () => {
    const { store, m, t, scheduler, probesAtAttempt } = unlistedScheduler([transientOutcome()], [unlisted]);
    await scheduler.runMission(m.mission_id);
    // Each relaunch needs a fresh run of UNLISTED_PROBES_BEFORE_VERIFY probes,
    // the backoff between relaunches grows, and the 1000 ms window then closes
    // and the mission pauses.
    assert.deepEqual(probesAtAttempt, [0, 3, 6, 9]);
    assert.equal(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    assert.equal(store.getTask(t.task_id)!.status, "RETRYING");
  });

  it("an unlisted answer interleaved with an outage or 0 slots restarts the count", async () => {
    const { m, scheduler, probesAtAttempt } = unlistedScheduler(
      [transientOutcome(), successOutcome],
      [unlisted, unlisted, down, unlisted, unlisted, noSlots, unlisted, unlisted, unlisted],
    );
    await scheduler.runMission(m.mission_id);
    assert.deepEqual(probesAtAttempt, [0, 9], "only three consecutive unlisted answers let an attempt through");
  });

  it("a paused window does not carry its unlisted count into the next window", async () => {
    // retry_after_ms paces the first two probes so the window closes after two
    // unlisted answers: that count (2) must not survive the pause.
    const paced: ProbeResult = { ...unlisted, retry_after_ms: 450 };
    const { store, m, scheduler, probesAtAttempt } = unlistedScheduler(
      [transientOutcome(), transientOutcome(), successOutcome],
      [paced, paced, unlisted],
    );
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    assert.deepEqual(probesAtAttempt, [0]);
    await scheduler.resumePausedMission(m.mission_id);
    // After resume: one real attempt (no window yet), then a fresh window that
    // needs three new unlisted probes, not one.
    assert.deepEqual(probesAtAttempt, [0, 2, 5]);
    assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
  });

  it("names the relaunch ceiling without claiming the gateway looked healthy", async () => {
    const { store, m, t, scheduler } = unlistedScheduler([transientOutcome()], [unlisted], {
      ...testResilience,
      retry_window_ms: 60_000,
      max_relaunches: 1,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
    assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
    const failed = store.getTask(t.task_id) as unknown as { failure_reason?: string };
    assert.match(failed.failure_reason ?? "", /^task relaunched 1 times through a transient outage without success;/);
    assert.doesNotMatch(failed.failure_reason ?? "", /looked healthy/);
  });

  describe("awaitRecovery (paused mission)", () => {
    /** Pause a mission, then watch it with a scheduler whose probe answers `probes`. */
    async function pausedMission(probes: ProbeResult[]) {
      const h = unlistedScheduler([transientOutcome()], [down]);
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
      let probed = 0;
      const clk = clock();
      const scheduler = new MissionScheduler({
        store: h.store,
        broker: new ExecutionBroker({ store: h.store, backends: {} }),
        resilience: testResilience,
        probe: { probe: async () => probes[Math.min(probed++, probes.length - 1)]! },
        now: clk.now,
        sleep: clk.sleep,
        rand: () => 0,
        onStatus: (notice) => {
          h.notices.push(notice);
        },
      });
      return { ...h, scheduler, probed: () => probed };
    }

    it("resumes after the threshold of consecutive unlisted answers so a real attempt can take over", async () => {
      const h = await pausedMission([unlisted]);
      assert.equal(await h.scheduler.awaitRecovery(1_000_000, undefined, h.m.mission_id), true);
      assert.equal(h.probed(), UNLISTED_PROBES_BEFORE_VERIFY);
      assert.ok(
        h.notices.some(
          (n) =>
            n.status === "PAUSED_INFRASTRUCTURE" &&
            /model m is not listed by the gateway; trying it once to confirm/.test(n.reason),
        ),
        JSON.stringify(h.notices),
      );
    });

    it("an outage or 0-slot answer between unlisted answers restarts the count", async () => {
      const h = await pausedMission([unlisted, unlisted, down, unlisted, noSlots, unlisted, unlisted, unlisted]);
      assert.equal(await h.scheduler.awaitRecovery(1_000_000, undefined, h.m.mission_id), true);
      assert.equal(h.probed(), 8);
    });

    it("still waits out a gateway that is down", async () => {
      const h = await pausedMission([down]);
      assert.equal(await h.scheduler.awaitRecovery(5_000, undefined, h.m.mission_id), false);
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    });
  });

  // A task that ends terminally inside the resilience window must take the
  // mission out of its WAITING_* park on EVERY path, or orchestrate() hits an
  // illegal transition out of the parked state.
  describe("terminal paths un-park the mission", () => {
    function parked(
      runAgent: NonNullable<BrokerBackends["agent"]>["runAgent"],
      extra: Partial<ConstructorParameters<typeof MissionScheduler>[0]> = {},
    ) {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = makeMission(store);
      const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
      const clk = clock();
      const scheduler = new MissionScheduler({
        store,
        broker: new ExecutionBroker({ store, backends: { agent: { runAgent } } }),
        resilience: { ...testResilience, retry_window_ms: 60_000 },
        probe: { probe: async () => ({ healthy: true }) },
        now: clk.now,
        sleep: clk.sleep,
        rand: () => 0,
        ...extra,
      });
      return { store, m, t, scheduler };
    }

    it("recovery STOP on a transient outcome", async () => {
      const h = parked(async () => transientOutcome(), { recovery: { missionCeiling: 1 } });
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.store.getTask(h.t.task_id)!.status, "FAILED");
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "EXECUTING");
    });

    it("recovery STOP on a thrown failure after the mission parked", async () => {
      let calls = 0;
      const h = parked(
        async () => {
          if (calls++ === 0) return transientOutcome();
          throw new Error("transient network failure");
        },
        { recovery: { missionCeiling: 1 } },
      );
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.store.getTask(h.t.task_id)!.status, "FAILED");
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "EXECUTING");
    });

    it("dispatch authority lost while parked (task BLOCKED)", async () => {
      let acquired = 0;
      const h = parked(async () => transientOutcome(), {
        acquireAuthority: async () => {
          if (acquired++ > 0) throw new Error("lease lost");
          return undefined as never;
        },
      });
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.store.getTask(h.t.task_id)!.status, "BLOCKED");
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "EXECUTING");
    });

    it("task canceled underneath a running attempt", async () => {
      let calls = 0;
      const box: { store?: MissionStore; taskId?: string } = {};
      const h = parked(async () => {
        if (calls++ === 0) return transientOutcome();
        box.store!.transitionTask(box.taskId!, "CANCELED");
        return successOutcome;
      });
      box.store = h.store;
      box.taskId = h.t.task_id;
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.store.getTask(h.t.task_id)!.status, "CANCELED");
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "EXECUTING");
    });

    it("task canceled underneath an attempt that then throws", async () => {
      let calls = 0;
      const box: { store?: MissionStore; taskId?: string } = {};
      const h = parked(async () => {
        if (calls++ === 0) return transientOutcome();
        box.store!.transitionTask(box.taskId!, "CANCELED");
        throw new Error("worker torn down");
      });
      box.store = h.store;
      box.taskId = h.t.task_id;
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.store.getTask(h.t.task_id)!.status, "CANCELED");
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "EXECUTING");
    });

    it("two tasks: A fails while B is still retrying, then B succeeds and the mission un-parks", async () => {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = makeMission(store);
      const a = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "a" });
      const b = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "reviewer", objective: "b" });
      let bCalls = 0;
      let releaseProbe!: () => void;
      const aSettled = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const missionWhenAFailed: string[] = [];
      const clk = clock();
      const scheduler = new MissionScheduler({
        store,
        broker: new ExecutionBroker({
          store,
          backends: {
            agent: {
              runAgent: async ({ objective }) => {
                if (objective === "b") return bCalls++ === 0 ? transientOutcome() : successOutcome;
                // A fails for good only once B sits parked in its retry window.
                while (store.getTask(b.task_id)!.status !== "RETRYING") {
                  await new Promise((resolve) => setTimeout(resolve, 1));
                }
                return { ...modelNotFound, error: "permanent" };
              },
            },
          },
        }),
        resilience: { ...testResilience, retry_window_ms: 60_000 },
        // B's gate holds on the probe until A has settled.
        probe: {
          probe: async () => {
            await aSettled;
            return { healthy: true };
          },
        },
        now: clk.now,
        sleep: clk.sleep,
        rand: () => 0,
        onTaskSettled: (missionId, taskId) => {
          if (taskId !== a.task_id) return;
          missionWhenAFailed.push(store.getMission(missionId)!.status);
          releaseProbe();
        },
      });
      await scheduler.runMission(m.mission_id);
      assert.equal(store.getTask(a.task_id)!.status, "FAILED");
      assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
      assert.deepEqual(missionWhenAFailed, ["WAITING_FOR_LLM"], "B was still retrying, so A's failure kept the park");
      assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
    });
  });

  // A removed model that answers 503 instead of 404: the attempt the gate let
  // through for an unlisted model comes back transient. The model is reported
  // unavailable to the probe (whose routing then moves to another model)
  // instead of being relaunched until max_relaunches.
  describe("a verification attempt that comes back transient", () => {
    /** `ranOn`: the model each attempt reports it ran on (the probed model is gw/m). */
    function reporting(probeAfterReport: ProbeResult, ranOn = { provider: "gw", id: "m" }) {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = makeMission(store);
      const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
      const reports: Array<{ model: string; missionId?: string; taskId?: string; reason: string }> = [];
      let calls = 0;
      let reported = false;
      const clk = clock();
      const scheduler = new MissionScheduler({
        store,
        broker: new ExecutionBroker({
          store,
          backends: {
            agent: {
              // Transient on the dead model; the replacement (after the report) succeeds.
              runAgent: async () => {
                calls++;
                return reported ? successOutcome : { ...transientOutcome(), model: ranOn };
              },
            },
          },
        }),
        resilience: { ...testResilience, retry_window_ms: 60_000 },
        probe: {
          probe: async () => (reported ? probeAfterReport : { ...unlisted, model_provider: "gw" }),
          reportModelUnavailable: (model, context) => {
            reported = true;
            reports.push({ model: `${model.provider}/${model.id}`, ...context });
          },
        },
        now: clk.now,
        sleep: clk.sleep,
        rand: () => 0,
      });
      return { store, m, t, scheduler, reports, calls: () => calls };
    }

    it("reports the unlisted model unavailable so the probe follows the new route", async () => {
      const h = reporting({ healthy: true, authoritative: true });
      await h.scheduler.runMission(h.m.mission_id);
      assert.equal(h.reports.length, 1);
      assert.equal(h.reports[0]!.model, "gw/m");
      assert.equal(h.reports[0]!.missionId, h.m.mission_id);
      assert.equal(h.reports[0]!.taskId, h.t.task_id);
      assert.match(h.reports[0]!.reason, /503/);
      assert.equal(h.calls(), 3, "original, verification, then the replacement model");
      assert.equal(h.store.getTask(h.t.task_id)!.status, "SUCCEEDED");
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "EXECUTING");
    });

    it("an ordinary transient relaunch (not an unlisted verification) reports nothing", async () => {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = makeMission(store);
      store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
      let calls = 0;
      let reports = 0;
      const clk = clock();
      const scheduler = new MissionScheduler({
        store,
        broker: new ExecutionBroker({
          store,
          backends: { agent: { runAgent: async () => (calls++ < 2 ? transientOutcome() : successOutcome) } },
        }),
        resilience: { ...testResilience, retry_window_ms: 60_000 },
        probe: {
          probe: async () => ({ healthy: true, authoritative: true }),
          reportModelUnavailable: () => {
            reports++;
          },
        },
        now: clk.now,
        sleep: clk.sleep,
        rand: () => 0,
      });
      await scheduler.runMission(m.mission_id);
      assert.equal(calls, 3);
      assert.equal(reports, 0);
      assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
    });

    it("does not report when the attempt ran on a different model than the probe's", async () => {
      // The probe targets the implementer's model gw/m; this attempt (say, a
      // reviewer) ran on gw/other, so its 503 says nothing about gw/m.
      const h = reporting({ healthy: true, authoritative: true }, { provider: "gw", id: "other" });
      await h.scheduler.runMission(h.m.mission_id);
      assert.deepEqual(h.reports, []);
      assert.equal(h.store.getMission(h.m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    });

    it("a verification attempt that throws leaves nothing for a later ordinary transient to report", async () => {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = makeMission(store);
      store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        max_attempts: 5,
      });
      const ranOn = { provider: "gw", id: "m" };
      let calls = 0;
      let probes = 0;
      let reports = 0;
      const clk = clock();
      const scheduler = new MissionScheduler({
        store,
        broker: new ExecutionBroker({
          store,
          backends: {
            agent: {
              runAgent: async () => {
                calls++;
                if (calls === 2) throw new Error("transient network failure");
                return calls === 4 ? successOutcome : { ...transientOutcome(), model: ranOn };
              },
            },
          },
        }),
        resilience: { ...testResilience, retry_window_ms: 60_000 },
        probe: {
          // Unlisted until the verification attempt has run, then healthy.
          probe: async () =>
            probes++ < UNLISTED_PROBES_BEFORE_VERIFY ? { ...unlisted, model_provider: "gw" } : { healthy: true },
          reportModelUnavailable: () => {
            reports++;
          },
        },
        now: clk.now,
        sleep: clk.sleep,
        rand: () => 0,
      });
      await scheduler.runMission(m.mission_id);
      assert.equal(calls, 4);
      assert.equal(reports, 0, "the ordinary transient after a healthy probe is not a verification");
      assert.equal(store.getMission(m.mission_id)!.status, "EXECUTING");
    });
  });
});
