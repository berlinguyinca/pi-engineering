/**
 * MissionSupervisor — owns mission lifecycle independent of individual
 * inference calls (resilience spec §1).
 *
 * Sits above the workflow -> router -> client stack. Instead of letting a
 * single InferWeave call's transient failure terminate a mission, the
 * supervisor:
 *
 *   1. classifies the error,
 *   2. parks the mission in the matching WAITING_* state,
 *   3. runs lightweight recovery probes every `probe_interval_ms +- jitter`,
 *   4. honours Retry-After when supplied,
 *   5. opens/closes a circuit breaker to avoid request storms,
 *   6. retries within a wall-clock retry window (default 90 min),
 *   7. on exhaustion defaults to PAUSED_INFRASTRUCTURE (NOT FAILED),
 *   8. auto-resumes when the gateway returns healthy,
 *   9. persists checkpoints before every external LLM operation so the mission
 *      survives a process restart with an unchanged retry deadline.
 *
 * The supervisor is transport-agnostic: it calls an `execute` function (the
 * inference/LLM call) and a `probe` function. All clocks/sleep/RNG are
 * injectable for deterministic fault-injection tests.
 */

import { type MissionCheckpoint, makeCheckpoint } from "./checkpoint.ts";
import { CircuitBreaker } from "./circuitBreaker.ts";
import { CATEGORY_TO_STATE, type InfraErrorCategory, classifyInfraError } from "./classify.ts";
import type { GatewayResilienceConfig } from "./config.ts";
import { IdempotencyRegistry, type RequestKey } from "./idempotency.ts";
import type { RecoveryProbe } from "./probe.ts";
import { type RetryWindowState, formatElapsed, recordProbe, startRetryWindow, windowOpen } from "./retryWindow.ts";
import { type WatchdogConfig, type WatchdogState, classifyStall, heartbeat as wdHeartbeat } from "./watchdog.ts";

/** A logical inference step the supervisor supervises. */
export interface SupervisedStep {
  mission_id: string;
  step_id: string;
  /** The LLM/inference call. Throws on failure; returns on success. */
  execute: (attempt: number) => Promise<unknown>;
}

/** Callbacks the supervisor uses to integrate with the mission runtime. */
export interface SupervisorHooks {
  /** Transition the mission to a state. Returns false to reject. */
  transition: (from: string, to: string) => boolean;
  /** Persist a checkpoint before an external LLM operation. */
  checkpoint: (cp: MissionCheckpoint) => void;
  /** Publish a heartbeat / state snapshot (compact). */
  heartbeat: (state: WatchdogState, missionState: string) => void;
  /** Emit a compact log line (no stack traces). */
  log: (level: "info" | "warn", message: string) => void;
  /** Current mission state string. */
  currentState: () => string;
  /** Persist the retry window (for restart survival). */
  persistWindow: (w: RetryWindowState) => void;
}

/** Outcome of supervising a step. */
export interface SupervisedOutcome {
  ok: boolean;
  /** Final mission state after the step. */
  state: string;
  /** Retry window state (for persistence / observability). */
  window: RetryWindowState;
  /** Total probes issued. */
  probes: number;
  /** True when the step was paused on infrastructure exhaustion. */
  paused: boolean;
  /** True when the step succeeded. */
  succeeded: boolean;
  /** The classified category that ended the step (when not ok). */
  category?: InfraErrorCategory;
}

/** Result of one execute attempt. */
interface AttemptResult {
  success: boolean;
  value?: unknown;
  category?: InfraErrorCategory;
  retryAfterMs?: number;
  error?: unknown;
}

/** Deterministic default sleep (real timers). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MissionSupervisor {
  private readonly config: GatewayResilienceConfig;
  private readonly hooks: SupervisorHooks;
  private readonly probe: RecoveryProbe;
  private readonly registry: IdempotencyRegistry;
  private readonly breaker: CircuitBreaker;
  private readonly watchdog: WatchdogConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  private wd: WatchdogState;

  constructor(opts: {
    config: GatewayResilienceConfig;
    hooks: SupervisorHooks;
    probe: RecoveryProbe;
    watchdog?: WatchdogConfig;
    registry?: IdempotencyRegistry;
    breaker?: CircuitBreaker;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    rand?: () => number;
    initialState?: string;
  }) {
    this.config = opts.config;
    this.hooks = opts.hooks;
    this.probe = opts.probe;
    this.registry = opts.registry ?? new IdempotencyRegistry();
    this.breaker = opts.breaker ?? new CircuitBreaker({ threshold: opts.config.circuit_breaker_threshold });
    this.watchdog = opts.watchdog ?? DEFAULT_WATCHDOG_FALLBACK;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
    this.rand = opts.rand ?? Math.random;
    const t = this.now();
    this.wd = {
      last_heartbeat_at_ms: t,
      last_llm_success_at_ms: t,
      last_tool_progress_at_ms: t,
      mission_state: opts.initialState ?? "STARTING",
    };
  }

  /**
   * Supervise a logical inference step within the retry window.
   *
   * The step's `request_id` is stable across retries (idempotency); the
   * supervisor issues at most one logical inference attempt at a time, probing
   * for recovery in between. On retry-window exhaustion the mission goes to
   * PAUSED_INFRASTRUCTURE (not FAILED) unless configured otherwise.
   */
  async run(step: SupervisedStep): Promise<SupervisedOutcome> {
    const nowMs = this.now();
    const window = startRetryWindow(nowMs, this.config.retry_window_ms);
    const requestKey = this.registry.beginRequest(step.mission_id, step.step_id);
    let attempt = 1;
    let probes = 0;
    let category: InfraErrorCategory | undefined;

    // Checkpoint BEFORE the external LLM operation.
    this.persistCheckpoint(step, requestKey, window);

    // Retry-After override from the last classified error, if any. Honoured
    // over the default probe interval when the gateway supplies one.
    let retryAfterMs: number | undefined;

    while (windowOpen(window, this.now())) {
      // Heartbeat (independent of LLM activity).
      this.publishHeartbeat(step.mission_id);

      // Circuit breaker gate: while OPEN only probe; on half-open send one real.
      if (!this.breaker.allowRequest()) {
        probes += await this.probeAndWait(window, retryAfterMs);
        this.publishHeartbeat(step.mission_id);
        continue;
      }

      const res = await this.executeAttempt(step, attempt, requestKey);
      attempt += 1;

      if (res.success) {
        this.breaker.recordSuccess();
        this.recordLlmSuccess();
        this.hooks.transition(this.hooks.currentState(), "EXECUTING");
        this.hooks.log("info", `step ${step.step_id} completed`);
        return {
          ok: true,
          state: "EXECUTING",
          window,
          probes,
          paused: false,
          succeeded: true,
        };
      }

      category = res.category ?? "TRANSIENT_INFRASTRUCTURE";
      retryAfterMs = res.retryAfterMs;
      this.breaker.recordFailure();

      // Non-retryable: auth/config/invalid -> NEEDS_ATTENTION, no blind retry.
      if (!this.retryable(category)) {
        this.hooks.transition(this.hooks.currentState(), "NEEDS_ATTENTION");
        this.hooks.log("warn", `step ${step.step_id}: ${category} — needs attention (no blind retry)`);
        return {
          ok: false,
          state: "NEEDS_ATTENTION",
          window,
          probes,
          paused: false,
          succeeded: false,
          category,
        };
      }

      // Park in the matching WAITING_* state.
      this.park(category, step, window);

      // Probe for recovery (lightweight, not a prompt re-send).
      probes += await this.probeAndWait(window, retryAfterMs);
      retryAfterMs = undefined;

      this.publishHeartbeat(step.mission_id);
      this.hooks.log(
        "warn",
        `gateway unavailable — retrying (${formatElapsed(this.elapsed(window))} / ${formatElapsed(this.config.retry_window_ms)})`,
      );
    }

    // Retry window exhausted.
    if (this.config.preserve_mission_on_exhaustion) {
      this.hooks.transition(this.hooks.currentState(), "PAUSED_INFRASTRUCTURE");
      this.hooks.log(
        "warn",
        `retry window exhausted — mission paused (${category ?? "TRANSIENT_INFRASTRUCTURE"}), progress preserved`,
      );
      return { ok: false, state: "PAUSED_INFRASTRUCTURE", window, probes, paused: true, succeeded: false, category };
    }
    this.hooks.transition(this.hooks.currentState(), "FAILED");
    return { ok: false, state: "FAILED", window, probes, paused: false, succeeded: false, category };
  }

  /**
   * Resume a paused mission once the gateway is healthy: PAUSED_INFRASTRUCTURE
   * -> QUEUED -> STARTING -> EXECUTING. Returns true when resumed.
   */
  async resumeIfRecovered(): Promise<boolean> {
    if (!this.config.auto_resume_on_recovery) return false;
    if (this.hooks.currentState() !== "PAUSED_INFRASTRUCTURE") return false;
    const result = await this.probe.probe();
    if (!result.healthy) return false;
    this.hooks.transition("PAUSED_INFRASTRUCTURE", "QUEUED");
    this.hooks.transition("QUEUED", "STARTING");
    this.hooks.transition("STARTING", "EXECUTING");
    this.breaker.recordSuccess();
    this.hooks.log("info", "gateway recovered — resuming mission");
    return true;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private executeAttempt(step: SupervisedStep, attempt: number, key: RequestKey): Promise<AttemptResult> {
    return Promise.resolve()
      .then(() => step.execute(attempt))
      .then(
        (value): AttemptResult => ({ success: true, value }),
        (error): AttemptResult => {
          const cls = classifyInfraError(error);
          return {
            success: false,
            category: cls.category,
            retryAfterMs: cls.retryAfterMs,
            error,
          };
        },
      );
  }

  private retryable(category: InfraErrorCategory): boolean {
    if (!this.config.retry_transient_errors) return false;
    return category === "TRANSIENT_INFRASTRUCTURE" || category === "RATE_LIMITED" || category === "CONTEXT_RECOVERABLE";
  }

  private park(category: InfraErrorCategory, step: SupervisedStep, window: RetryWindowState): void {
    const state = CATEGORY_TO_STATE[category];
    this.hooks.transition(this.hooks.currentState(), state);
    // Refresh the checkpoint so the parked state survives a restart.
    const key = this.registry.beginRequest(step.mission_id, step.step_id);
    this.persistCheckpoint(step, key, window);
  }

  private async probeAndWait(window: RetryWindowState, retryAfterMs?: number): Promise<number> {
    const result = await this.probe.probe();
    const nowMs = this.now();
    const updated = recordProbe(window, nowMs);
    this.hooks.persistWindow(updated);
    // Honour an explicit retry-after hint over the default probe interval.
    const wait = result.retry_after_ms ?? retryAfterMs ?? this.probeDelay(1);
    await this.sleep(wait);
    return 1;
  }

  /** Compute the next probe delay: base interval + positive jitter. */
  private probeDelay(attempt: number): number {
    const base = this.config.probe_interval_ms;
    const jitter = this.config.jitter_ms > 0 ? this.config.jitter_ms * this.rand() : 0;
    void attempt;
    return base + Math.round(jitter);
  }

  private persistCheckpoint(step: SupervisedStep, key: RequestKey, window: RetryWindowState): void {
    const cp: MissionCheckpoint = makeCheckpoint({
      mission_id: step.mission_id,
      workflow: "engineering",
      current_phase: "executing",
      current_step: step.step_id,
      step_state: this.hooks.currentState(),
      working_directory: ".",
      repository: ".",
      branch: "main",
      base_ref: "main",
      last_completed_action: "",
      pending_action: step.step_id,
      request: key,
      retry_started_at_ms: window.retry_started_at_ms,
      retry_deadline_ms: window.retry_deadline_ms,
      tool_results: {},
      artifacts: [],
    });
    this.hooks.checkpoint(cp);
  }

  private publishHeartbeat(missionId: string): void {
    const nowMs = this.now();
    this.wd = wdHeartbeat(this.wd, nowMs);
    this.wd = { ...this.wd, mission_state: this.hooks.currentState() };
    this.hooks.heartbeat(this.wd, this.hooks.currentState());
    void missionId;
  }

  private recordLlmSuccess(): void {
    const nowMs = this.now();
    this.wd = { ...this.wd, last_llm_success_at_ms: nowMs };
  }

  private elapsed(window: RetryWindowState): number {
    return this.now() - window.retry_started_at_ms;
  }

  /** Current watchdog state (for observability). */
  get watchdogState(): WatchdogState {
    return this.wd;
  }

  /** Advise whether the mission is stalled (watchdog). */
  stallAdvice(): string {
    return classifyStall(this.wd, this.now(), this.watchdog);
  }
}

const DEFAULT_WATCHDOG_FALLBACK: WatchdogConfig = {
  heartbeat_interval_ms: 10_000,
  inference_stall_threshold_ms: 5 * 60_000,
  tool_stall_threshold_ms: 10 * 60_000,
  auto_recover: true,
};
