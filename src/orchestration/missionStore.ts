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
  EvidenceInvalidation,
  Execution,
  ExecutionStatus,
  FailureClassification,
  LeaseTransition,
  Mission,
  MissionLease,
  MissionResumption,
  MissionStatus,
  MissionStop,
  OrchestrationTask,
  RecoveryDecision,
  RecoveryStatus,
  RepositoryLease,
  ReviewFinding,
  TaskCheckpoint,
  TaskStatus,
  TaskSupersession,
  WorkspaceManifest,
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
  | "finding.resolved"
  | "workspace.authorized"
  | "workspace.rebound"
  | "workspace.rebind_failed"
  | "task.checkpointed"
  | "task.split"
  | "task.superseded"
  | "failure.classified"
  | "recovery.planned"
  | "recovery.started"
  | "recovery.succeeded"
  | "recovery.failed"
  | "recovery.exhausted"
  | "execution.orphaned"
  | "execution.reconciled"
  | "execution.late_result_rejected"
  | "lease.acquired"
  | "lease.renewed"
  | "lease.expired"
  | "lease.fenced"
  | "evidence.invalidated"
  | "mission.resumed"
  | "mission.stopped";

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
  repo_id?: string;
  acceptance_ids?: string[];
  candidate_generation?: number;
  mission_generation?: number;
  fencing_token?: number;
}

/** Bounded, inspectable record of an event that could not be persisted. */
export interface MissionPersistenceDiagnostic {
  eventId: string;
  eventType: string;
  missionId: string;
  eventTimestamp: string;
  message: string;
}

const MAX_PERSISTENCE_DIAGNOSTICS = 50;

function persistenceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown persistence error";
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
  private readonly workspaceManifests = new Map<string, WorkspaceManifest>();
  private readonly taskCheckpoints = new Map<string, TaskCheckpoint>();
  private readonly failureClassifications = new Map<string, FailureClassification>();
  private readonly recoveryDecisions = new Map<string, RecoveryDecision>();
  private readonly taskSupersessions = new Map<string, TaskSupersession>();
  private readonly evidenceInvalidations = new Map<string, EvidenceInvalidation>();
  private readonly missionLeases = new Map<string, MissionLease>();
  private readonly repositoryLeases = new Map<string, RepositoryLease>();
  private readonly missionResumptions: MissionResumption[] = [];
  private readonly missionStops: MissionStop[] = [];
  private readonly persistenceErrors: MissionPersistenceDiagnostic[] = [];
  private readonly pendingWrites: Array<{ event: OrchestrationEvent; stored: StoredEvent }> = [];
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

  private emit(type: OrchestrationEventType, missionId: string, payload: Record<string, unknown>): OrchestrationEvent {
    const durablePayload = structuredClone(payload);
    const event: OrchestrationEvent = {
      event_id: id("oevt"),
      mission_id: missionId,
      timestamp: new Date().toISOString(),
      type,
      actor: (durablePayload.actor as OrchestrationEvent["actor"]) ?? "system",
      payload: durablePayload,
    };
    const stored: StoredEvent = {
      event_id: event.event_id,
      timestamp: event.timestamp,
      type: event.type,
      project_id: null,
      run_id: missionId,
      worker_id: null,
      payload: durablePayload,
    };
    this.pendingWrites.push({ event, stored });
    this.scheduleDrain();
    return event;
  }

  private scheduleDrain(): void {
    const drain = this.emitChain.then(() => this.drainPending());
    // Background persistence must not create an unhandled rejection. The
    // failed head remains queued; flush() performs a retry and reports failure.
    this.emitChain = drain.catch(() => undefined);
  }

  private async drainPending(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const pending = this.pendingWrites[0]!;
      try {
        await this.backend.append(pending.stored);
      } catch (error) {
        this.recordPersistenceFailure(pending.event, error);
        throw error;
      }
      this.pendingWrites.shift();
      this.clearPersistenceFailure(pending.event.event_id);
    }
  }

  private recordPersistenceFailure(event: OrchestrationEvent, error: unknown): void {
    const diagnostic: MissionPersistenceDiagnostic = {
      eventId: event.event_id,
      eventType: event.type,
      missionId: event.mission_id,
      eventTimestamp: event.timestamp,
      message: persistenceErrorMessage(error),
    };
    const existing = this.persistenceErrors.findIndex((entry) => entry.eventId === event.event_id);
    if (existing >= 0) this.persistenceErrors[existing] = diagnostic;
    else this.persistenceErrors.push(diagnostic);
    if (this.persistenceErrors.length > MAX_PERSISTENCE_DIAGNOSTICS) this.persistenceErrors.shift();
  }

  private clearPersistenceFailure(eventId: string): void {
    const index = this.persistenceErrors.findIndex((entry) => entry.eventId === eventId);
    if (index >= 0) this.persistenceErrors.splice(index, 1);
  }

  /** Await all pending event writes (so tests can assert durability). */
  async flush(): Promise<void> {
    await this.emitChain;
    if (this.pendingWrites.length === 0) return;

    const drain = this.drainPending();
    this.emitChain = drain.catch(() => undefined);
    await drain;
  }

  /** Recent persistence failures, oldest first. */
  persistenceDiagnostics(): MissionPersistenceDiagnostic[] {
    return this.persistenceErrors.map((diagnostic) => ({ ...diagnostic }));
  }

  private apply(e: OrchestrationEvent): void {
    switch (e.type) {
      case "mission.created": {
        const p = e.payload.mission as Mission;
        if (p) this.missions.set(p.mission_id, copyMission(p));
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
        if (p) {
          this.tasks.set(p.task_id, copyTask(p));
          const mission = this.missions.get(p.mission_id);
          if (mission && !mission.task_ids.includes(p.task_id)) {
            this.missions.set(mission.mission_id, {
              ...mission,
              task_ids: [...mission.task_ids, p.task_id],
              updated_at: e.timestamp,
            });
          }
        }
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
          this.executions.set(ex.execution_id, copyExecution(ex));
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
      case "workspace.authorized":
      case "workspace.rebound": {
        const manifest = e.payload.manifest as WorkspaceManifest;
        if (manifest) this.workspaceManifests.set(manifest.missionId, copyWorkspaceManifest(manifest));
        break;
      }
      case "task.checkpointed": {
        const checkpoint = e.payload.checkpoint as TaskCheckpoint;
        if (checkpoint) this.taskCheckpoints.set(checkpoint.checkpointId, copyTaskCheckpoint(checkpoint));
        break;
      }
      case "failure.classified": {
        const classification = e.payload.classification as FailureClassification;
        if (classification) {
          this.failureClassifications.set(classification.classificationId, copyFailureClassification(classification));
        }
        break;
      }
      case "recovery.planned":
      case "recovery.started":
      case "recovery.succeeded":
      case "recovery.failed":
      case "recovery.exhausted": {
        const decision = e.payload.decision as RecoveryDecision;
        if (decision) this.recoveryDecisions.set(decision.recoveryId, { ...decision });
        break;
      }
      case "task.superseded": {
        const supersession = e.payload.supersession as TaskSupersession;
        if (supersession) {
          this.taskSupersessions.set(supersession.supersessionId, copyTaskSupersession(supersession));
        }
        break;
      }
      case "evidence.invalidated": {
        const invalidation = e.payload.invalidation as EvidenceInvalidation;
        if (invalidation) {
          this.evidenceInvalidations.set(invalidation.invalidationId, copyEvidenceInvalidation(invalidation));
        }
        break;
      }
      case "lease.acquired":
      case "lease.renewed":
      case "lease.expired":
      case "lease.fenced": {
        const scope = e.payload.scope as "mission" | "repository";
        const transition = e.type.slice("lease.".length) as LeaseTransition;
        if (scope === "mission") {
          const lease = e.payload.lease as MissionLease;
          if (lease) {
            if (transition === "expired" || transition === "fenced") this.missionLeases.delete(lease.missionId);
            else this.missionLeases.set(lease.missionId, { ...lease });
          }
        } else if (scope === "repository") {
          const lease = e.payload.lease as RepositoryLease;
          if (lease) {
            const key = repositoryLeaseKey(lease.missionId, lease.repoId);
            if (transition === "expired" || transition === "fenced") this.repositoryLeases.delete(key);
            else this.repositoryLeases.set(key, { ...lease });
          }
        }
        break;
      }
      case "mission.resumed": {
        const resumption = e.payload.resumption as MissionResumption;
        if (resumption) this.missionResumptions.push({ ...resumption });
        break;
      }
      case "mission.stopped": {
        const stop = e.payload.stop as MissionStop;
        if (stop) this.missionStops.push(copyMissionStop(stop));
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
    return copyMission(mission);
  }

  getMission(missionId: string): Mission | undefined {
    const m = this.missions.get(missionId);
    return m ? copyMission(m) : undefined;
  }

  listMissions(projectFilter?: (m: Mission) => boolean): Mission[] {
    const all = [...this.missions.values()];
    return (projectFilter ? all.filter(projectFilter) : all).map(copyMission);
  }

  transitionMission(missionId: string, to: MissionStatus, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    if (
      m.status === "BLOCKED" &&
      to === "REPAIRING" &&
      !this.listRecoveryDecisions(missionId).some(
        (decision) => decision.action === "REPAIR_BLOCKED_MISSION" && decision.status === "planned",
      )
    ) {
      throw new Error("BLOCKED -> REPAIRING requires a durable repair recovery decision");
    }
    assertMissionTransition(m.status, to);
    const patch: Partial<Mission> = { status: to, updated_at: new Date().toISOString() };
    this.missions.set(missionId, { ...m, ...patch });
    this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch });
    return this.getMission(missionId)!;
  }

  updateMission(missionId: string, patch: Partial<Mission>, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    if (patch.status !== undefined) {
      throw new Error("mission status must be changed through transitionMission");
    }
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

  addAcceptanceCriterion(missionId: string, criterion: string, evidence?: string, acceptanceId?: string): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const criterionId = acceptanceId ?? id("AC");
    if (m.acceptance_criteria.some((entry) => entry.acceptance_id === criterionId)) {
      throw new Error(`duplicate acceptance criterion ID ${criterionId}`);
    }
    const criteria = [
      ...m.acceptance_criteria,
      {
        acceptance_id: criterionId,
        criterion,
        status: "pending" as const,
        ...(evidence ? { evidence } : {}),
      },
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
      repo_id: input.repo_id,
      acceptance_ids: input.acceptance_ids ? [...input.acceptance_ids] : [],
      candidate_generation: input.candidate_generation ?? 0,
      mission_generation: input.mission_generation ?? 0,
      fencing_token: input.fencing_token ?? 0,
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
    return copyTask(task);
  }

  getTask(taskId: string): OrchestrationTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? copyTask(t) : undefined;
  }

  listTasks(missionId?: string): OrchestrationTask[] {
    return [...this.tasks.values()].filter((t) => (missionId ? t.mission_id === missionId : true)).map(copyTask);
  }

  transitionTask(
    taskId: string,
    to: TaskStatus,
    actor = "system",
    extra: Record<string, unknown> = {},
  ): OrchestrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (Object.hasOwn(extra, "status")) {
      throw new Error("task status must be changed through transitionTask");
    }
    assertTaskTransition(t.status, to);
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
    const event = this.emit(type, t.mission_id, { actor, task_id: taskId, status: to, ...extra });
    const now = event.timestamp;
    const next: OrchestrationTask = {
      ...t,
      status: to,
      ...(to === "RUNNING" ? { started_at: now } : {}),
      ...(to === "SUCCEEDED" || to === "FAILED" || to === "CANCELED" ? { completed_at: now } : {}),
      ...extra,
    };
    this.tasks.set(taskId, next);
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
    mission_generation?: number;
    fencing_token?: number;
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
      mission_generation: input.mission_generation ?? 0,
      fencing_token: input.fencing_token ?? 0,
    };
    this.executions.set(ex.execution_id, ex);
    this.emit("execution.created", input.mission_id, { actor: "system", execution: ex });
    return copyExecution(ex);
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
    return ex ? copyExecution(ex) : undefined;
  }

  listExecutions(missionId?: string, taskId?: string): Execution[] {
    return [...this.executions.values()]
      .filter((e) => (missionId ? e.mission_id === missionId : true))
      .filter((e) => (taskId ? e.task_id === taskId : true))
      .map(copyExecution);
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

  // ── Durable reliability authority ──────────────────────────────────────

  bindWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
    if (!this.missions.has(manifest.missionId)) throw new Error(`unknown mission ${manifest.missionId}`);
    const copy = copyWorkspaceManifest(manifest);
    const type = this.workspaceManifests.has(manifest.missionId) ? "workspace.rebound" : "workspace.authorized";
    this.workspaceManifests.set(manifest.missionId, copy);
    this.emit(type, manifest.missionId, { actor: "system", manifest: copy });
    return copyWorkspaceManifest(copy);
  }

  getWorkspaceManifest(missionId: string): WorkspaceManifest | undefined {
    const manifest = this.workspaceManifests.get(missionId);
    return manifest ? copyWorkspaceManifest(manifest) : undefined;
  }

  getTaskCheckpoint(checkpointId: string): TaskCheckpoint | undefined {
    const checkpoint = this.taskCheckpoints.get(checkpointId);
    return checkpoint ? copyTaskCheckpoint(checkpoint) : undefined;
  }

  checkpointTask(checkpoint: TaskCheckpoint): TaskCheckpoint {
    const task = this.tasks.get(checkpoint.taskId);
    if (!task || task.mission_id !== checkpoint.missionId) throw new Error(`unknown task ${checkpoint.taskId}`);
    const copy = copyTaskCheckpoint(checkpoint);
    this.taskCheckpoints.set(copy.checkpointId, copy);
    this.emit("task.checkpointed", checkpoint.missionId, { actor: "system", checkpoint: copy });
    return copyTaskCheckpoint(copy);
  }

  listTaskCheckpoints(missionId?: string, taskId?: string): TaskCheckpoint[] {
    return [...this.taskCheckpoints.values()]
      .filter((checkpoint) => (missionId ? checkpoint.missionId === missionId : true))
      .filter((checkpoint) => (taskId ? checkpoint.taskId === taskId : true))
      .map(copyTaskCheckpoint);
  }

  classifyFailure(classification: FailureClassification): FailureClassification {
    if (!this.missions.has(classification.missionId)) throw new Error(`unknown mission ${classification.missionId}`);
    const copy = copyFailureClassification(classification);
    this.failureClassifications.set(copy.classificationId, copy);
    this.emit("failure.classified", classification.missionId, { actor: "system", classification: copy });
    return copyFailureClassification(copy);
  }

  listFailureClassifications(missionId?: string): FailureClassification[] {
    return [...this.failureClassifications.values()]
      .filter((classification) => (missionId ? classification.missionId === missionId : true))
      .map(copyFailureClassification);
  }

  getFailureClassification(classificationId: string): FailureClassification | undefined {
    const classification = this.failureClassifications.get(classificationId);
    return classification ? copyFailureClassification(classification) : undefined;
  }

  planRecovery(decision: RecoveryDecision): RecoveryDecision {
    if (!this.missions.has(decision.missionId)) throw new Error(`unknown mission ${decision.missionId}`);
    const classification = this.failureClassifications.get(decision.classificationId);
    if (!classification || classification.missionId !== decision.missionId) {
      throw new Error(`unknown failure classification ${decision.classificationId}`);
    }
    const copy = { ...decision, status: "planned" as const };
    this.recoveryDecisions.set(copy.recoveryId, copy);
    this.emit("recovery.planned", decision.missionId, { actor: "system", decision: copy });
    return { ...copy };
  }

  transitionRecovery(recoveryId: string, status: Exclude<RecoveryStatus, "planned">): RecoveryDecision {
    const decision = this.recoveryDecisions.get(recoveryId);
    if (!decision) throw new Error(`unknown recovery ${recoveryId}`);
    const next = { ...decision, status };
    this.recoveryDecisions.set(recoveryId, next);
    this.emit(`recovery.${status}` as OrchestrationEventType, decision.missionId, {
      actor: "system",
      decision: next,
    });
    return { ...next };
  }

  listRecoveryDecisions(missionId?: string): RecoveryDecision[] {
    return [...this.recoveryDecisions.values()]
      .filter((decision) => (missionId ? decision.missionId === missionId : true))
      .map((decision) => ({ ...decision }));
  }

  getRecoveryDecision(recoveryId: string): RecoveryDecision | undefined {
    const decision = this.recoveryDecisions.get(recoveryId);
    return decision ? { ...decision } : undefined;
  }

  supersedeTask(supersession: TaskSupersession): TaskSupersession {
    const failed = this.tasks.get(supersession.failedTaskId);
    if (!failed || failed.mission_id !== supersession.missionId || failed.status !== "FAILED") {
      throw new Error(`supersession requires a failed task ${supersession.failedTaskId}`);
    }
    if (supersession.replacementTaskIds.length === 0) throw new Error("supersession requires replacement task IDs");
    if (this.listTaskSupersessions(supersession.missionId).some((entry) => entry.failedTaskId === failed.task_id)) {
      throw new Error(`task ${failed.task_id} is already superseded`);
    }
    const failedAcceptance = new Set(failed.acceptance_ids ?? []);
    const declaredAcceptance = new Set(supersession.acceptanceIds);
    if (failed.repo_id !== supersession.repoId || [...failedAcceptance].some((id) => !declaredAcceptance.has(id))) {
      throw new Error("supersession does not match failed task repository coverage and acceptance coverage");
    }
    const replacements = supersession.replacementTaskIds.map((taskId) => this.tasks.get(taskId));
    if (replacements.some((task) => !task || task.mission_id !== supersession.missionId)) {
      throw new Error("supersession contains an unknown replacement task ID");
    }
    const coveredAcceptance = new Set(replacements.flatMap((task) => task?.acceptance_ids ?? []));
    if (
      replacements.some((task) => task?.repo_id !== supersession.repoId) ||
      [...declaredAcceptance].some((id) => !coveredAcceptance.has(id))
    ) {
      throw new Error("replacement tasks do not provide matching repository coverage and acceptance coverage");
    }
    const copy = copyTaskSupersession(supersession);
    this.taskSupersessions.set(copy.supersessionId, copy);
    this.emit("task.superseded", supersession.missionId, { actor: "system", supersession: copy });
    return copyTaskSupersession(copy);
  }

  listTaskSupersessions(missionId?: string): TaskSupersession[] {
    return [...this.taskSupersessions.values()]
      .filter((supersession) => (missionId ? supersession.missionId === missionId : true))
      .map(copyTaskSupersession);
  }

  getTaskSupersession(supersessionId: string): TaskSupersession | undefined {
    const supersession = this.taskSupersessions.get(supersessionId);
    return supersession ? copyTaskSupersession(supersession) : undefined;
  }

  invalidateEvidence(invalidation: EvidenceInvalidation): EvidenceInvalidation {
    if (!this.missions.has(invalidation.missionId)) throw new Error(`unknown mission ${invalidation.missionId}`);
    const copy = copyEvidenceInvalidation(invalidation);
    this.evidenceInvalidations.set(copy.invalidationId, copy);
    this.emit("evidence.invalidated", invalidation.missionId, { actor: "system", invalidation: copy });
    return copyEvidenceInvalidation(copy);
  }

  listEvidenceInvalidations(missionId?: string): EvidenceInvalidation[] {
    return [...this.evidenceInvalidations.values()]
      .filter((invalidation) => (missionId ? invalidation.missionId === missionId : true))
      .map(copyEvidenceInvalidation);
  }

  getEvidenceInvalidation(invalidationId: string): EvidenceInvalidation | undefined {
    const invalidation = this.evidenceInvalidations.get(invalidationId);
    return invalidation ? copyEvidenceInvalidation(invalidation) : undefined;
  }

  transitionMissionLease(transition: LeaseTransition, lease: MissionLease): MissionLease {
    this.applyLeaseTransition(transition, "mission", lease);
    return { ...lease };
  }

  getMissionLease(missionId: string): MissionLease | undefined {
    const lease = this.missionLeases.get(missionId);
    return lease ? { ...lease } : undefined;
  }

  transitionRepositoryLease(transition: LeaseTransition, lease: RepositoryLease): RepositoryLease {
    this.applyLeaseTransition(transition, "repository", lease);
    return { ...lease };
  }

  listRepositoryLeases(missionId?: string): RepositoryLease[] {
    return [...this.repositoryLeases.values()]
      .filter((lease) => (missionId ? lease.missionId === missionId : true))
      .map((lease) => ({ ...lease }));
  }

  getRepositoryLease(missionId: string, repoId: string): RepositoryLease | undefined {
    const lease = this.repositoryLeases.get(repositoryLeaseKey(missionId, repoId));
    return lease ? { ...lease } : undefined;
  }

  private applyLeaseTransition(
    transition: LeaseTransition,
    scope: "mission" | "repository",
    lease: MissionLease | RepositoryLease,
  ): void {
    if (!this.missions.has(lease.missionId)) throw new Error(`unknown mission ${lease.missionId}`);
    if (scope === "mission") {
      if (transition === "expired" || transition === "fenced") this.missionLeases.delete(lease.missionId);
      else this.missionLeases.set(lease.missionId, { ...lease });
    } else {
      const repositoryLease = lease as RepositoryLease;
      const key = repositoryLeaseKey(repositoryLease.missionId, repositoryLease.repoId);
      if (transition === "expired" || transition === "fenced") this.repositoryLeases.delete(key);
      else this.repositoryLeases.set(key, { ...repositoryLease });
    }
    this.emit(`lease.${transition}`, lease.missionId, { actor: "system", scope, lease });
  }

  resumeMission(missionId: string, reason: string): MissionResumption {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const resumption = { missionId, reason, resumedAt: new Date().toISOString() };
    this.missionResumptions.push(resumption);
    this.emit("mission.resumed", missionId, { actor: "system", resumption });
    return { ...resumption };
  }

  listMissionResumptions(missionId?: string): MissionResumption[] {
    return this.missionResumptions
      .filter((resumption) => (missionId ? resumption.missionId === missionId : true))
      .map((resumption) => ({ ...resumption }));
  }

  stopMission(missionId: string, input: Omit<MissionStop, "missionId" | "stoppedAt">): MissionStop {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const stop: MissionStop = {
      missionId,
      reason: input.reason,
      preservedWork: [...input.preservedWork],
      attemptedRecoveries: [...input.attemptedRecoveries],
      resumeCondition: input.resumeCondition,
      stoppedAt: new Date().toISOString(),
    };
    this.missionStops.push(stop);
    this.emit("mission.stopped", missionId, { actor: "system", stop });
    return copyMissionStop(stop);
  }

  listMissionStops(missionId?: string): MissionStop[] {
    return this.missionStops.filter((stop) => (missionId ? stop.missionId === missionId : true)).map(copyMissionStop);
  }
}

/** A caller-owned copy: no array or record in it aliases the store's state. */
function copyExecution(ex: Execution): Execution {
  return {
    ...ex,
    usage: structuredClone(ex.usage),
    logs: [...ex.logs],
    artifact_refs: [...ex.artifact_refs],
    ...(ex.recovered_merged ? { recovered_merged: ex.recovered_merged.map((r) => ({ ...r })) } : {}),
    ...(ex.reviewed_recovered ? { reviewed_recovered: [...ex.reviewed_recovered] } : {}),
  };
}

function copyMission(mission: Mission): Mission {
  return {
    ...mission,
    constraints: [...mission.constraints],
    acceptance_criteria: mission.acceptance_criteria.map((criterion) => ({ ...criterion })),
    task_ids: [...mission.task_ids],
    artifact_refs: [...mission.artifact_refs],
    decision_refs: [...mission.decision_refs],
    required_gates: [...mission.required_gates],
  };
}

function copyTask(task: OrchestrationTask): OrchestrationTask {
  return {
    ...task,
    depends_on: [...task.depends_on],
    write_domains: [...task.write_domains],
    execution_requirements: structuredClone(task.execution_requirements),
    artifacts: [...task.artifacts],
    steer_requests: [...task.steer_requests],
    ...(task.acceptance_ids ? { acceptance_ids: [...task.acceptance_ids] } : {}),
  };
}

function copyWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    ...manifest,
    authorizedRoots: manifest.authorizedRoots.map((root) => ({ ...root })),
    repositories: manifest.repositories.map((repository) => ({
      ...repository,
      writableDomains: [...repository.writableDomains],
    })),
    dependencyEdges: manifest.dependencyEdges.map((edge) => ({ ...edge })),
  };
}

function copyTaskCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  return {
    ...checkpoint,
    committedChanges: [...checkpoint.committedChanges],
    preservedUncommittedChanges: [...checkpoint.preservedUncommittedChanges],
    completedDeliverables: [...checkpoint.completedDeliverables],
    remainingDeliverables: [...checkpoint.remainingDeliverables],
    acceptanceIds: [...checkpoint.acceptanceIds],
    validationEvidenceRefs: [...checkpoint.validationEvidenceRefs],
    artifactRefs: [...checkpoint.artifactRefs],
    artifactHashes: [...checkpoint.artifactHashes],
  };
}

function copyFailureClassification(classification: FailureClassification): FailureClassification {
  return { ...classification, evidenceRefs: [...classification.evidenceRefs] };
}

function copyTaskSupersession(supersession: TaskSupersession): TaskSupersession {
  return {
    ...supersession,
    replacementTaskIds: [...supersession.replacementTaskIds],
    acceptanceIds: [...supersession.acceptanceIds],
  };
}

function copyEvidenceInvalidation(invalidation: EvidenceInvalidation): EvidenceInvalidation {
  return {
    ...invalidation,
    identity: {
      ...invalidation.identity,
      acceptanceIds: [...invalidation.identity.acceptanceIds],
      artifactHashes: [...invalidation.identity.artifactHashes],
    },
  };
}

function copyMissionStop(stop: MissionStop): MissionStop {
  return {
    ...stop,
    preservedWork: [...stop.preservedWork],
    attemptedRecoveries: [...stop.attemptedRecoveries],
  };
}

function repositoryLeaseKey(missionId: string, repoId: string): string {
  return `${missionId}\u0000${repoId}`;
}
