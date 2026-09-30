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

import { formatWaitingFor } from "../gateway/admissionNotice.ts";
import { CircuitBreaker } from "../resilience/circuitBreaker.ts";
import type { InfraErrorCategory } from "../resilience/classify.ts";
import { CATEGORY_TO_STATE } from "../resilience/classify.ts";
import { type GatewayResilienceConfig, resolveGatewayResilienceConfig } from "../resilience/config.ts";
import { type ProbeResult, type RecoveryProbe, healthyProbe } from "../resilience/probe.ts";
import { type RetryWindowState, recordProbe, startRetryWindow, windowOpen } from "../resilience/retryWindow.ts";
import { type SchedulableTask, Scheduler } from "../sched/Scheduler.ts";
import type { ExecutionBroker, ExecutionHandle, ExecutionRequestInput } from "./broker.ts";
import type { MissionStore } from "./missionStore.ts";
import type { DispatchAuthority } from "./ownership.ts";
import { FailureClassifier, type FailureEvidence, RecoveryPlanner, type RecoveryPlannerOptions } from "./recovery.ts";
import type { MissionStatus, OrchestrationTask, TaskKind, TaskStatus } from "./types.ts";
import { canonicalizeWriteDomain } from "./workset.ts";

/** Real clock/sleep for production; tests inject deterministic fakes. */
const realNow = (): number => Date.now();
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * Consecutive "gateway up, model not listed" probes before one real attempt is
 * let through the probe gate (issue #76).
 */
export const UNLISTED_PROBES_BEFORE_VERIFY = 3;

/** Status reason when an unlisted model gets one real attempt to confirm. */
function unlistedVerifyReason(result: ProbeResult): string {
  const model = result.model_id ? `model ${result.model_id}` : "the model";
  return `${model} is not listed by the gateway; trying it once to confirm`;
}

type AbortableResult<T> = { aborted: true } | { aborted: false; value: T };

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
    // An unknown model already had its one catalog-resync retry in the worker;
    // the gateway is healthy, so the infra window would only hide a
    // configuration error behind hours of waiting and a paused mission.
    // A bare 5xx ("server_error": no envelope, reason or refusal code) that
    // outlasted the worker's short retries is not evidence of an outage that
    // clears either: a deterministic upstream failure looks exactly like it.
    case "permanent":
    case "model_unavailable":
    case "server_error":
      return null;
    default:
      // server_unavailable, network, timeout
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
  /** Called whenever execution has no active worker because recovery is waiting or has stopped. */
  onStatus?: (notice: MissionSchedulerStatusNotice) => void;
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
  /** Acquires renewable mission/repository fencing immediately before each dispatch. */
  acquireAuthority?: (task: OrchestrationTask) => Promise<DispatchAuthority>;
  /** Mission-wide durable retry/repair ceiling. */
  recovery?: RecoveryPlannerOptions;
}

export interface MissionSchedulerStatusNotice {
  missionId: string;
  taskId: string;
  status: MissionStatus;
  action: "retrying" | "resumed" | "paused";
  reason: string;
  attempt: number;
  nextActionAt?: number;
  terminal: boolean;
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
  return canonicalizeWriteDomain(d).replace(/\/\*\*$/, "");
}

/** True when two mutating tasks have overlapping write domains. */
export function domainsOverlap(a: string[], b: string[]): boolean {
  for (const rawX of a) {
    for (const rawY of b) {
      const x = normalizeDomain(rawX);
      const y = normalizeDomain(rawY);
      if (x === "**" || y === "**") return true;
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
  private readonly onStatus?: SchedulerOptions["onStatus"];
  /** Active executions by task id (for write-domain conflict detection). */
  private readonly activeTasks = new Map<string, OrchestrationTask>();
  /** Counters for concurrency limits. */
  private counters = { agents: 0, subprocesses: 0, byRole: new Map<string, number>() };
  private queue: Scheduler;
  /** Mission-level gateway resilience config (time-based window, probes). */
  private readonly resilience: GatewayResilienceConfig;
  /** Lightweight gateway recovery probe. */
  private readonly probe: RecoveryProbe;
  /**
   * True when a real recovery probe was injected (e.g. HttpRecoveryProbe from
   * PI_GATEWAY_HEALTH_URL). Only a real probe can pace relaunches promptly and
   * decide an auto-resume; the default pass-through probe always says healthy.
   */
  private readonly hasRealProbe: boolean;
  private readonly clockNow: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  private readonly acquireAuthority?: SchedulerOptions["acquireAuthority"];
  private readonly failureClassifier = new FailureClassifier();
  private readonly recoveryPlanner: RecoveryPlanner;
  /** Per-task active retry window (created on the first infra failure). */
  private readonly windows = new Map<string, RetryWindowState>();
  /**
   * Per-task outage bookkeeping that SURVIVES a pause and resume (unlike the
   * retry window): when the outage began, and how many relaunches it has
   * cost. Cleared only when the task succeeds.
   */
  private readonly outageStartedAt = new Map<string, number>();
  private readonly relaunches = new Map<string, number>();
  /** Per-task circuit breaker (prevents a request storm during recovery). */
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** Consecutive "model not listed" probe answers per task (see probeGate). */
  private readonly unlistedProbes = new Map<string, number>();
  /** In-flight runners, retained so mission cancellation can await cleanup. */
  private readonly activeRuns = new Map<string, Set<Promise<void>>>();

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.broker = opts.broker;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.onTaskSettled = opts.onTaskSettled;
    this.onStatus = opts.onStatus;
    // Resolve the time-based resilience config (env-overridable). Resilience is
    // ON by default so missions survive gateway outages; a probe + clock + sleep
    // are injectable for deterministic fault-injection tests.
    this.resilience = opts.resilience ?? resolveGatewayResilienceConfig();
    this.probe = opts.probe ?? healthyProbe();
    // For a Pi worker the runtime injects its CatalogRecoveryProbe (or an
    // HttpRecoveryProbe for PI_GATEWAY_HEALTH_URL), so this is true in
    // production even when the catalog probe has no target to ask: that
    // answer is a non-authoritative "healthy" and passes straight through.
    this.hasRealProbe = opts.probe !== undefined;
    this.clockNow = opts.now ?? realNow;
    this.sleepFn = opts.sleep ?? realSleep;
    this.rand = opts.rand ?? Math.random;
    this.acquireAuthority = opts.acquireAuthority;
    this.recoveryPlanner = new RecoveryPlanner({
      decisionTtlMs: this.resilience.max_outage_ms,
      ...opts.recovery,
    });
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
      const depsDone = t.depends_on.every(
        (dependencyId) =>
          byId.get(dependencyId)?.status === "SUCCEEDED" || this.store.isTaskSatisfiedBySupersession(dependencyId),
      );
      if (!depsDone) continue;
      if (t.mutates_repo) {
        const conflict = active.some(
          (a) =>
            a.mutates_repo &&
            (t.repo_id === undefined || a.repo_id === undefined || t.repo_id === a.repo_id) &&
            domainsOverlap(a.write_domains, t.write_domains),
        );
        if (conflict) continue;
      }
      if (!this.hasCapacity(t)) continue;
      out.push(t);
    }
    return out;
  }

  private hasCapacity(t: OrchestrationTask): boolean {
    const kind = t.kind;
    if (this.activeTasks.size >= this.limits.maxActive) return false;
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
    let canceling: Promise<void> | null = null;
    const cancelActive = (): Promise<void> => {
      canceling ??= Promise.all(
        [...this.activeTasks.values()]
          .filter((task) => task.mission_id === missionId)
          .map((task) => this.broker.cancelByTask(task.task_id)),
      ).then(() => undefined);
      return canceling;
    };
    const onAbort = (): void => {
      void cancelActive();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
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
          await this.abortable(new Promise<void>((resolve) => setTimeout(resolve, 10)), signal);
          continue;
        }

        // Launch runnable tasks incrementally, re-checking write-domain conflict
        // against tasks acquired earlier in this same pass so overlapping domains
        // serialize even when they were both "runnable" at pass start.
        for (const task of runnable) {
          if (signal?.aborted) break;
          if (this.hasConflict(task)) continue;
          if (!this.hasCapacity(task)) continue;
          // Idempotent: a resumed (already-READY) task must not throw on
          // READY -> READY; only transition from PENDING/WAITING.
          if (this.store.getTask(task.task_id)?.status !== "READY") {
            this.store.transitionTask(task.task_id, "READY");
          }
          this.acquire(task);
          this.trackRun(task, signal);
        }
        await this.abortable(new Promise<void>((resolve) => setTimeout(resolve, 10)), signal);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) await cancelActive();
      try {
        await Promise.all(this.activeRuns.get(missionId) ?? []);
      } finally {
        this.activeRuns.delete(missionId);
      }
    }
  }

  private trackRun(task: OrchestrationTask, signal?: AbortSignal): void {
    let runs = this.activeRuns.get(task.mission_id);
    if (!runs) {
      runs = new Set();
      this.activeRuns.set(task.mission_id, runs);
    }
    const run = this.runOne(task, signal);
    runs.add(run);
    // Mark the detached runner handled immediately; runMission still observes
    // the original promise through Promise.all before clearing this mission set.
    void run.catch(() => undefined);
  }

  private hasConflict(t: OrchestrationTask): boolean {
    if (!t.mutates_repo) return false;
    return [...this.activeTasks.values()].some(
      (a) =>
        a.mutates_repo &&
        (t.repo_id === undefined || a.repo_id === undefined || t.repo_id === a.repo_id) &&
        domainsOverlap(a.write_domains, t.write_domains),
    );
  }

  /** Execute a single task with retry via the broker. */
  private async runOne(task: OrchestrationTask, signal?: AbortSignal): Promise<void> {
    try {
      await this.executeWithRetry(task, signal);
    } finally {
      this.release(task);
      this.onTaskSettled?.(task.mission_id, task.task_id, this.store.getTask(task.task_id)?.status ?? "FAILED");
    }
  }

  private async executeWithRetry(task: OrchestrationTask, signal?: AbortSignal): Promise<void> {
    let attempt = task.attempt;
    while (true) {
      if (signal?.aborted) {
        this.cancelTask(task);
        return;
      }
      attempt++;
      // Resilience probe gate: when a time-based retry window is active for this
      // task (a prior transient infrastructure failure), start a fresh worker
      // attempt ONLY once the recovery probe reports the gateway healthy; otherwise
      // wait the probe interval and re-check, without burning a full worker session.
      // On window exhaustion the mission is PAUSED (not FAILED).
      const gate = await this.probeGate(task, signal);
      if (gate === "aborted") {
        this.cancelTask(task);
        return;
      }
      if (gate === "paused") return;
      if (gate === "wait") continue;

      let authority: DispatchAuthority | undefined;
      try {
        authority = await this.acquireAuthority?.(this.store.getTask(task.task_id) ?? task);
        if (authority) this.store.assignTaskAuthority(task.task_id, authority.missionIdentity);
      } catch (error) {
        this.store.transitionTask(task.task_id, "BLOCKED", "system", {
          failure_reason: error instanceof Error ? error.message : String(error),
        });
        this.leaveResilienceWindow(task);
        return;
      }
      let handle: ExecutionHandle | undefined;
      try {
        // execute() itself can throw (e.g. no backend registered for the kind).
        // Left outside the try it escaped the fire-and-forget run as an
        // unhandled rejection and left the task stuck in READY, which then threw
        // an illegal READY -> READY transition on the next pass.
        handle = await this.broker.execute({
          taskId: task.task_id,
          missionId: task.mission_id,
          repoId: task.repo_id,
          kind: brokerKind(task.kind),
          role: task.role,
          objective: task.objective,
          mutatesRepo: task.mutates_repo,
          writeDomains: task.write_domains,
          isolation: task.isolation,
          modelRequirements: task.execution_requirements,
          deliverables: task.deliverables,
          executionBudgetMs: task.execution_budget_ms,
          checkpointPolicy: task.checkpoint_policy,
          requiredOutputArtifacts: task.required_output_artifacts,
          candidateBaseSha: task.repair_base_candidate_sha,
          authority,
        });
        authority?.onInvalidated(() => {
          void handle?.cancel();
        });
        if (signal?.aborted) {
          await handle.cancel();
          return;
        }
        authority?.assertAuthoritative();
        this.store.transitionTask(task.task_id, "RUNNING", "system", {
          attempt,
          assigned_execution_id: handle.executionId,
        });
        const outcome = await handle.result();
        authority?.assertAuthoritative();
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
          const ceiling = infraCat ? this.outageCeiling(task, outcome) : null;
          if (ceiling) {
            authority?.assertAuthoritative();
            this.settleTaskRecoveries(task, "failed");
            this.recordTerminalFailure(task, ceiling, handle.executionId, outcome.error);
            this.store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: ceiling });
            this.leaveResilienceWindow(task);
            return;
          }
          if (infraCat) {
            const res = this.resilienceGate(task, infraCat);
            if (res.paused) return;
            if (res.retry) {
              const recoveryStop = await this.authorizeRetry(task, {
                missionId: task.mission_id,
                taskId: task.task_id,
                executionId: handle.executionId,
                summary: outcome.summary ?? outcome.error ?? "provider transient failure",
                evidenceRefs: outcome.artifactRefs,
                category: "PROVIDER_TRANSIENT",
                observedAt: new Date(this.clockNow()).toISOString(),
              });
              if (recoveryStop) {
                authority?.assertAuthoritative();
                this.settleTaskRecoveries(task, "failed");
                this.recordTerminalFailure(task, recoveryStop, handle.executionId, outcome.error);
                this.store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: recoveryStop });
                this.leaveResilienceWindow(task);
                return;
              }
              authority?.assertAuthoritative();
              this.store.transitionTask(task.task_id, "RETRYING", "system", { attempt });
              const waited = await this.abortable(this.sleepFn(res.waitMs), signal);
              if (waited.aborted) {
                this.cancelTask(task);
                return;
              }
              continue;
            }
          }
          // Surface the worker's own result summary (guard aborts, budget
          // exhaustion, timeouts, no-result) — exitStatus alone hid the cause.
          const detail = outcome.summary ? `: ${outcome.summary}` : "";
          authority?.assertAuthoritative();
          this.settleTaskRecoveries(task, "failed");
          this.recordTerminalFailure(
            task,
            `backend reported ${outcome.exitStatus}${detail}`,
            handle.executionId,
            outcome.error,
          );
          this.store.transitionTask(task.task_id, "FAILED", "system", {
            failure_reason: `backend reported ${outcome.exitStatus}${detail}`,
          });
          this.leaveResilienceWindow(task);
          return;
        }
        // Success: clear the resilience window, close the breaker, and resume the
        // mission out of any WAITING state it was parked in.
        this.breakerSuccess(task);
        this.clearResilience(task);
        this.forgetOutage(task);
        if (this.resumeToExecuting(task.mission_id)) {
          this.onStatus?.({
            missionId: task.mission_id,
            taskId: task.task_id,
            status: "EXECUTING",
            action: "resumed",
            reason: "infrastructure recovery succeeded",
            attempt,
            terminal: false,
          });
        }
        authority?.assertAuthoritative();
        this.store.transitionTask(task.task_id, "SUCCEEDED");
        this.settleTaskRecoveries(task, "succeeded");
        return;
      } catch (err) {
        if (authority) {
          try {
            authority.assertAuthoritative();
          } catch (authorityError) {
            await handle?.cancel().catch(() => undefined);
            if (handle) {
              this.store.rejectLateExecution(
                handle.executionId,
                authorityError instanceof Error ? authorityError.message : String(authorityError),
              );
            }
            return;
          }
        }
        if (signal?.aborted) {
          this.cancelTask(task);
          return;
        }
        if (this.store.getTask(task.task_id)?.status === "CANCELED") return;
        // Thrown failures (e.g. no backend registered) keep the existing
        // attempt-count repair path; the time-based window applies to the
        // worker's non-throwing transient-infrastructure outcomes above.
        const { action, reason } = classifyFailure(err, task);
        if (action === "retry" && attempt < task.max_attempts) {
          const recoveryStop = await this.authorizeRetry(task, {
            missionId: task.mission_id,
            taskId: task.task_id,
            executionId: handle?.executionId ?? null,
            summary: reason,
            evidenceRefs: [],
            category: /^transient:/i.test(reason) ? "PROVIDER_TRANSIENT" : undefined,
            observedAt: new Date(this.clockNow()).toISOString(),
          });
          if (recoveryStop) {
            authority?.assertAuthoritative();
            this.settleTaskRecoveries(task, "failed");
            this.recordTerminalFailure(
              task,
              recoveryStop,
              handle?.executionId ?? null,
              err instanceof Error ? err.message : String(err),
            );
            this.store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: recoveryStop });
            this.leaveResilienceWindow(task);
            return;
          }
          authority?.assertAuthoritative();
          this.store.transitionTask(task.task_id, "RETRYING", "system", { attempt });
          continue;
        }
        authority?.assertAuthoritative();
        this.settleTaskRecoveries(task, "failed");
        this.recordTerminalFailure(
          task,
          reason,
          handle?.executionId ?? null,
          err instanceof Error ? err.message : String(err),
        );
        this.store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: reason });
        this.leaveResilienceWindow(task);
        return;
      } finally {
        const closeError = await authority?.close();
        if (authority && closeError) {
          const identity = authority.repositoryIdentity ?? authority.missionIdentity;
          await this.store.recordOwnershipReleaseFailure({
            missionId: identity.missionId,
            taskId: task.task_id,
            ...(authority.repositoryIdentity ? { repoId: authority.repositoryIdentity.repoId } : {}),
            generation: identity.generation,
            fencingToken: identity.fencingToken,
            ownerId: identity.ownerId,
            renewBy: identity.renewBy,
            error: closeError,
          });
        }
      }
    }
  }

  private async authorizeRetry(task: OrchestrationTask, evidence: FailureEvidence): Promise<string | null> {
    const classification = this.failureClassifier.classify(evidence);
    if (!this.store.getFailureClassification(classification.classificationId)) {
      this.store.classifyFailure(classification);
    }
    const decision = this.recoveryPlanner.decide({
      classification,
      history: this.store.listRecoveryDecisions(task.mission_id),
      now: this.clockNow(),
      resumptionGeneration: this.store.listMissionResumptions(task.mission_id).at(-1)?.generation ?? 0,
    });
    const persisted = this.store.getRecoveryDecision(decision.recoveryId) ?? this.store.planRecovery(decision);
    if (persisted.status === "planned") {
      this.store.transitionRecovery(persisted.recoveryId, decision.action === "STOP" ? "exhausted" : "started");
    }
    await this.store.flush();
    return decision.action === "STOP" ? decision.expectedMaterialChange : null;
  }

  private recordTerminalFailure(
    task: OrchestrationTask,
    summary: string,
    executionId: string | null,
    structuredError?: string,
  ): void {
    const evidence = {
      missionId: task.mission_id,
      taskId: task.task_id,
      executionId,
      summary: [structuredError, summary].filter(Boolean).join(": "),
      evidenceRefs: [],
      observedAt: new Date(this.clockNow()).toISOString(),
    };
    const inferred = this.failureClassifier.classify(evidence);
    const structuredCategory =
      !!structuredError &&
      !/repository-scoped git provider|git provider/i.test(structuredError) &&
      [
        "PROVIDER_TRANSIENT",
        "PROVIDER_PERMANENT",
        "AUTHORIZATION_OR_CREDENTIAL",
        "PERSISTENCE_FAILURE",
        "WORKSPACE_SCOPE_MISMATCH",
      ].includes(inferred.category);
    const gateCategory =
      task.kind === "validation"
        ? "VALIDATION_FAILED"
        : task.kind === "review"
          ? "REVIEW_FAILED"
          : task.kind === "integration"
            ? "MERGE_CONFLICT"
            : undefined;
    const classification = structuredCategory
      ? inferred
      : this.failureClassifier.classify({ ...evidence, ...(gateCategory ? { category: gateCategory } : {}) });
    if (this.store.getFailureClassification(classification.classificationId)) return;
    this.store.classifyFailure({
      ...classification,
      blockerEpisodeId: this.store.getMission(task.mission_id)?.blocked_episode_id,
    });
  }

  private settleTaskRecoveries(task: OrchestrationTask, status: "succeeded" | "failed"): void {
    const taskClassifications = new Set(
      this.store
        .listFailureClassifications(task.mission_id)
        .filter((classification) => classification.taskId === task.task_id)
        .map((classification) => classification.classificationId),
    );
    for (const decision of this.store.listRecoveryDecisions(task.mission_id)) {
      if (decision.status === "started" && taskClassifications.has(decision.classificationId)) {
        this.store.transitionRecovery(decision.recoveryId, status);
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
  private async probeGate(
    task: OrchestrationTask,
    signal?: AbortSignal,
  ): Promise<"proceed" | "wait" | "paused" | "aborted"> {
    if (signal?.aborted) return "aborted";
    const window = this.windows.get(task.task_id);
    if (!window) return "proceed";
    const cfg = this.resilience;
    if (!windowOpen(window, this.clockNow())) return this.pauseMission(task) ? "paused" : "proceed";
    // Circuit breaker: while OPEN and the cooldown has not elapsed, only probe.
    const breaker = this.breakers.get(task.task_id);
    if (breaker && !breaker.allowRequest()) {
      const waitMs = cfg.probe_interval_ms;
      this.onStatus?.({
        missionId: task.mission_id,
        taskId: task.task_id,
        status: this.store.getMission(task.mission_id)?.status ?? "WAITING_FOR_LLM",
        action: "retrying",
        reason: "recovery circuit is cooling down before the next gateway probe",
        attempt: this.store.getTask(task.task_id)?.attempt ?? task.attempt,
        nextActionAt: this.clockNow() + waitMs,
        terminal: false,
      });
      const waited = await this.abortable(this.sleepFn(waitMs), signal);
      if (waited.aborted) return "aborted";
      return "wait";
    }
    breaker?.tryHalfOpen();
    const probed = await this.abortable(this.probe.probe(), signal);
    if (probed.aborted) return "aborted";
    const result = probed.value;
    if (result.healthy) {
      this.unlistedProbes.delete(task.task_id);
      return "proceed";
    }
    // The gateway is up but does not list the model. That never clears if the
    // model was removed, and does not matter for a legacy alias that still
    // routes, so after a few in a row let one real attempt through: a removed
    // model then fails fast with model_not_found instead of pausing forever,
    // and an alias simply runs. Auto-resume still requires a listed model.
    if (result.model_unlisted) {
      const unlisted = (this.unlistedProbes.get(task.task_id) ?? 0) + 1;
      if (unlisted >= UNLISTED_PROBES_BEFORE_VERIFY) {
        this.unlistedProbes.delete(task.task_id);
        this.onStatus?.({
          missionId: task.mission_id,
          taskId: task.task_id,
          status: this.store.getMission(task.mission_id)?.status ?? "WAITING_FOR_LLM",
          action: "retrying",
          reason: unlistedVerifyReason(result),
          attempt: this.store.getTask(task.task_id)?.attempt ?? task.attempt,
          nextActionAt: this.clockNow(),
          terminal: false,
        });
        return "proceed";
      }
      this.unlistedProbes.set(task.task_id, unlisted);
    } else {
      this.unlistedProbes.delete(task.task_id);
    }
    // Gateway still down: honour the reported wait (else the probe interval),
    // then re-probe without a real attempt.
    const waitMs = result.retry_after_ms ?? cfg.probe_interval_ms;
    this.onStatus?.({
      missionId: task.mission_id,
      taskId: task.task_id,
      status: this.store.getMission(task.mission_id)?.status ?? "WAITING_FOR_LLM",
      action: "retrying",
      reason: result.reason ?? result.scheduler_state ?? "gateway recovery probe is still unhealthy",
      attempt: this.store.getTask(task.task_id)?.attempt ?? task.attempt,
      nextActionAt: this.clockNow() + waitMs,
      terminal: false,
    });
    const waited = await this.abortable(this.sleepFn(waitMs), signal);
    if (waited.aborted) return "aborted";
    return "wait";
  }

  private cancelTask(task: OrchestrationTask): void {
    this.unlistedProbes.delete(task.task_id);
    const status = this.store.getTask(task.task_id)?.status;
    if (!status || ["SUCCEEDED", "FAILED", "CANCELED", "SKIPPED"].includes(status)) return;
    this.store.transitionTask(task.task_id, "CANCELED");
  }

  private async abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<AbortableResult<T>> {
    if (!signal) return { aborted: false, value: await operation };
    if (signal.aborted) return { aborted: true };
    return new Promise<AbortableResult<T>>((resolve, reject) => {
      const onAbort = (): void => resolve({ aborted: true });
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ aborted: false, value });
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
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
    const failures = window.probe_count;
    this.windows.set(task.task_id, recordProbe(window, this.clockNow()));
    // With a real recovery probe, relaunch pacing is the probe's job (probeGate
    // re-checks every probe interval and starts the next attempt as soon as the
    // gateway answers). Without one, each relaunch IS the probe: back off
    // exponentially from the probe interval to max_backoff_ms, so an outage of
    // hours costs dozens of worker sessions, not thousands.
    // Relaunches back off exponentially from the probe interval to
    // max_backoff_ms either way; a real probe additionally keeps a relaunch
    // from happening at all while it reports the gateway unhealthy (probeGate).
    const base = cfg.probe_interval_ms;
    const paced = Math.min(cfg.max_backoff_ms ?? base, base * 2 ** Math.min(failures, 30));
    const wait = paced + (cfg.jitter_ms > 0 ? Math.round(cfg.jitter_ms * this.rand()) : 0);
    this.onStatus?.({
      missionId: task.mission_id,
      taskId: task.task_id,
      status: CATEGORY_TO_STATE[cat] as MissionStatus,
      action: "retrying",
      reason: cat,
      attempt: task.attempt + 1,
      nextActionAt: this.clockNow() + wait,
      terminal: false,
    });
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

  /** Move a parked mission back to EXECUTING once a task leaves the resilience
   * window (success or terminal failure). Only when no other task in the
   * mission is still paused (RETRYING), so a mission with a paused task never
   * reports EXECUTING. */
  private resumeToExecuting(missionId: string): boolean {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.status === "EXECUTING") return false;
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
    if (!parked.includes(mission.status)) return false;
    const anyPaused = this.store.listTasks(missionId).some((t) => t.status === "RETRYING");
    if (anyPaused) return false;
    try {
      this.store.transitionMission(missionId, "EXECUTING");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A task ended terminally (FAILED/BLOCKED). Drop its resilience bookkeeping
   * and un-park the mission from any WAITING_* or RECOVERING_* state the window
   * put it in, so the orchestrator's normal failure handling runs instead of
   * hitting an illegal transition out of the parked state.
   */
  private leaveResilienceWindow(task: OrchestrationTask): void {
    this.clearResilience(task);
    this.forgetOutage(task);
    this.resumeToExecuting(task.mission_id);
  }

  /** Pause a mission on retry-window exhaustion: PAUSED (not FAILED), resumable. */
  private pauseMission(task: OrchestrationTask): boolean {
    const mission = this.store.getMission(task.mission_id);
    if (!mission) return false;
    this.parkMission(task.mission_id, "PAUSED_INFRASTRUCTURE");
    this.markTaskResumable(task);
    this.clearResilience(task);
    this.onStatus?.({
      missionId: task.mission_id,
      taskId: task.task_id,
      status: "PAUSED_INFRASTRUCTURE",
      action: "paused",
      reason: "infrastructure retry window exhausted",
      attempt: this.store.getTask(task.task_id)?.attempt ?? task.attempt,
      terminal: true,
    });
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

  /** Drop the task's retry window, breaker and unlisted-probe count. */
  private clearResilience(task: OrchestrationTask): void {
    this.windows.delete(task.task_id);
    this.breakers.delete(task.task_id);
    this.unlistedProbes.delete(task.task_id);
  }

  /**
   * Record one more infra failure for the task and decide whether its outage
   * has hit a ceiling: the total duration (across pause and resume) or the
   * relaunch count. Returns the failure reason when it has, else null.
   */
  private outageCeiling(task: OrchestrationTask, outcome: { error?: string; summary?: string }): string | null {
    const cfg = this.resilience;
    const now = this.clockNow();
    const started = this.outageStartedAt.get(task.task_id) ?? now;
    this.outageStartedAt.set(task.task_id, started);
    const relaunches = (this.relaunches.get(task.task_id) ?? 0) + 1;
    this.relaunches.set(task.task_id, relaunches);
    const last = `last: ${outcome.error ?? "transient"}${outcome.summary ? ` — ${outcome.summary}` : ""}`;
    const maxOutage = cfg.max_outage_ms ?? Number.POSITIVE_INFINITY;
    if (now - started >= maxOutage) {
      return `transient infrastructure outage lasted ${formatWaitingFor(now - started)} (limit ${formatWaitingFor(maxOutage)}); ${last}`;
    }
    const maxRelaunches = cfg.max_relaunches ?? Number.POSITIVE_INFINITY;
    if (relaunches > maxRelaunches) {
      return `task relaunched ${maxRelaunches} times through a transient outage without success; ${last}`;
    }
    return null;
  }

  private forgetOutage(task: OrchestrationTask): void {
    this.outageStartedAt.delete(task.task_id);
    this.relaunches.delete(task.task_id);
  }

  /** The resolved mission resilience config. */
  get resilienceConfig(): GatewayResilienceConfig {
    return this.resilience;
  }

  /** The scheduler's clock (injectable), for callers pacing against it. */
  now(): number {
    return this.clockNow();
  }

  /**
   * After a pause: watch the recovery probe until it reports healthy (true) or
   * `deadlineMs` (scheduler clock) passes (false). Probes back off from the
   * probe interval to max_backoff_ms, honouring a probe's retry_after_ms.
   * Returns false immediately when auto-resume is off, has no horizon, or no
   * real probe exists — the pass-through probe cannot tell a recovery apart.
   */
  async awaitRecovery(deadlineMs: number, signal?: AbortSignal, missionId?: string): Promise<boolean> {
    const cfg = this.resilience;
    if (!cfg.auto_resume_on_recovery || !this.hasRealProbe) return false;
    // Stop as soon as nobody needs the answer: the caller aborted, or the
    // mission left PAUSED_INFRASTRUCTURE (resumed or canceled elsewhere).
    const stillPaused = () =>
      missionId === undefined || this.store.getMission(missionId)?.status === "PAUSED_INFRASTRUCTURE";
    const recoveryTask = () =>
      missionId === undefined ? undefined : this.store.listTasks(missionId).find((task) => task.status === "RETRYING");
    let unlisted = 0;
    for (let n = 0; this.clockNow() < deadlineMs; n++) {
      if (signal?.aborted || !stillPaused()) return false;
      const probed = await this.abortable(this.probe.probe(), signal);
      if (probed.aborted) return false;
      const result = probed.value;
      // Only a real answer resumes: a probe that could not even resolve its
      // target (authoritative: false) says nothing about a recovery.
      if (result.healthy && result.authoritative !== false) return true;
      // Same rule as probeGate: a model the gateway keeps not listing never
      // "recovers", so after a few answers in a row resume anyway. The real
      // attempt then either runs (an alias), hands the task to another model,
      // or fails with model_not_found, instead of staying paused.
      unlisted = result.model_unlisted ? unlisted + 1 : 0;
      if (unlisted >= UNLISTED_PROBES_BEFORE_VERIFY) {
        if (missionId !== undefined) {
          const task = recoveryTask();
          this.onStatus?.({
            missionId,
            taskId: task?.task_id ?? "recovery",
            status: "PAUSED_INFRASTRUCTURE",
            action: "retrying",
            reason: unlistedVerifyReason(result),
            attempt: task?.attempt ?? n + 1,
            nextActionAt: this.clockNow(),
            terminal: false,
          });
        }
        return true;
      }
      const backoff = Math.min(
        cfg.max_backoff_ms ?? cfg.probe_interval_ms,
        cfg.probe_interval_ms * 2 ** Math.min(n, 30),
      );
      const jitter = cfg.jitter_ms > 0 ? Math.round(cfg.jitter_ms * this.rand()) : 0;
      const waitMs = Math.min(result.retry_after_ms ?? backoff + jitter, Math.max(0, deadlineMs - this.clockNow()));
      const task = recoveryTask();
      if (missionId !== undefined) {
        this.onStatus?.({
          missionId,
          taskId: task?.task_id ?? "recovery",
          status: "PAUSED_INFRASTRUCTURE",
          action: "retrying",
          reason: result.reason ?? result.scheduler_state ?? "gateway recovery probe is still unhealthy",
          attempt: task?.attempt ?? n + 1,
          nextActionAt: this.clockNow() + waitMs,
          terminal: false,
        });
      }
      const waited = await this.abortable(this.sleepFn(waitMs), signal);
      if (waited.aborted) return false;
      if (this.clockNow() >= deadlineMs || signal?.aborted) break;
    }
    if (missionId !== undefined && stillPaused() && !signal?.aborted && this.clockNow() >= deadlineMs) {
      const task = recoveryTask();
      this.onStatus?.({
        missionId,
        taskId: task?.task_id ?? "recovery",
        status: "PAUSED_INFRASTRUCTURE",
        action: "paused",
        reason: `auto-recovery horizon exhausted at ${new Date(deadlineMs).toISOString()}`,
        attempt: task?.attempt ?? 0,
        terminal: true,
      });
    }
    return false;
  }

  /** Lightweight gateway readiness check (for auto-resume decisions). */
  async gatewayHealthy(signal?: AbortSignal): Promise<boolean> {
    const result = await this.abortable(this.probe.probe(), signal);
    return !result.aborted && result.value.healthy;
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
