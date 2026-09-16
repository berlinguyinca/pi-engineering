/**
 * Run / Task / Worker work graph (spec 05).
 *
 * Persists the Run -> Task graph -> Worker graph and gives every worker the
 * lifecycle, heartbeat, events, budgets and cancel/restart semantics the master
 * spec requires. One Worker contract is shared by local and remote workers
 * (spec 12): a worker is addressable by id, reports a heartbeat, and its
 * commands are idempotent (keyed off a monotonically increasing `generation`).
 *
 * The graph is storage-agnostic: every transition is emitted through the shared
 * EventStore backend, so the graph is reconstructable from events.
 */

import { id, newRunId } from "../core/ids.ts";
import type { EventStoreBackend } from "./eventstore/backend.ts";
import type { ApprovalRecord, PlatformEvent, Run, RunStatus, Worker, WorkerLimits, WorkerStatus } from "./types.ts";

const DEFAULT_LIMITS: WorkerLimits = {
  maxTokens: 40000,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  maxTools: 200,
};

export interface CreateRunInput {
  projectId: string;
  goal: string;
  workItemId?: string | null;
  parentRunId?: string | null;
}

export interface CreateWorkerInput {
  runId?: string | null;
  projectId: string;
  role: string;
  model?: string | null;
  worktree?: string | null;
  parentWorkerId?: string | null;
  limits?: Partial<WorkerLimits>;
  location?: { host: string; remote: boolean };
}

export class WorkGraph {
  private readonly store: EventStoreBackend;
  private readonly runs = new Map<string, Run>();
  private readonly workers = new Map<string, Worker>();
  private readonly pendingEmit: Promise<unknown>[] = [];

  private constructor(store: EventStoreBackend) {
    this.store = store;
  }

  static create(store: EventStoreBackend): WorkGraph {
    return new WorkGraph(store);
  }

  /** Await all pending event writes (durability of the event log). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingEmit);
    this.pendingEmit.length = 0;
  }

  private async emit(base: Omit<PlatformEvent, "event_id" | "timestamp">): Promise<void> {
    const p = this.store.append({
      event_id: id("evt"),
      timestamp: new Date().toISOString(),
      ...base,
    });
    this.pendingEmit.push(p);
    await p;
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  createRun(input: CreateRunInput): Run {
    const run: Run = {
      id: newRunId(),
      projectId: input.projectId,
      workItemId: input.workItemId ?? null,
      goal: input.goal,
      status: "PENDING",
      parentRunId: input.parentRunId ?? null,
      started_at: new Date().toISOString(),
      finished_at: null,
      approval: null,
    };
    this.runs.set(run.id, run);
    void this.emit({
      type: "platform.run.created",
      project_id: run.projectId,
      run_id: run.id,
      worker_id: null,
      actor: "system",
      payload: { run: run },
    });
    return { ...run, approval: run.approval };
  }

  getRun(runId: string): Run | undefined {
    const r = this.runs.get(runId);
    return r ? { ...r, approval: r.approval ? { ...r.approval } : null } : undefined;
  }

  listRuns(projectId?: string): Run[] {
    const all = [...this.runs.values()].map((r) => ({ ...r, approval: r.approval ? { ...r.approval } : null }));
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }

  /** Transitions a run and emits a status event. Returns the updated run. */
  setRunStatus(runId: string, status: RunStatus): Run | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    run.status = status;
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
      run.finished_at = new Date().toISOString();
    }
    void this.emit({
      type: "platform.run.status",
      project_id: run.projectId,
      run_id: run.id,
      worker_id: null,
      actor: "system",
      payload: { run_id: run.id, status: run.status, finished_at: run.finished_at },
    });
    return this.getRun(runId);
  }

  /** Records an approval decision correlated to a run (Plannotator integration). */
  recordApproval(runId: string, approval: ApprovalRecord): Run | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    run.approval = approval;
    void this.emit({
      type: "platform.run.approval",
      project_id: run.projectId,
      run_id: run.id,
      worker_id: null,
      actor: "system",
      payload: { run_id: run.id, approval },
    });
    return this.getRun(runId);
  }

  /** Pending runs awaiting a plan decision (survives restart via replay). */
  pendingApprovals(): Run[] {
    return this.listRuns().filter((r) => r.status === "WAITING");
  }

  // ── Workers ─────────────────────────────────────────────────────────────

  createWorker(input: CreateWorkerInput): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: id("WRK"),
      runId: input.runId ?? null,
      projectId: input.projectId,
      role: input.role,
      status: "IDLE",
      model: input.model ?? null,
      worktree: input.worktree ?? null,
      parentWorkerId: input.parentWorkerId ?? null,
      limits: { ...DEFAULT_LIMITS, ...input.limits },
      location: input.location ?? { host: "localhost", remote: false },
      created_at: now,
      updated_at: now,
      heartbeat_at: null,
      generation: 1,
    };
    this.workers.set(worker.id, worker);
    void this.emit({
      type: "platform.worker.created",
      project_id: worker.projectId,
      run_id: worker.runId,
      worker_id: worker.id,
      actor: "system",
      payload: { worker: worker },
    });
    return { ...worker, limits: { ...worker.limits } };
  }

  getWorker(workerId: string): Worker | undefined {
    const w = this.workers.get(workerId);
    return w ? { ...w, limits: { ...w.limits }, location: { ...w.location } } : undefined;
  }

  listWorkers(projectId?: string, runId?: string): Worker[] {
    return [...this.workers.values()]
      .map((w) => ({ ...w, limits: { ...w.limits }, location: { ...w.location } }))
      .filter((w) => (projectId ? w.projectId === projectId : true))
      .filter((w) => (runId ? w.runId === runId : true));
  }

  setWorkerStatus(workerId: string, status: WorkerStatus): Worker | undefined {
    const w = this.workers.get(workerId);
    if (!w) return undefined;
    w.status = status;
    w.updated_at = new Date().toISOString();
    void this.emit({
      type: "platform.worker.status",
      project_id: w.projectId,
      run_id: w.runId,
      worker_id: w.id,
      actor: "system",
      payload: { worker_id: w.id, status: w.status, generation: w.generation },
    });
    return this.getWorker(workerId);
  }

  /** A worker reports aliveness. Heartbeat updates `heartbeat_at`. */
  heartbeat(workerId: string): Worker | undefined {
    const w = this.workers.get(workerId);
    if (!w) return undefined;
    w.heartbeat_at = new Date().toISOString();
    w.updated_at = w.heartbeat_at;
    void this.emit({
      type: "platform.worker.heartbeat",
      project_id: w.projectId,
      run_id: w.runId,
      worker_id: w.id,
      actor: "system",
      payload: { worker_id: w.id, generation: w.generation },
    });
    return this.getWorker(workerId);
  }

  /**
   * Restart a worker: increments its generation so stale/duplicate commands
   * from a previous generation are ignored (idempotency, spec 12 recovery).
   */
  restart(workerId: string): Worker | undefined {
    const w = this.workers.get(workerId);
    if (!w) return undefined;
    w.generation += 1;
    w.status = "IDLE";
    w.heartbeat_at = null;
    w.updated_at = new Date().toISOString();
    void this.emit({
      type: "platform.worker.restarted",
      project_id: w.projectId,
      run_id: w.runId,
      worker_id: w.id,
      actor: "system",
      payload: { worker_id: w.id, generation: w.generation },
    });
    return this.getWorker(workerId);
  }

  cancel(workerId: string): Worker | undefined {
    return this.setWorkerStatus(workerId, "CANCELLED");
  }

  complete(workerId: string): Worker | undefined {
    return this.setWorkerStatus(workerId, "COMPLETED");
  }

  /** Workers whose heartbeat is stale past `staleAfterMs` — candidates for recovery. */
  staleWorkers(staleAfterMs: number, now = Date.now()): Worker[] {
    return this.listWorkers().filter((w) => {
      if (!w.heartbeat_at) return false;
      return now - Date.parse(w.heartbeat_at) > staleAfterMs;
    });
  }

  /**
   * Rebuild the graph from events (parent/control-plane restart recovery).
   * Replays run/worker created + status/heartbeat/restart transitions.
   */
  static rebuild(
    events: ReadonlyArray<{ type: string; timestamp: string; payload: Record<string, unknown> }>,
  ): WorkGraph {
    const graph = WorkGraph.create(JsonlEventStoreLike());
    for (const e of events) {
      if (e.type === "platform.run.created" && e.payload.run) {
        const r = e.payload.run as Run;
        graph.runs.set(r.id, { ...r });
      } else if (e.type === "platform.run.status") {
        const run = graph.runs.get(String(e.payload.run_id ?? ""));
        if (run) run.status = e.payload.status as RunStatus;
      } else if (e.type === "platform.worker.created" && e.payload.worker) {
        const w = e.payload.worker as Worker;
        graph.workers.set(w.id, { ...w, limits: { ...w.limits }, location: { ...w.location } });
      } else if (e.type === "platform.worker.status") {
        const w = graph.workers.get(String(e.payload.worker_id ?? ""));
        if (w) w.status = e.payload.status as WorkerStatus;
      } else if (e.type === "platform.worker.restarted") {
        const w = graph.workers.get(String(e.payload.worker_id ?? ""));
        if (w) {
          w.generation = Number(e.payload.generation ?? w.generation);
          w.status = "IDLE";
          w.heartbeat_at = null;
        }
      } else if (e.type === "platform.worker.heartbeat") {
        const w = graph.workers.get(String(e.payload.worker_id ?? ""));
        if (w) w.heartbeat_at = e.timestamp;
      }
    }
    return graph;
  }
}

/** Minimal in-memory backend so `rebuild` needs no external store. */
function JsonlEventStoreLike(): EventStoreBackend {
  const events: Array<{
    event_id: string;
    timestamp: string;
    type: string;
    project_id: string | null;
    run_id: string | null;
    worker_id: string | null;
    payload: Record<string, unknown>;
  }> = [];
  return {
    append: async (e) => {
      events.push(e);
      return e;
    },
    appendAll: async (es) => {
      events.push(...es);
    },
    all: () => events.slice(),
    get: (id) => events.find((e) => e.event_id === id),
    count: () => events.length,
  };
}
