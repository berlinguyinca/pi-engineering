/**
 * Durable Mission / Task / Execution store (spec 00 §3, spec 02 persistence).
 *
 * Event-sourced over the shared `EventStoreBackend` contract: every mutation
 * appends an event and the store replays the stream to rebuild an in-memory
 * materialized view on open. Mission/task/execution state therefore survives
 * process restart and is reconstructable/auditable from events — execution
 * state lives in the authoritative event store, not only in semantic memory.
 *
 * Reuses the existing durable backends (`JsonlEventStore`, ledger adapter).
 */

import { id } from "../core/ids.ts";
import type { EventStoreBackend, StoredEvent } from "../platform/eventstore/backend.ts";
import { assertMissionTransition, assertTaskTransition } from "./state.ts";
import type {
  Execution,
  ExecutionStatus,
  Mission,
  MissionStatus,
  OrchestrationTask,
  ReviewFinding,
  TaskStatus,
} from "./types.ts";

export type OrchestrationEventType =
  | "mission.created"
  | "mission.updated"
  | "mission.completed"
  | "mission.failed"
  | "task.created"
  | "task.ready"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.retried"
  | "task.canceled"
  | "task.steered"
  | "execution.created"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.canceled"
  | "finding.created"
  | "finding.resolved";

export interface OrchestrationEvent {
  event_id: string;
  mission_id: string;
  timestamp: string;
  type: OrchestrationEventType;
  actor: "system" | "user" | "agent";
  payload: Record<string, unknown>;
}

export interface MissionCreateInput {
  mission_id?: string;
  title: string;
  goal: string;
  user_request: string;
  repository: string;
  base_ref: string;
  constraints?: string[];
  risk_profile: Mission["risk_profile"];
  workflow_class: Mission["workflow_class"];
  parent_session_id?: string | null;
}

export interface TaskCreateInput {
  task_id?: string;
  mission_id: string;
  kind: OrchestrationTask["kind"];
  role: string;
  objective: string;
  depends_on?: string[];
  priority?: number;
  mutates_repo?: boolean;
  write_domains?: string[];
  isolation?: OrchestrationTask["isolation"];
  execution_requirements?: Record<string, unknown>;
  max_attempts?: number;
  failure_policy?: OrchestrationTask["failure_policy"];
}

/** Maps a platform StoredEvent back to an orchestration event. */
function fromStored(e: StoredEvent): OrchestrationEvent {
  return {
    event_id: e.event_id,
    mission_id: (e.payload.mission_id as string) ?? "",
    timestamp: e.timestamp,
    type: e.type as OrchestrationEventType,
    actor: (e.payload.actor as OrchestrationEvent["actor"]) ?? "system",
    payload: e.payload,
  };
}

export class MissionStore {
  private readonly backend: EventStoreBackend;
  private readonly missions = new Map<string, Mission>();
  private readonly tasks = new Map<string, OrchestrationTask>();
  private readonly executions = new Map<string, Execution>();
  private readonly findings = new Map<string, ReviewFinding>();
  private emitChain: Promise<void> = Promise.resolve();

  private constructor(backend: EventStoreBackend) {
    this.backend = backend;
  }

  /** Open a store over a backend, replaying existing events. */
  static open(backend: EventStoreBackend): MissionStore {
    const store = new MissionStore(backend);
    for (const e of backend.all()) store.apply(fromStored(e));
    return store;
  }

  private emit(type: OrchestrationEventType, missionId: string, payload: Record<string, unknown>): void {
    const event: OrchestrationEvent = {
      event_id: id("oevt"),
      mission_id: missionId,
      timestamp: new Date().toISOString(),
      type,
      actor: (payload.actor as OrchestrationEvent["actor"]) ?? "system",
      payload,
    };
    const stored: StoredEvent = {
      event_id: event.event_id,
      timestamp: event.timestamp,
      type: event.type,
      project_id: null,
      run_id: missionId,
      worker_id: null,
      payload,
    };
    this.emitChain = this.emitChain.then(() => this.backend.append(stored)).then(() => undefined);
  }

  /** Await all pending event writes (so tests can assert durability). */
  async flush(): Promise<void> {
    await this.emitChain;
  }

  private apply(e: OrchestrationEvent): void {
    switch (e.type) {
      case "mission.created": {
        const p = e.payload.mission as Mission;
        if (p) this.missions.set(p.mission_id, { ...p });
        break;
      }
      case "mission.updated": {
        const idm = e.payload.mission_id as string;
        const patch = e.payload.patch as Partial<Mission>;
        const m = this.missions.get(idm);
        if (m && patch) this.missions.set(idm, { ...m, ...patch, updated_at: e.timestamp });
        break;
      }
      case "mission.completed":
      case "mission.failed": {
        const idm = e.payload.mission_id as string;
        const m = this.missions.get(idm);
        if (m) {
          m.status = e.type === "mission.completed" ? "COMPLETE" : "FAILED";
          m.completed_at = e.timestamp;
          m.updated_at = e.timestamp;
          if (e.payload.failure_reason) m.failure_reason = e.payload.failure_reason as string;
        }
        break;
      }
      case "task.created": {
        const p = e.payload.task as OrchestrationTask;
        if (p) this.tasks.set(p.task_id, { ...p });
        break;
      }
      case "task.ready":
      case "task.started":
      case "task.completed":
      case "task.failed":
      case "task.retried":
      case "task.canceled": {
        const tid = e.payload.task_id as string;
        const status = e.payload.status as TaskStatus;
        const t = this.tasks.get(tid);
        if (t) {
          t.status = status;
          if (status === "RUNNING") t.started_at = e.timestamp;
          if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED") t.completed_at = e.timestamp;
          if (e.payload.attempt !== undefined) t.attempt = e.payload.attempt as number;
          if (e.payload.assigned_execution_id !== undefined) {
            t.assigned_execution_id = e.payload.assigned_execution_id as string | null;
          }
          this.tasks.set(tid, t);
        }
        break;
      }
      case "task.steered": {
        const tid = e.payload.task_id as string;
        const req = e.payload.request as string;
        const t = this.tasks.get(tid);
        if (t && req) {
          t.steer_requests.push(req);
          this.tasks.set(tid, t);
        }
        break;
      }
      case "execution.created":
      case "execution.started":
      case "execution.completed":
      case "execution.failed":
      case "execution.canceled": {
        if (e.payload.execution) {
          const ex = e.payload.execution as Execution;
          this.executions.set(ex.execution_id, { ...ex });
        } else {
          const xid = e.payload.execution_id as string;
          const status = e.payload.status as ExecutionStatus;
          const ex = this.executions.get(xid);
          if (ex) {
            ex.status = status;
            if (e.payload.exit_status !== undefined) ex.exit_status = e.payload.exit_status as string | null;
            if (e.payload.ended_at !== undefined) ex.ended_at = e.payload.ended_at as string | null;
            if (status === "RUNNING") ex.started_at = e.timestamp;
            this.executions.set(xid, ex);
          }
        }
        break;
      }
      case "finding.created": {
        const f = e.payload.finding as ReviewFinding;
        if (f) this.findings.set(f.finding_id, { ...f });
        break;
      }
      case "finding.resolved": {
        const fid = e.payload.finding_id as string;
        const f = this.findings.get(fid);
        if (f) {
          f.status = "resolved";
          this.findings.set(fid, f);
        }
        break;
      }
    }
  }

  // ── Missions ────────────────────────────────────────────────────────────

  createMission(input: MissionCreateInput): Mission {
    const now = new Date().toISOString();
    const mission: Mission = {
      mission_id: input.mission_id ?? id("MSN"),
      title: input.title,
      goal: input.goal,
      user_request: input.user_request,
      repository: input.repository,
      base_ref: input.base_ref,
      constraints: input.constraints ?? [],
      acceptance_criteria: [],
      risk_profile: input.risk_profile,
      workflow_class: input.workflow_class,
      status: "NEW",
      created_at: now,
      updated_at: now,
      parent_session_id: input.parent_session_id ?? null,
      task_ids: [],
      artifact_refs: [],
      decision_refs: [],
      required_gates: [],
      failure_reason: null,
      completed_at: null,
    };
    this.missions.set(mission.mission_id, mission);
    this.emit("mission.created", mission.mission_id, { actor: "system", mission });
    return { ...mission };
  }

  getMission(missionId: string): Mission | undefined {
    const m = this.missions.get(missionId);
    return m ? { ...m, acceptance_criteria: [...m.acceptance_criteria], constraints: [...m.constraints] } : undefined;
  }

  listMissions(projectFilter?: (m: Mission) => boolean): Mission[] {
    const all = [...this.missions.values()];
    return (projectFilter ? all.filter(projectFilter) : all).map((m) => ({
      ...m,
      acceptance_criteria: [...m.acceptance_criteria],
      constraints: [...m.constraints],
    }));
  }

  transitionMission(missionId: string, to: MissionStatus, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    assertMissionTransition(m.status, to);
    const patch: Partial<Mission> = { status: to, updated_at: new Date().toISOString() };
    this.missions.set(missionId, { ...m, ...patch });
    this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch });
    return this.getMission(missionId)!;
  }

  updateMission(missionId: string, patch: Partial<Mission>, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const next = { ...m, ...patch, updated_at: new Date().toISOString() };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch });
    return this.getMission(missionId)!;
  }

  completeMission(missionId: string, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    assertMissionTransition(m.status, "COMPLETE");
    this.missions.set(missionId, {
      ...m,
      status: "COMPLETE",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.emit("mission.completed", missionId, { actor, mission_id: missionId });
    return this.getMission(missionId)!;
  }

  failMission(missionId: string, reason: string, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    this.missions.set(missionId, {
      ...m,
      status: "FAILED",
      failure_reason: reason,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.emit("mission.failed", missionId, { actor, mission_id: missionId, failure_reason: reason });
    return this.getMission(missionId)!;
  }

  addAcceptanceCriterion(missionId: string, criterion: string, evidence?: string): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const criteria = [
      ...m.acceptance_criteria,
      { criterion, status: "pending" as const, ...(evidence ? { evidence } : {}) },
    ];
    const next = { ...m, acceptance_criteria: criteria, updated_at: new Date().toISOString() };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, {
      actor: "system",
      mission_id: missionId,
      patch: { acceptance_criteria: criteria },
    });
    return this.getMission(missionId)!;
  }

  setCriterionStatus(missionId: string, index: number, status: "passed" | "failed", evidence?: string): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const criteria = m.acceptance_criteria.map((c, i) =>
      i === index ? { ...c, status, ...(evidence ? { evidence } : {}) } : c,
    );
    const next = { ...m, acceptance_criteria: criteria, updated_at: new Date().toISOString() };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, {
      actor: "system",
      mission_id: missionId,
      patch: { acceptance_criteria: criteria },
    });
    return this.getMission(missionId)!;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  createTask(input: TaskCreateInput): OrchestrationTask {
    const now = new Date().toISOString();
    const task: OrchestrationTask = {
      task_id: input.task_id ?? id("TSK"),
      mission_id: input.mission_id,
      kind: input.kind,
      role: input.role,
      objective: input.objective,
      depends_on: input.depends_on ?? [],
      status: "PENDING",
      priority: input.priority ?? 0,
      mutates_repo: input.mutates_repo ?? false,
      write_domains: input.write_domains ?? [],
      isolation: input.isolation ?? (input.mutates_repo ? "worktree" : "none"),
      execution_requirements: input.execution_requirements ?? {},
      assigned_execution_id: null,
      artifacts: [],
      attempt: 0,
      max_attempts: input.max_attempts ?? 3,
      failure_policy: input.failure_policy ?? "retry",
      created_at: now,
      started_at: null,
      completed_at: null,
      steer_requests: [],
    };
    this.tasks.set(task.task_id, task);
    const mission = this.missions.get(input.mission_id);
    if (mission) {
      this.missions.set(mission.mission_id, {
        ...mission,
        task_ids: [...mission.task_ids, task.task_id],
        updated_at: now,
      });
    }
    this.emit("task.created", input.mission_id, { actor: "system", task });
    return { ...task };
  }

  getTask(taskId: string): OrchestrationTask | undefined {
    const t = this.tasks.get(taskId);
    return t
      ? {
          ...t,
          depends_on: [...t.depends_on],
          write_domains: [...t.write_domains],
          steer_requests: [...t.steer_requests],
        }
      : undefined;
  }

  listTasks(missionId?: string): OrchestrationTask[] {
    return [...this.tasks.values()]
      .filter((t) => (missionId ? t.mission_id === missionId : true))
      .map((t) => ({
        ...t,
        depends_on: [...t.depends_on],
        write_domains: [...t.write_domains],
        steer_requests: [...t.steer_requests],
      }));
  }

  transitionTask(
    taskId: string,
    to: TaskStatus,
    actor = "system",
    extra: Record<string, unknown> = {},
  ): OrchestrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    assertTaskTransition(t.status, to);
    const now = new Date().toISOString();
    const next: OrchestrationTask = {
      ...t,
      status: to,
      ...(to === "RUNNING" ? { started_at: now } : {}),
      ...(to === "SUCCEEDED" || to === "FAILED" || to === "CANCELED" ? { completed_at: now } : {}),
      ...extra,
    };
    this.tasks.set(taskId, next);
    const type =
      to === "READY"
        ? "task.ready"
        : to === "RUNNING"
          ? "task.started"
          : to === "SUCCEEDED"
            ? "task.completed"
            : to === "FAILED"
              ? "task.failed"
              : to === "RETRYING"
                ? "task.retried"
                : "task.canceled";
    this.emit(type, t.mission_id, { actor, task_id: taskId, status: to, ...extra });
    return this.getTask(taskId)!;
  }

  steerTask(taskId: string, request: string, actor = "system"): OrchestrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    const next = { ...t, steer_requests: [...t.steer_requests, request] };
    this.tasks.set(taskId, next);
    this.emit("task.steered", t.mission_id, { actor, task_id: taskId, request });
    return this.getTask(taskId)!;
  }

  // ── Executions ──────────────────────────────────────────────────────────

  createExecution(input: {
    task_id: string;
    backend: Execution["backend"];
    mission_id: string;
    session_id?: string | null;
    pid?: number | null;
    worktree?: string | null;
    model?: string | null;
    thinking_level?: string | null;
  }): Execution {
    const ex: Execution = {
      execution_id: id("EXC"),
      task_id: input.task_id,
      mission_id: input.mission_id,
      backend: input.backend,
      session_id: input.session_id ?? null,
      pid: input.pid ?? null,
      worktree: input.worktree ?? null,
      model: input.model ?? null,
      thinking_level: input.thinking_level ?? null,
      started_at: null,
      ended_at: null,
      exit_status: null,
      usage: {},
      logs: [],
      artifact_refs: [],
      status: "PENDING",
    };
    this.executions.set(ex.execution_id, ex);
    this.emit("execution.created", input.mission_id, { actor: "system", execution: ex });
    return { ...ex };
  }

  setExecutionStatus(executionId: string, status: ExecutionStatus, extra: Partial<Execution> = {}): Execution {
    const ex = this.executions.get(executionId);
    if (!ex) throw new Error(`unknown execution ${executionId}`);
    const now = new Date().toISOString();
    const next: Execution = {
      ...ex,
      ...extra,
      status,
      ...(status === "RUNNING" ? { started_at: now } : {}),
      ...(status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED" ? { ended_at: now } : {}),
    };
    this.executions.set(executionId, next);
    const type =
      status === "RUNNING"
        ? "execution.started"
        : status === "SUCCEEDED"
          ? "execution.completed"
          : status === "FAILED"
            ? "execution.failed"
            : "execution.canceled";
    this.emit(type, ex.mission_id, { actor: "system", execution: next });
    return this.getExecution(executionId)!;
  }

  getExecution(executionId: string): Execution | undefined {
    const ex = this.executions.get(executionId);
    return ex ? { ...ex, logs: [...ex.logs], artifact_refs: [...ex.artifact_refs] } : undefined;
  }

  listExecutions(missionId?: string, taskId?: string): Execution[] {
    return [...this.executions.values()]
      .filter((e) => (missionId ? e.mission_id === missionId : true))
      .filter((e) => (taskId ? e.task_id === taskId : true))
      .map((e) => ({ ...e, logs: [...e.logs], artifact_refs: [...e.artifact_refs] }));
  }

  // ── Findings ────────────────────────────────────────────────────────────

  addFinding(finding: Omit<ReviewFinding, "finding_id" | "status" | "created_at">): ReviewFinding {
    const f: ReviewFinding = {
      ...finding,
      finding_id: id("F"),
      status: "open",
      created_at: new Date().toISOString(),
    };
    this.findings.set(f.finding_id, f);
    this.emit("finding.created", finding.mission_id, { actor: "agent", finding: f });
    return { ...f };
  }

  resolveFinding(findingId: string): void {
    const f = this.findings.get(findingId);
    if (!f) return;
    f.status = "resolved";
    this.emit("finding.resolved", f.mission_id, { actor: "system", finding_id: findingId });
  }

  listFindings(missionId?: string): ReviewFinding[] {
    return [...this.findings.values()]
      .filter((f) => (missionId ? f.mission_id === missionId : true))
      .map((f) => ({ ...f }));
  }
}
