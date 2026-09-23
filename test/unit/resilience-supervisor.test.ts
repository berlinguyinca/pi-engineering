import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MissionSupervisor,
  type SupervisedStep,
  type SupervisorHooks,
} from "../../src/resilience/MissionSupervisor.ts";
import type { MissionCheckpoint } from "../../src/resilience/checkpoint.ts";
import { DEFAULT_GATEWAY_RESILIENCE } from "../../src/resilience/config.ts";
import type { RecoveryProbe } from "../../src/resilience/probe.ts";
import type { RetryWindowState } from "../../src/resilience/retryWindow.ts";

interface HarnessOpts {
  retryWindowMs?: number;
  probeIntervalMs?: number;
  autoResume?: boolean;
  preserve?: boolean;
  breakerThreshold?: number;
}

class Harness {
  state = "STARTING";
  probes = 0;
  checkpoints: MissionCheckpoint[] = [];
  persisted: RetryWindowState[] = [];
  logs: string[] = [];
  heartbeats = 0;
  transitions: string[] = [];
  private _now = 0;
  private readonly executeFn: (attempt: number) => Promise<unknown>;
  readonly supervisor: MissionSupervisor;

  constructor(executeFn: (attempt: number) => Promise<unknown>, probe: RecoveryProbe, opts: HarnessOpts = {}) {
    this.executeFn = executeFn;
    const config = {
      ...DEFAULT_GATEWAY_RESILIENCE,
      retry_window_ms: opts.retryWindowMs ?? DEFAULT_GATEWAY_RESILIENCE.retry_window_ms,
      probe_interval_ms: opts.probeIntervalMs ?? 1_000,
      auto_resume_on_recovery: opts.autoResume ?? true,
      preserve_mission_on_exhaustion: opts.preserve ?? true,
      jitter_ms: 0,
      request_timeout_ms: 120_000,
      connect_timeout_ms: 10_000,
      circuit_breaker_threshold: opts.breakerThreshold ?? 1000,
    };
    const hooks: SupervisorHooks = {
      transition: (from, to) => {
        this.transitions.push(`${from}->${to}`);
        this.state = to;
        return true;
      },
      checkpoint: (cp) => this.checkpoints.push(cp),
      heartbeat: () => {
        this.heartbeats += 1;
      },
      log: (_lvl, msg) => this.logs.push(msg),
      currentState: () => this.state,
      persistWindow: (w) => this.persisted.push(w),
    };
    this.supervisor = new MissionSupervisor({
      config,
      hooks,
      probe,
      now: () => this._now,
      sleep: async (ms: number) => {
        // Deterministic: each sleep advances the simulated clock so the retry
        // window eventually expires and the loop terminates.
        this._now += ms;
      },
      rand: () => 0,
      initialState: "STARTING",
    });
  }

  setNow(ms: number): void {
    this._now = ms;
  }

  run(step: Omit<SupervisedStep, "execute">): ReturnType<MissionSupervisor["run"]> {
    return this.supervisor.run({ ...step, execute: this.executeFn });
  }
}

function probeResult(healthy: boolean): RecoveryProbe {
  return { probe: async () => ({ healthy, authoritative: true }) };
}

function failingExecute(msg = "503 no worker for model"): (attempt: number) => Promise<never> {
  return async () => {
    throw new Error(msg);
  };
}

describe("MissionSupervisor", () => {
  it("succeeds immediately when the first attempt works", async () => {
    const h = new Harness(async () => "done", probeResult(true));
    h.setNow(1000);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(out.ok);
    assert.equal(out.succeeded, true);
    assert.equal(out.state, "EXECUTING");
  });

  it("checkpoints before the external LLM operation", async () => {
    const h = new Harness(async () => "done", probeResult(true));
    h.setNow(1000);
    await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(h.checkpoints.length >= 1);
    assert.equal(h.checkpoints[0]!.mission_id, "MSN-1");
    assert.equal(h.checkpoints[0]!.pending_action, "step-1");
  });

  it("a brief outage does not fail the mission (probes then succeeds)", async () => {
    let attempts = 0;
    const exec = async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("503 no worker for model");
      return "ok";
    };
    const h = new Harness(exec, probeResult(true), { retryWindowMs: 90 * 60_000 });
    h.setNow(0);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(out.ok);
    assert.ok(out.succeeded);
    assert.ok(out.probes >= 1, "probed for recovery between attempts");
  });

  it("on retry-window exhaustion the mission becomes PAUSED_INFRASTRUCTURE not FAILED", async () => {
    const h = new Harness(failingExecute(), probeResult(false), { retryWindowMs: 1_000 });
    h.setNow(0);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(!out.ok);
    assert.equal(out.state, "PAUSED_INFRASTRUCTURE");
    assert.equal(out.paused, true);
    assert.ok(h.logs.some((l) => l.includes("mission paused")));
  });

  it("an auth/config error goes to NEEDS_ATTENTION with no blind retry", async () => {
    const h = new Harness(
      async () => {
        throw new Error("401 invalid API key");
      },
      probeResult(true),
      { retryWindowMs: 90 * 60_000 },
    );
    h.setNow(0);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(!out.ok);
    assert.equal(out.state, "NEEDS_ATTENTION");
    assert.equal(out.category, "AUTH_CONFIG");
    assert.equal(out.probes, 0, "no probes for a non-retryable error");
  });

  it("a 413 context error maps to RECOVERING_CONTEXT (retryable, not infra)", async () => {
    const h = new Harness(
      async () => {
        throw new Error("413 context length exceeded");
      },
      probeResult(true),
      { retryWindowMs: 90 * 60_000 },
    );
    h.setNow(0);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.equal(out.category, "CONTEXT_RECOVERABLE");
    assert.ok(h.transitions.some((t) => t.includes("RECOVERING_CONTEXT")));
    void out;
  });

  it("a 429 rate-limit parks in WAITING_FOR_CAPACITY", async () => {
    const h = new Harness(
      async () => {
        throw new Error("429 caller_concurrency exceeded");
      },
      probeResult(true),
      { retryWindowMs: 90 * 60_000 },
    );
    h.setNow(0);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.equal(out.category, "RATE_LIMITED");
    assert.ok(h.transitions.some((t) => t.includes("WAITING_FOR_CAPACITY")));
    void out;
  });

  it("resumeIfRecovered resumes a PAUSED_INFRASTRUCTURE mission when the gateway is healthy", async () => {
    const h = new Harness(failingExecute(), probeResult(true), { autoResume: true });
    h.state = "PAUSED_INFRASTRUCTURE";
    const resumed = await h.supervisor.resumeIfRecovered();
    assert.ok(resumed);
    assert.equal(h.state, "EXECUTING");
    assert.ok(h.transitions.some((t) => t.includes("PAUSED_INFRASTRUCTURE->QUEUED")));
  });

  it("resumeIfRecovered does nothing when the gateway is still down", async () => {
    const h = new Harness(failingExecute(), probeResult(false), { autoResume: true });
    h.state = "PAUSED_INFRASTRUCTURE";
    const resumed = await h.supervisor.resumeIfRecovered();
    assert.ok(!resumed);
    assert.equal(h.state, "PAUSED_INFRASTRUCTURE");
  });

  it("logs compact progress lines, not stack traces", async () => {
    const h = new Harness(failingExecute(), probeResult(false), { retryWindowMs: 90 * 60_000 });
    h.setNow(0);
    await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    const retryLines = h.logs.filter((l) => l.includes("gateway unavailable — retrying"));
    assert.ok(retryLines.length >= 1);
    assert.ok(retryLines[0]!.includes("/ 01:30:00"), `expected window format in: ${retryLines[0]}`);
  });

  it("honours Retry-After over the default probe interval", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const h = new Harness(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("too many requests"), { status: 429, retry_after_ms: 5_000 });
        }
        return "ok";
      },
      probeResult(false),
      { retryWindowMs: 90 * 60_000, probeIntervalMs: 10_000 },
    );
    // Replace the supervisor's sleep with a recording one so we can assert the
    // gateway-supplied retry-after is honoured over the 10s default.
    const realSleep = (h.supervisor as unknown as { sleep: (ms: number) => Promise<void> }).sleep;
    Object.assign(h.supervisor, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        return realSleep.call(h.supervisor, ms);
      },
    } as Partial<typeof h.supervisor>);
    h.setNow(0);
    const out = await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(out.ok);
    // Retry-after from the error (5000) overrides the 10s probe interval.
    assert.equal(sleeps[0], 5_000);
    void realSleep;
  });

  it("opens the circuit breaker after the threshold and probes only while OPEN", async () => {
    const h = new Harness(failingExecute(), probeResult(false), {
      retryWindowMs: 90 * 60_000,
      probeIntervalMs: 10_000,
      breakerThreshold: 3,
    });
    h.setNow(0);
    await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    // 3 consecutive failures opened the breaker; afterwards the supervisor only
    // probes (no real requests) until the retry window closes.
    const breaker = (h.supervisor as unknown as { breaker: { snapshot(): { state: string } } }).breaker;
    assert.equal(breaker.snapshot().state, "OPEN");
    void h;
  });

  it("publishes heartbeats while waiting", async () => {
    const h = new Harness(failingExecute(), probeResult(false), { retryWindowMs: 90 * 60_000 });
    h.setNow(0);
    await h.run({ mission_id: "MSN-1", step_id: "step-1" });
    assert.ok(h.heartbeats >= 1);
  });
});
