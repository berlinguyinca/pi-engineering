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

import { type SchedulableTask, Scheduler } from "../sched/Scheduler.ts";
import type { ExecutionBroker, ExecutionHandle, ExecutionRequestInput } from "./broker.ts";
import type { MissionStore } from "./missionStore.ts";
import type { OrchestrationTask, TaskKind, TaskStatus } from "./types.ts";

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

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.broker = opts.broker;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.onTaskSettled = opts.onTaskSettled;
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
        this.store.transitionTask(task.task_id, "READY");
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
          this.store.transitionTask(task.task_id, "FAILED", "system", {
            failure_reason: `backend reported ${outcome.exitStatus}`,
          });
          return;
        }
        this.store.transitionTask(task.task_id, "SUCCEEDED");
        return;
      } catch (err) {
        if (this.store.getTask(task.task_id)?.status === "CANCELED") return;
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
