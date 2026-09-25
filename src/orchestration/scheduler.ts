/**
 * Mission DAG scheduler (spec 02, spec 04).
 *
 * Runs a mission's tasks in dependency order with:
 *   - write-domain conflict detection (reuses `taskDag` scopesOverlap);
 *   - concurrency limits (global, per-role, per-repository);
 *   - retry with a failure classifier;
 *   - cancellation propagation;
 *   - background execution (the scheduler runs tasks as they become runnable,
 *     not in a single blocking top-to-bottom loop).
 *
 * A task becomes runnable when all deps are SUCCEEDED, no write-domain conflict
 * with an active mutator exists, and concurrency policy permits.
 */

import { CircuitBreaker } from "../resilience/circuitBreaker.ts";
import type { InfraErrorCategory } from "../resilience/classify.ts";
import { CATEGORY_TO_STATE } from "../resilience/classify.ts";
import { type GatewayResilienceConfig, resolveGatewayResilienceConfig } from "../resilience/config.ts";
import { type RecoveryProbe, healthyProbe } from "../resilience/probe.ts";
import { type RetryWindowState, recordProbe, startRetryWindow, windowOpen } from "../resilience/retryWindow.ts";
import { type SchedulableTask, Scheduler } from "../sched/Scheduler.ts";
import type { ExecutionBroker, ExecutionHandle, ExecutionRequestInput } from "./broker.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionStatus, OrchestrationTask, TaskKind, TaskStatus } from "./types.ts";

/** Real clock/sleep for production; tests inject deterministic fakes. */
const realNow = (): number => Date.now();
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Map a worker failure marker (`transient:<category>`) to the resilience
 * infrastructure category. Returns null for markers that are NOT a confident
 * transient-infrastructure failure (so those keep the existing failure path).
 */
function infraCategoryFromWorkerMarker(marker?: string): InfraErrorCategory | null {
  if (!marker || !marker.startsWith("transient:")) return null;
  const sub = marker.slice("transient:".length);
  switch (sub) {
    case "rate_limit":
      return "RATE_LIMITED";
    case "compaction":
      return "CONTEXT_RECOVERABLE";
    case "permanent":
    case "model_unavailable":
      // An unknown model already had its one catalog-resync retry in the
      // worker; the gateway is healthy, so the infra window would only hide a
      // configuration error behind a 90-minute wait and a paused mission.
      return null;
    default:
      // server_unavailable, server_error, network, timeout
      return "TRANSIENT_INFRASTRUCTURE";
  }
}

export interface SchedulerLimits {
  maxActive: number;
  maxAgents: number;
  maxSubprocesses: number;
  maxPerRole: number;
}

export const DEFAULT_LIMITS: SchedulerLimits = {
  maxActive: 6,
  maxAgents: 3,
  maxSubprocesses: 3,
  maxPerRole: 2,
};

export interface ScheduledTaskResult {
  taskId: string;
  status: TaskStatus;
  attempt: number;
}

export interface SchedulerOptions {
  store: MissionStore;
  broker: ExecutionBroker;
  limits?: Partial<SchedulerLimits>;
  /** Called when a task reaches a terminal state. */
  onTaskSettled?: (missionId: string, taskId: string, status: TaskStatus) => void;
  /**
   * Mission-level gateway resilience config. Defaults to the environment-resolved
   * config (90-min time-based window, 10s probes, auto-resume). A transient
   * infrastructure failure in a worker is retried within this window (parking
   * the mission in a WAITING_* state) instead of failing the task; on exhaustion
   * the mission pauses (PAUSED_INFRASTRUCTURE), not fails.
   */
  resilience?: GatewayResilienceConfig;
  /** Lightweight gateway recovery probe. Defaults to a pass-through healthy probe. */
  probe?: RecoveryProbe;
  /** Injectable clock (default Date.now) for the retry window + circuit breaker. */
  now?: () => number;
  /** Injectable sleep (default real setTimeout) for probe waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG (default Math.random) for probe jitter. */
  rand?: () => number;
}

/** Failure classifier (spec 02 retry/recovery). */
export function classifyFailure(
  err: unknown,
  task: OrchestrationTask,
): { action: "retry" | "repair" | "replan" | "block"; reason: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const low = msg.toLowerCase();
  if (/(transient|timeout|429|rate.?limit|network|econnreset|temporary)/.test(low)) {
    return { action: "retry", reason: `transient: ${msg}` };
  }
  if (/(context overflow|too long|max tokens|token limit)/.test(low)) {
    return { action: "retry", reason: `context overflow: ${msg}` };
  }
  if (/(merge conflict|conflict|unmerged)/.test(low)) {
    return { action: "repair", reason: `integration conflict: ${msg}` };
  }
  if (/(test fail|assertion|expected.*actual|compile error|type error)/.test(low)) {
    return { action: "repair", reason: `validation failed: ${msg}` };
  }
  return { action: task.failure_policy === "block" ? "block" : "retry", reason: msg };
}

/** Normalize a write domain: strip trailing slash and a trailing `/**` glob. */
export function normalizeDomain(d: string): string {
  return d.replace(/\/$/, "").replace(/\/\*\*$/, "");
}

/** True when two mutating tasks have overlapping write domains. */
export function domainsOverlap(a: string[], b: string[]): boolean {
  for (const rawX of a) {
    for (const rawY of b) {
      const x = normalizeDomain(rawX);
      const y = normalizeDomain(rawY);
      if (x === y) return true;
      if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}

export class MissionScheduler {
  private readonly store: MissionStore;
  private readonly broker: ExecutionBroker;
  private readonly limits: SchedulerLimits;
  private readonly onTaskSettled?: SchedulerOptions["onTaskSettled"];
  /** Active executions by task id (for write-domain conflict detection). */
  private readonly activeTasks = new Map<string, OrchestrationTask>();
  /** Counters for concurrency limits. */
  private counters = { agents: 0, subprocesses: 0, byRole: new Map<string, number>() };
  private queue: Scheduler;
  /** Mission-level gateway resilience config (time-based window, probes). */
  private readonly resilience: GatewayResilienceConfig;
  /** Lightweight gateway recovery probe. */
  private readonly probe: RecoveryProbe;
  private readonly clockNow: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  /** Per-task active retry window (created on the first infra failure). */
  private readonly windows = new Map<string, RetryWindowState>();
  /** Per-task circuit breaker (prevents a request storm during recovery). */
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.broker = opts.broker;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.onTaskSettled = opts.onTaskSettled;
    // Resolve the time-based resilience config (env-overridable). Resilience is
    // ON by default so missions survive gateway outages; a probe + clock + sleep
    // are injectable for deterministic fault-injection tests.
    this.resilience = opts.resilience ?? resolveGatewayResilienceConfig();
    this.probe = opts.probe ?? healthyProbe();
    this.clockNow = opts.now ?? realNow;
    this.sleepFn = opts.sleep ?? realSleep;
    this.rand = opts.rand ?? Math.random;
    this.queue = new Scheduler({ concurrency: this.limits.maxActive });
  }

  /**
   * Compute the set of tasks that are runnable RIGHT NOW given current state:
   * deps all SUCCEEDED, no active write-domain conflict, concurrency has room.
   */
  runnable(missionId: string): OrchestrationTask[] {
    const tasks = this.store.listTasks(missionId);
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const active = [...this.activeTasks.values()];
    const out: OrchestrationTask[] = [];
    for (const t of tasks) {
      if (t.status !== "PENDING" && t.status !== "READY" && t.status !== "WAITING") continue;
      if (t.status === "WAITING") {
        // Approvals etc. handled by caller; treat as not runnable here.
        continue;
      }
      const depsDone = t.depends_on.every((d) => byId.get(d)?.status === "SUCCEEDED");
      if (!depsDone) continue;
      if (t.mutates_repo) {
        const conflict = active.some((a) => a.mutates_repo && domainsOverlap(a.write_domains, t.write_domains));
        if (conflict) continue;
      }
      if (!this.hasCapacity(t)) continue;
      out.push(t);
    }
    return out;
  }

  private hasCapacity(t: OrchestrationTask): boolean {
    const kind = t.kind;
    if (kind === "agent" && this.counters.agents >= this.limits.maxAgents) return false;
    if ((kind === "process" || kind === "validation") && this.counters.subprocesses >= this.limits.maxSubprocesses) {
      return false;
    }
    if ((this.counters.byRole.get(t.role) ?? 0) >= this.limits.maxPerRole) return false;
    return true;
  }

  private acquire(t: OrchestrationTask): void {
    this.activeTasks.set(t.task_id, t);
    if (t.kind === "agent") this.counters.agents++;
    if (t.kind === "process" || t.kind === "validation") this.counters.subprocesses++;
    this.counters.byRole.set(t.role, (this.counters.byRole.get(t.role) ?? 0) + 1);
  }

  private release(t: OrchestrationTask): void {
    this.activeTasks.delete(t.task_id);
    if (t.kind === "agent") this.counters.agents--;
    if (t.kind === "process" || t.kind === "validation") this.counters.subprocesses--;
    this.counters.byRole.set(t.role, Math.max(0, (this.counters.byRole.get(t.role) ?? 0) - 1));
  }

  /** Run a mission to a terminal state, executing runnable tasks as capacity allows. */
  async runMission(missionId: string, signal?: AbortSignal): Promise<void> {
    // Topological sanity check (throws on cycle).
    assertAcyclic(this.store.listTasks(missionId));
    let done = false;
    while (!done && !signal?.aborted) {
      const mission = this.store.getMission(missionId);
      if (!mission || mission.status === "CANCELED" || mission.status === "FAILED" || mission.status === "COMPLETE") {
        return;
      }
      const runnable = this.runnable(missionId);
      const terminal = this.store
        .listTasks(missionId)
        .filter((t) => ["SUCCEEDED", "FAILED", "CANCELED", "SKIPPED"].includes(t.status)).length;
      const total = this.store.listTasks(missionId).length;

      if (runnable.length === 0) {
        // Nothing runnable now. If every task is terminal, we are done; else
        // something is BLOCKED/WAITING (handled by caller) or a conflict that
        // will clear when an active task settles.
        if (terminal === total || total === 0) done = true;
        else if (this.activeTasks.size === 0) {
          // No active task and nothing runnable but not all terminal → blocked.
          const blocked = this.store
            .listTasks(missionId)
            .filter((t) => !["SUCCEEDED", "FAILED", "CANCELED", "SKIPPED"].includes(t.status));
          if (blocked.length > 0) {
            // Deadlock or all deps failed; leave for orchestrator.
            done = true;
          }
        }
        // If active tasks exist, wait for them.
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }

      // Launch runnable tasks incrementally, re-checking write-domain conflict
      // against tasks acquired earlier in this same pass so overlapping domains
      // serialize even when they were both "runnable" at pass start.
      for (const task of runnable) {
        if (signal?.aborted) break;
        if (this.hasConflict(task)) continue;
        // Idempotent: a resumed (already-READY) task must not throw on
        // READY -> READY; only transition from PENDING/WAITING.
        if (this.store.getTask(task.task_id)?.status !== "READY") {
          this.store.transitionTask(task.task_id, "READY");
        }
        this.acquire(task);
        void this.runOne(task);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private hasConflict(t: OrchestrationTask): boolean {
    if (!t.mutates_repo) return false;
    return [...this.activeTasks.values()].some(
      (a) => a.mutates_repo && domainsOverlap(a.write_domains, t.write_domains),
    );
  }

  /** Execute a single task with retry via the broker. */
  private async runOne(task: OrchestrationTask): Promise<void> {
    try {
      await this.executeWithRetry(task);
    } finally {
      this.release(task);
      this.onTaskSettled?.(task.mission_id, task.task_id, this.store.getTask(task.task_id)?.status ?? "FAILED");
    }
  }

  private async executeWithRetry(task: OrchestrationTask): Promise<void> {
    let attempt = task.attempt;
    while (true) {
      attempt++;
      // Resilience probe gate: when a time-based retry window is active for this
      // task (a prior transient infrastructure failure), start a fresh worker
      // attempt ONLY once the recovery probe reports the gateway healthy; otherwise
      // wait the probe interval and re-check, without burning a full worker session.
      // On window exhaustion the mission is PAUSED (not FAILED).
      const gate = await this.probeGate(task);
      if (gate === "paused") return;
      if (gate === "wait") continue;

      let handle: ExecutionHandle;
      try {
        // execute() itself can throw (e.g. no backend registered for the kind).
        // Left outside the try it escaped the fire-and-forget run as an
        // unhandled rejection and left the task stuck in READY, which then threw
        // an illegal READY -> READY transition on the next pass.
        handle = await this.broker.execute({
          taskId: task.task_id,
          missionId: task.mission_id,
          kind: brokerKind(task.kind),
          role: task.role,
          objective: task.objective,
          mutatesRepo: task.mutates_repo,
          writeDomains: task.write_domains,
          isolation: task.isolation,
          modelRequirements: task.execution_requirements,
        });
        this.store.transitionTask(task.task_id, "RUNNING", "system", {
          attempt,
          assigned_execution_id: handle.executionId,
        });
        const outcome = await handle.result();
        // A task canceled underneath the runner (constraint steering) is already
        // CANCELED; CANCELED -> SUCCEEDED is an illegal transition and used to
        // escape as an unhandled rejection from the fire-and-forget run.
        if (this.store.getTask(task.task_id)?.status !== "RUNNING") return;
        // Resolution is not success: backends report failure through exitStatus
        // without throwing. Treating resolution as success let a failed worker
        // satisfy the completion gate.
        if (outcome.exitStatus !== "succeeded") {
          // A worker transient-infra marker (e.g. `transient:server_unavailable`)
          // enters the time-based resilience window (park in WAITING_*, retry,
          // pause on exhaustion) instead of immediately failing the task. Other
          // non-throwing failures keep the existing behaviour.
          const infraCat = infraCategoryFromWorkerMarker(outcome.error);
          if (infraCat) {
            const res = this.resilienceGate(task, infraCat);
            if (res.paused) return;
            if (res.retry) {
              this.store.transitionTask(task.task_id, "RETRYING", "system", { attempt });
              await this.sleepFn(res.waitMs);
              continue;
            }
          }
          // Surface the worker's own result summary (guard aborts, budget
          // exhaustion, timeouts, no-result) — exitStatus alone hid the cause.
          const detail = outcome.summary ? `: ${outcome.summary}` : "";
          this.store.transitionTask(task.task_id, "FAILED", "system", {
            failure_reason: `backend reported ${outcome.exitStatus}${detail}`,
          });
          return;
        }
        // Success: clear the resilience window, close the breaker, and resume the
        // mission out of any WAITING state it was parked in.
        this.breakerSuccess(task);
        this.clearResilience(task);
        this.resumeToExecuting(task.mission_id);
        this.store.transitionTask(task.task_id, "SUCCEEDED");
        return;
      } catch (err) {
        if (this.store.getTask(task.task_id)?.status === "CANCELED") return;
        // Thrown failures (e.g. no backend registered) keep the existing
        // attempt-count repair path; the time-based window applies to the
        // worker's non-throwing transient-infrastructure outcomes above.
        const { action, reason } = classifyFailure(err, task);
        if (action === "retry" && attempt < task.max_attempts) {
          this.store.transitionTask(task.task_id, "RETRYING", "system", { attempt });
          continue;
        }
        this.store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: reason });
        return;
      }
    }
  }

  /**
   * Probe gate: active only when a resilience retry window exists for the task.
   * Waits for gateway recovery before starting a real worker attempt, and pauses
   * the mission (not fails) when the retry window is exhausted.
   *   "proceed" — start a real attempt now;
   *   "wait"    — sleep (already done) and re-loop without an attempt;
   *   "paused"  — window exhausted; the mission is paused, stop.
   */
  private async probeGate(task: OrchestrationTask): Promise<"proceed" | "wait" | "paused"> {
    const window = this.windows.get(task.task_id);
    if (!window) return "proceed";
    const cfg = this.resilience;
    if (!windowOpen(window, this.clockNow())) return this.pauseMission(task) ? "paused" : "proceed";
    // Circuit breaker: while OPEN and the cooldown has not elapsed, only probe.
    const breaker = this.breakers.get(task.task_id);
    if (breaker && !breaker.allowRequest()) {
      await this.sleepFn(cfg.probe_interval_ms);
      return "wait";
    }
    breaker?.tryHalfOpen();
    const result = await this.probe.probe();
    if (result.healthy) return "proceed";
    // Gateway still down: honour the reported wait (else the probe interval),
    // then re-probe without a real attempt.
    await this.sleepFn(result.retry_after_ms ?? cfg.probe_interval_ms);
    return "wait";
  }

  /**
   * Decide the resilience action for a transient-infrastructure failure. Within
   * the retry window, parks the mission in the matching WAITING_* state and
   * schedules a retry; on exhaustion pauses the mission (NOT FAILED) and leaves
   * the task resumable. Returns retry=false when resilience should not apply
   * (disabled) so the caller falls through to normal failure handling.
   */
  private resilienceGate(
    task: OrchestrationTask,
    cat: InfraErrorCategory,
  ): { retry: boolean; waitMs: number; paused: boolean } {
    const cfg = this.resilience;
    if (!cfg || !cfg.retry_transient_errors) return { retry: false, waitMs: 0, paused: false };
    let window = this.windows.get(task.task_id);
    if (!window) {
      window = startRetryWindow(this.clockNow(), cfg.retry_window_ms);
      this.windows.set(task.task_id, window);
    }
    if (!windowOpen(window, this.clockNow())) {
      if (this.pauseMission(task)) return { retry: false, waitMs: 0, paused: true };
      return { retry: false, waitMs: 0, paused: false };
    }
    // Park the mission in the state matching the failure category and record the
    // probe; the task is left resumable by the caller (RETRYING).
    this.parkMission(task.mission_id, CATEGORY_TO_STATE[cat] as MissionStatus);
    this.breakerFailure(task);
    this.windows.set(task.task_id, recordProbe(window, this.clockNow()));
    const wait = cfg.probe_interval_ms + (cfg.jitter_ms > 0 ? Math.round(cfg.jitter_ms * this.rand()) : 0);
    return { retry: true, waitMs: wait, paused: false };
  }

  /** Park the mission in a state; idempotent and safe against illegal transitions. */
  private parkMission(missionId: string, state: MissionStatus): void {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.status === state) return;
    try {
      this.store.transitionMission(missionId, state);
    } catch {
      /* mission already in an incompatible state — leave it */
    }
  }

  /** Resume a parked mission back to EXECUTING after a task succeeds. Only when
   * no other task in the mission is still paused (RETRYING), so a mission with a
   * paused task never reports EXECUTING. */
  private resumeToExecuting(missionId: string): void {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.status === "EXECUTING") return;
    const parked: MissionStatus[] = [
      "WAITING_FOR_LLM",
      "WAITING_FOR_CAPACITY",
      "WAITING_FOR_GATEWAY",
      "WAITING_FOR_MODEL",
      "WAITING_FOR_TOOL",
      "RECOVERING_CONTEXT",
      "RECOVERING_PROCESS",
      "PAUSED_INFRASTRUCTURE",
    ];
    if (!parked.includes(mission.status)) return;
    const anyPaused = this.store.listTasks(missionId).some((t) => t.status === "RETRYING");
    if (anyPaused) return;
    try {
      this.store.transitionMission(missionId, "EXECUTING");
    } catch {
      /* ignore */
    }
  }

  /** Pause a mission on retry-window exhaustion: PAUSED (not FAILED), resumable. */
  private pauseMission(task: OrchestrationTask): boolean {
    const mission = this.store.getMission(task.mission_id);
    if (!mission) return false;
    this.parkMission(task.mission_id, "PAUSED_INFRASTRUCTURE");
    this.markTaskResumable(task);
    this.clearResilience(task);
    return true;
  }

  /** Leave a task in a resumable non-terminal state (RETRYING) for later re-run. */
  private markTaskResumable(task: OrchestrationTask): void {
    const status = this.store.getTask(task.task_id)?.status;
    if (status === "RUNNING") {
      this.store.transitionTask(task.task_id, "RETRYING", "system", {
        failure_reason: "infrastructure retry window exhausted — paused (auto-resume on recovery)",
      });
    }
  }

  private breakerFailure(task: OrchestrationTask): void {
    let breaker = this.breakers.get(task.task_id);
    if (!breaker) {
      breaker = new CircuitBreaker({
        threshold: this.resilience.circuit_breaker_threshold,
        openCooldownMs: this.resilience.probe_interval_ms,
        now: this.clockNow,
      });
      this.breakers.set(task.task_id, breaker);
    }
    breaker.recordFailure();
  }

  private breakerSuccess(task: OrchestrationTask): void {
    this.breakers.get(task.task_id)?.recordSuccess();
    this.breakers.delete(task.task_id);
  }

  /** Drop the task's retry window + breaker (used on success and pause). */
  private clearResilience(task: OrchestrationTask): void {
    this.windows.delete(task.task_id);
    this.breakers.delete(task.task_id);
  }

  /** Lightweight gateway readiness check (for auto-resume decisions). */
  async gatewayHealthy(): Promise<boolean> {
    const result = await this.probe.probe();
    return result.healthy;
  }

  /**
   * Re-run the paused task(s) of a mission whose infrastructure has recovered.
   * Transitions any RETRYING (resumable) tasks back to READY and drives the
   * scheduler to a new terminal state. Called on auto-resume (gateway healthy)
   * or on operator restart. Returns the final mission status.
   */
  async resumePausedMission(missionId: string, signal?: AbortSignal): Promise<MissionStatus> {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    // Only a paused mission is resumable here.
    if (mission.status !== "PAUSED_INFRASTRUCTURE") return mission.status;
    this.resumeToExecuting(missionId);
    // Re-queue any resumable (RETRYING) tasks.
    for (const t of this.store.listTasks(missionId)) {
      if (t.status === "RETRYING") {
        try {
          this.store.transitionTask(t.task_id, "READY");
        } catch {
          /* already re-queued */
        }
      }
    }
    await this.runMission(missionId, signal);
    return this.store.getMission(missionId)?.status ?? "FAILED";
  }
}

/** Build scheduler tasks for the shared concurrency Scheduler (unused wrapper). */
export function toSchedulable(t: OrchestrationTask, run: () => Promise<unknown>): SchedulableTask<unknown> {
  return { id: t.task_id, source: t.mission_id, run };
}

/** Map a domain task kind to a broker execution kind. */
export function brokerKind(kind: TaskKind): ExecutionRequestInput["kind"] {
  switch (kind) {
    case "agent":
    case "research":
      return kind;
    case "process":
      return "process";
    case "review":
      return "review";
    case "integration":
      return "integration";
    case "validation":
      return "validation";
    // Approval/aggregation are agent-shaped logical work.
    case "approval":
    case "aggregation":
      return "agent";
  }
}

/** Throw on a dependency cycle in a mission's task list. */
export function assertAcyclic(tasks: OrchestrationTask[]): void {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (t: OrchestrationTask): void => {
    if (visited.has(t.task_id)) return;
    if (visiting.has(t.task_id)) {
      throw new Error(`mission task dependency cycle detected at ${t.task_id}`);
    }
    visiting.add(t.task_id);
    for (const d of t.depends_on) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    visiting.delete(t.task_id);
    visited.add(t.task_id);
  };
  for (const t of tasks) visit(t);
}
