/**
 * Transient infrastructure conditions — a model reloading or moving GPUs,
 * capacity_unavailable, a gateway restart, queue timeouts — can last HOURS.
 * They must not end an interactive turn or kill a mission after a few attempts
 * or minutes. Permanent errors must still fail fast. Fake clocks throughout.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "../../src/gateway/config.ts";
import { gatewayFailureMarker, parseGatewayWait } from "../../src/gateway/signals.ts";
import {
  DEFAULT_GATEWAY_MAX_ATTEMPTS,
  DEFAULT_GATEWAY_MAX_ELAPSED_MS,
  pumpWithGatewayRetry,
} from "../../src/gateway/streamRetry.ts";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DEFAULT_GATEWAY_RESILIENCE, resolveGatewayResilienceConfig } from "../../src/resilience/config.ts";

const HOUR = 3_600_000;

// ─── Configuration ──────────────────────────────────────────────────────────

describe("long-wait policy: defaults and knobs", () => {
  it("interactive turns wait out a 12h horizon; attempts are not the limit", () => {
    assert.equal(DEFAULT_GATEWAY_MAX_ELAPSED_MS, 12 * HOUR);
    assert.equal(DEFAULT_GATEWAY_CONFIG.maxElapsedMs, 12 * HOUR);
    assert.ok(DEFAULT_GATEWAY_MAX_ATTEMPTS >= 100_000, "an attempt count must never end a long wait first");
  });

  it("PI_GATEWAY_MAX_ELAPSED_MS accepts a duration ('2h') as well as plain ms", () => {
    const prev = process.env.PI_GATEWAY_MAX_ELAPSED_MS;
    try {
      process.env.PI_GATEWAY_MAX_ELAPSED_MS = "2h";
      assert.equal(resolveGatewayConfig().maxElapsedMs, 2 * HOUR);
      process.env.PI_GATEWAY_MAX_ELAPSED_MS = "90000";
      assert.equal(resolveGatewayConfig().maxElapsedMs, 90_000);
    } finally {
      if (prev === undefined) delete process.env.PI_GATEWAY_MAX_ELAPSED_MS;
      else process.env.PI_GATEWAY_MAX_ELAPSED_MS = prev;
    }
  });

  it("missions keep retrying for 12h with capped backoff, then pause and auto-resume for 24h", () => {
    assert.equal(DEFAULT_GATEWAY_RESILIENCE.retry_window_ms, 12 * HOUR);
    assert.equal(DEFAULT_GATEWAY_RESILIENCE.max_backoff_ms, 180_000);
    assert.equal(DEFAULT_GATEWAY_RESILIENCE.auto_resume_horizon_ms, 24 * HOUR);
    const cfg = resolveGatewayResilienceConfig({
      PI_GATEWAY_RETRY_WINDOW: "6h",
      PI_GATEWAY_MAX_BACKOFF: "5m",
      PI_GATEWAY_AUTO_RESUME_HORIZON: "48h",
    });
    assert.equal(cfg.retry_window_ms, 6 * HOUR);
    assert.equal(cfg.max_backoff_ms, 5 * 60_000);
    assert.equal(cfg.auto_resume_horizon_ms, 48 * HOUR);
  });
});

// ─── Worker failure markers ─────────────────────────────────────────────────

describe("long-wait policy: a worker's exhausted gateway wait enters the mission window", () => {
  it("retryable waits become transient markers; permanent refusals stay gateway markers", () => {
    const admission = parseGatewayWait({
      text: '429: {"reason":"queue_timeout","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}',
    })!;
    assert.equal(gatewayFailureMarker(admission), "transient:rate_limit", "an account-wide queue: capacity wait");
    const model503 = parseGatewayWait({ text: "503 no worker for model" })!;
    assert.equal(gatewayFailureMarker(model503), "transient:server_unavailable");
    const quota = parseGatewayWait({ text: "429 insufficient_quota: you exceeded your current quota" })!;
    assert.equal(quota.retryable, false);
    assert.match(gatewayFailureMarker(quota), /^gateway:/, "quota never waits");
  });
});

// ─── Interactive pump ───────────────────────────────────────────────────────

interface Ev {
  type: string;
  message?: Res;
  error?: Res;
}
interface Res {
  stopReason?: string;
  errorMessage?: string;
}

/** Every attempt fails with `text` while the fake clock is inside the outage. */
function outage(clock: { t: number }, untilMs: number, text: string) {
  let opened = 0;
  return {
    get opened() {
      return opened;
    },
    open: () => {
      opened++;
      const down = clock.t < untilMs;
      const events: Ev[] = down
        ? [{ type: "start" }, { type: "error", error: { stopReason: "error", errorMessage: text } }]
        : [{ type: "start" }, { type: "text_delta" }, { type: "done", message: { stopReason: "stop" } }];
      const terminal = events.at(-1)!;
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
        result: async (): Promise<Res> => terminal.message ?? terminal.error ?? {},
      };
    },
  };
}

function sink() {
  const pushed: Ev[] = [];
  let ended: Res | undefined;
  return {
    pushed,
    get ended() {
      return ended;
    },
    push: (e: Ev) => pushed.push(e),
    end: (r?: Res) => {
      ended = r;
    },
  };
}

describe("long-wait policy: the interactive pump", () => {
  it("keeps waiting through a 3-hour capacity_unavailable outage and completes, reporting since when", async () => {
    const clock = { t: 0 };
    const wall = 1_700_000_000_000;
    const s = outage(clock, 3 * HOUR, "capacity_unavailable");
    const out = sink();
    const since: Array<number | undefined> = [];
    const outcome = await pumpWithGatewayRetry(s.open, out, {
      hold: async (signal) => {
        since.push(signal.waitingSinceMs);
        clock.t += signal.retryAfterMs;
      },
      now: () => clock.t,
      wallNow: () => wall + clock.t,
    });
    assert.equal(outcome.settled, "ok");
    assert.ok(outcome.holds > 50, `holds=${outcome.holds}: well past any attempt count`);
    assert.ok(clock.t >= 3 * HOUR);
    assert.deepEqual(new Set(since), new Set([wall]), "every hold says when the wait began");
  });

  it("Esc during a long wait ends the turn at once", async () => {
    const clock = { t: 0 };
    const s = outage(clock, 10 * HOUR, "capacity_unavailable");
    const controller = new AbortController();
    const out = sink();
    const outcome = await pumpWithGatewayRetry(s.open, out, {
      hold: async (signal) => {
        clock.t += signal.retryAfterMs;
        if (clock.t > 4 * HOUR) controller.abort();
      },
      now: () => clock.t,
      signal: controller.signal,
    });
    assert.equal(outcome.settled, "aborted");
    assert.equal(out.ended?.stopReason, "aborted");
    assert.ok(clock.t < 4 * HOUR + 120_000);
  });

  it("a permanent error still fails fast", async () => {
    for (const text of [
      "401 Unauthorized",
      "429 insufficient_quota: you exceeded your current quota",
      "400 invalid request",
    ]) {
      const clock = { t: 0 };
      const s = outage(clock, 10 * HOUR, text);
      const outcome = await pumpWithGatewayRetry(s.open, sink(), {
        hold: async () => {
          throw new Error("must not hold");
        },
        now: () => clock.t,
      });
      assert.equal(outcome.holds, 0, text);
      assert.equal(s.opened, 1, text);
    }
  });
});

// ─── Missions ───────────────────────────────────────────────────────────────

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
  for (const s of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) store.transitionMission(m.mission_id, s);
  return m;
}

describe("long-wait policy: missions", () => {
  it("a worker keeps being retried through a 3-hour capacity outage with capped backoff, then succeeds", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let now = 0;
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          if (now < 3 * HOUR) {
            return {
              executionId: "e",
              exitStatus: "failed" as const,
              summary: "Worker failed after 5 attempt(s): capacity_unavailable",
              artifactRefs: [],
              usage: {},
              error: "transient:server_unavailable",
            };
          }
          return { executionId: "e", exitStatus: "succeeded" as const, summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const scheduler = new MissionScheduler({
      store,
      broker: new ExecutionBroker({ store, backends }),
      resilience: DEFAULT_GATEWAY_RESILIENCE,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.notEqual(store.getMission(m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    // 3h at a 3-minute cap is ~60 attempts after the ramp; blind 10s polling would be ~1000.
    assert.ok(calls < 120, `calls=${calls}`);
  });

  it("a permanent failure still fails the task on the first attempt", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    const scheduler = new MissionScheduler({
      store,
      broker: new ExecutionBroker({
        store,
        backends: {
          agent: {
            runAgent: async () => {
              calls++;
              return {
                executionId: "e",
                exitStatus: "failed" as const,
                summary: "quota exhausted",
                artifactRefs: [],
                usage: {},
                error: "gateway:quota_exhausted",
              };
            },
          },
        },
      }),
      resilience: DEFAULT_GATEWAY_RESILIENCE,
      now: () => 0,
      sleep: async () => {},
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 1);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
  });
});

// ─── Visible status ─────────────────────────────────────────────────────────

describe("long-wait policy: the operator sees what we wait for and since when", () => {
  it("footer, status line and notice carry how long the outage has lasted", async () => {
    const { FooterController } = await import("../../src/status/footer.ts");
    const { renderStatus } = await import("../../src/status/layout.ts");
    const { DEFAULT_STATUS_BAR_CONFIG } = await import("../../src/status/config.ts");
    const { describeAdmissionEvent, formatWaitingFor } = await import("../../src/gateway/admissionNotice.ts");
    const since = 1_700_000_000_000;
    const now = since + 2 * HOUR + 3 * 60_000;
    const signal = {
      retryAfterMs: 60_000,
      retryable: true,
      source: "default" as const,
      reason: "capacity_unavailable",
      flattened: true,
      waitingSinceMs: since,
      model: "qwen-27b",
    };

    assert.equal(formatWaitingFor(2 * HOUR + 3 * 60_000), "2h 03m");
    assert.equal(formatWaitingFor(5 * 60_000 + 7_000), "5m 07s");
    assert.equal(formatWaitingFor(42_000), "42s");

    const notice = describeAdmissionEvent({ type: "wait", waitMs: 60_000, signal, concurrency: 4 }, () => now);
    assert.match(notice.text, /capacity unavailable/);
    assert.match(notice.text, /capacity unavailable · qwen-27b · waiting for 2h 03m/);

    const renders: string[] = [];
    const ctx = { ui: { setFooter: () => {}, setStatus: () => {} } };
    const footer = new FooterController({ ctx: ctx as never, config: DEFAULT_STATUS_BAR_CONFIG, now: () => now });
    try {
      footer.onGatewayEvent({ type: "wait", waitMs: 60_000, signal, concurrency: 4 });
      assert.equal(footer.state.wait?.sinceMs, since);
      const line = renderStatus(footer.state, 200, DEFAULT_STATUS_BAR_CONFIG, now);
      renders.push(line);
      assert.match(line, /gateway 60s · capacity_unavailable · for 2h 03m/);
    } finally {
      footer.dispose();
    }
  });
});

describe("long-wait policy: model fallback during a long outage", () => {
  it("only a model's own outage arms a switch; an account-wide queue does not", async () => {
    const { FallbackCoordinator, FALLBACK_AFTER_HOLDS } = await import("../../src/gateway/fallbackLifecycle.ts");
    // Every model shares the account's queue: switching models cannot help.
    const queue = new FallbackCoordinator();
    for (let i = 0; i < FALLBACK_AFTER_HOLDS + 3; i++) queue.onGatewayHold({ source: "body", accountWide: true });
    assert.equal(queue.hasPending, false);
    // One model is unavailable (capacity, reload, GPU move): a stand-in helps.
    const model = new FallbackCoordinator();
    for (let i = 0; i < FALLBACK_AFTER_HOLDS; i++) model.onGatewayHold({ source: "default", accountWide: false });
    assert.equal(model.hasPending, true);
  });
});

// ─── Review follow-up: only positively transient signals wait for hours ─────

describe("long-wait policy: a bare 500/502/504 is not evidence of a transient outage", () => {
  it("classifies which signals earn the long horizon", async () => {
    const { isLongWaitTransient, transportDropWait } = await import("../../src/gateway/signals.ts");
    const long = [
      parseGatewayWait({ text: "503 no worker for model" }),
      parseGatewayWait({ text: "529 overloaded" }),
      parseGatewayWait({ text: "429 Too Many Requests" }),
      parseGatewayWait({ text: "capacity_unavailable" }),
      parseGatewayWait({ text: "The route serving this model ended before the response did" }),
      parseGatewayWait({
        text: '429: {"reason":"queue_timeout","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}',
      }),
      transportDropWait({ text: "terminated" }),
    ];
    for (const s of long) assert.equal(isLongWaitTransient(s!), true, JSON.stringify(s));
    const short = [
      parseGatewayWait({ text: "500 Internal Server Error" }),
      parseGatewayWait({ text: "502 Bad Gateway" }),
      parseGatewayWait({ text: "504 Gateway Timeout" }),
    ];
    for (const s of short) assert.equal(isLongWaitTransient(s!), false, JSON.stringify(s));
  });

  it("pump: a deterministic 500 keeps the old finite budget (8 attempts / 5 min), not 12h", async () => {
    for (const text of ["500 Internal Server Error", "504 Gateway Timeout"]) {
      const clock = { t: 0 };
      const s = outage(clock, 100 * HOUR, text);
      const outcome = await pumpWithGatewayRetry(s.open, sink(), {
        hold: async (signal) => {
          clock.t += signal.retryAfterMs;
        },
        now: () => clock.t,
      });
      assert.ok(outcome.attempts <= 8, `${text}: attempts=${outcome.attempts}`);
      assert.ok(clock.t <= 300_000, `${text}: waited ${clock.t}ms`);
      assert.equal(outcome.settled, "error");
    }
  });

  it("worker: an exhausted bare 5xx fails the task; a thrown bare 502 is not an infra marker", async () => {
    const { classifyError } = await import("../../src/guard/transient.ts");
    const bare = parseGatewayWait({ text: "500 Internal Server Error" })!;
    assert.match(gatewayFailureMarker(bare), /^gateway:/);
    // A thrown bare 5xx exhausts the worker's short transient retries as
    // server_error, which the scheduler does not park in the infra window.
    assert.equal(classifyError({ status: 502, message: "Bad Gateway" }).category, "server_error");
    // A truncated stream is a connection problem, not a server verdict.
    assert.equal(classifyError(new Error("Stream ended without finish_reason")).category, "network");

    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = makeMission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
    let calls = 0;
    const scheduler = new MissionScheduler({
      store,
      broker: new ExecutionBroker({
        store,
        backends: {
          agent: {
            runAgent: async () => {
              calls++;
              return {
                executionId: "e",
                exitStatus: "failed" as const,
                summary: "Worker failed after 5 attempt(s): 5xx (500)",
                artifactRefs: [],
                usage: {},
                error: "transient:server_error",
              };
            },
          },
        },
      }),
      resilience: DEFAULT_GATEWAY_RESILIENCE,
      now: () => 0,
      sleep: async () => {},
      rand: () => 0,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 1);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
  });
});

describe("long-wait policy: an interactive wait never floods the gateway", () => {
  async function paced(text: string, holds: number, opts: { priorHolds?: number } = {}) {
    const clock = { t: 0 };
    const waits: number[] = [];
    const s = outage(clock, Number.POSITIVE_INFINITY, text);
    await pumpWithGatewayRetry(s.open, sink(), {
      hold: async (signal) => {
        waits.push(signal.retryAfterMs);
        clock.t += signal.retryAfterMs;
      },
      now: () => clock.t,
      wallNow: () => clock.t,
      maxAttempts: holds + 1,
      ...opts,
    });
    return waits;
  }

  it("a 1s link-cut hint escalates after the first few holds, capped at 60s", async () => {
    const waits = await paced("The route serving this model ended before the response did", 12);
    assert.deepEqual(waits.slice(0, 5), [1_000, 1_000, 1_000, 1_000, 1_000], "the gateway's hint first");
    assert.deepEqual(waits.slice(5, 10), [5_000, 10_000, 20_000, 40_000, 60_000]);
    assert.ok(waits.every((w) => w <= 60_000));
  });

  it("an advertised short wait gets the same floor; a long advertised wait is honoured as is", async () => {
    const short = await paced('429: {"type":"inference_admission","reason":"queue_timeout","retry_after_ms":2000}', 8);
    assert.deepEqual(short.slice(0, 5), [2_000, 2_000, 2_000, 2_000, 2_000]);
    assert.deepEqual(short.slice(5), [5_000, 10_000, 20_000]);
    const long = await paced('429: {"type":"inference_admission","reason":"queue_timeout","retry_after_ms":90000}', 8);
    assert.ok(long.every((w) => w === 90_000));
  });

  it("after 30 minutes of waiting the pace slows to 3 minutes", async () => {
    const waits = await paced("capacity_unavailable", 60);
    let elapsed = 0;
    for (const w of waits) {
      if (elapsed >= 30 * 60_000) assert.ok(w >= 180_000, `at ${elapsed}ms waited only ${w}`);
      elapsed += w;
    }
    assert.ok(elapsed > 30 * 60_000);
  });
});

// ─── Review follow-up: relaunch cost, ceilings, cancellation ────────────────

function infraFailure() {
  return {
    executionId: "e",
    exitStatus: "failed" as const,
    summary: "Worker failed after 5 attempt(s): capacity_unavailable",
    artifactRefs: [],
    usage: {},
    error: "transient:server_unavailable",
  };
}

function schedulerHarness(opts: {
  resilience?: Partial<typeof DEFAULT_GATEWAY_RESILIENCE>;
  healthy: (now: number) => boolean;
  down: (now: number) => boolean;
}) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const m = makeMission(store);
  const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
  let now = 0;
  let calls = 0;
  let probes = 0;
  const scheduler = new MissionScheduler({
    store,
    broker: new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            calls++;
            return opts.down(now)
              ? infraFailure()
              : { executionId: "e", exitStatus: "succeeded" as const, summary: "ok", artifactRefs: [], usage: {} };
          },
        },
      },
    }),
    resilience: { ...DEFAULT_GATEWAY_RESILIENCE, ...opts.resilience },
    probe: {
      probe: async () => {
        probes++;
        return { healthy: opts.healthy(now) };
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
  });
  return {
    store,
    m,
    t,
    scheduler,
    stats: () => ({ calls, probes, now }),
  };
}

describe("long-wait policy: relaunch cost and ceilings", () => {
  it("while the probe says unhealthy, the worker is not relaunched at all", async () => {
    const h = schedulerHarness({ healthy: (now) => now >= 3 * HOUR, down: (now) => now < 3 * HOUR });
    await h.scheduler.runMission(h.m.mission_id);
    assert.equal(h.store.getTask(h.t.task_id)!.status, "SUCCEEDED");
    assert.ok(h.stats().calls <= 3, `calls=${h.stats().calls}: only the cheap probe ran during the outage`);
    assert.ok(h.stats().probes > 10);
  });

  it("a healthy-looking gateway whose task keeps failing hits the relaunch cap and FAILS with the reason", async () => {
    const h = schedulerHarness({
      resilience: { max_relaunches: 5 },
      healthy: () => true,
      down: () => true,
    });
    await h.scheduler.runMission(h.m.mission_id);
    const task = h.store.getTask(h.t.task_id) as unknown as { status: string; failure_reason?: string };
    assert.equal(task.status, "FAILED");
    assert.match(task.failure_reason ?? "", /relaunched 5 times/);
    assert.equal(h.stats().calls, 6);
  });

  it("the default relaunch cap is 100 and configurable", () => {
    assert.equal(DEFAULT_GATEWAY_RESILIENCE.max_relaunches, 100);
    assert.equal(resolveGatewayResilienceConfig({ PI_GATEWAY_MAX_RELAUNCHES: "40" }).max_relaunches, 40);
    assert.equal(DEFAULT_GATEWAY_RESILIENCE.max_outage_ms, 36 * HOUR);
    assert.equal(resolveGatewayResilienceConfig({ PI_GATEWAY_MAX_OUTAGE: "48h" }).max_outage_ms, 48 * HOUR);
  });

  it("an outage past the total ceiling FAILS the task with a clear reason, across pause and resume", async () => {
    const h = schedulerHarness({
      resilience: { max_relaunches: 1_000_000, max_outage_ms: 20 * HOUR },
      healthy: () => true,
      down: () => true,
    });
    await h.scheduler.runMission(h.m.mission_id);
    // The 12h window pauses the mission; resuming continues the SAME outage clock.
    assert.equal(h.store.getMission(h.m.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
    await h.scheduler.resumePausedMission(h.m.mission_id);
    const task = h.store.getTask(h.t.task_id) as unknown as { status: string; failure_reason?: string };
    assert.equal(task.status, "FAILED");
    assert.match(task.failure_reason ?? "", /outage lasted .*limit 20h 00m/);
    assert.match(task.failure_reason ?? "", /capacity_unavailable/);
  });

  it("awaitRecovery stops on abort and when the mission is no longer paused", async () => {
    const h = schedulerHarness({ healthy: () => false, down: () => true });
    h.store.transitionMission(h.m.mission_id, "PAUSED_INFRASTRUCTURE");
    const controller = new AbortController();
    const aborted = h.scheduler.awaitRecovery(10 * HOUR, controller.signal, h.m.mission_id);
    controller.abort();
    assert.equal(await aborted, false);
    assert.ok(h.stats().now < 10 * HOUR);

    // Resumed (or canceled) by someone else: stop watching.
    h.store.transitionMission(h.m.mission_id, "EXECUTING");
    const before = h.stats().probes;
    assert.equal(await h.scheduler.awaitRecovery(20 * HOUR, undefined, h.m.mission_id), false);
    assert.equal(h.stats().probes, before, "no probing for a mission that is not paused");
  });
});
