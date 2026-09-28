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
import {
  buildCandidateEvidenceIdentity,
  hashCandidateEvidenceIdentity,
  taskCoverageFingerprint,
  validateAcceptanceResults,
} from "./evidence.ts";
import { assertMissionTransition, assertTaskTransition } from "./state.ts";
import type {
  CandidateEvidenceIdentity,
  CandidateRevision,
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
  ReviewEvidence,
  ReviewFinding,
  TaskCheckpoint,
  TaskStatus,
  TaskSupersession,
  TaskTransitionMetadata,
  ValidationEvidence,
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
  | "task.authority_assigned"
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
  | "candidate.changed"
  | "evidence.validation_recorded"
  | "evidence.review_recorded"
  | "execution.gate_evidence_published"
  | "mission.resumed"
  | "mission.stopped"
  | "spec.stage"
  | "spec.revision"
  | "spec.review"
  | "spec.approval"
  | "spec.invalidation"
  | "spec.materialized";

const ORCHESTRATION_EVENT_TYPES: ReadonlySet<string> = new Set<OrchestrationEventType>([
  "mission.created",
  "mission.updated",
  "mission.completed",
  "mission.failed",
  "task.created",
  "task.ready",
  "task.started",
  "task.completed",
  "task.failed",
  "task.retried",
  "task.canceled",
  "task.steered",
  "task.authority_assigned",
  "execution.created",
  "execution.started",
  "execution.completed",
  "execution.failed",
  "execution.canceled",
  "finding.created",
  "finding.resolved",
  "workspace.authorized",
  "workspace.rebound",
  "workspace.rebind_failed",
  "task.checkpointed",
  "task.split",
  "task.superseded",
  "failure.classified",
  "recovery.planned",
  "recovery.started",
  "recovery.succeeded",
  "recovery.failed",
  "recovery.exhausted",
  "execution.orphaned",
  "execution.reconciled",
  "execution.late_result_rejected",
  "lease.acquired",
  "lease.renewed",
  "lease.expired",
  "lease.fenced",
  "evidence.invalidated",
  "candidate.changed",
  "evidence.validation_recorded",
  "evidence.review_recorded",
  "execution.gate_evidence_published",
  "mission.resumed",
  "mission.stopped",
  "spec.stage",
  "spec.revision",
  "spec.review",
  "spec.approval",
  "spec.invalidation",
  "spec.materialized",
]);

export interface OrchestrationEvent {
  event_id: string;
  mission_id: string;
  timestamp: string;
  type: OrchestrationEventType;
  actor: "system" | "user" | "agent";
  payload: Record<string, unknown>;
}

export interface LateExecutionEvidence extends Record<string, unknown> {
  kind: "backend_result" | "backend_error" | "checkpoint" | "integration";
  exitStatus: string | null;
  summary: string | null;
  error: string | null;
  artifactRefs: string[];
  findings: Array<Record<string, unknown>>;
  handoffs: Array<Record<string, unknown>>;
  recovery: Array<Record<string, unknown>>;
  gate: Record<string, unknown> | null;
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
  deliverables?: string[];
  execution_budget_ms?: number;
  checkpoint_policy?: OrchestrationTask["checkpoint_policy"];
  required_output_artifacts?: string[];
  candidate_generation?: number;
  mission_generation?: number;
  resumption_generation?: number;
  fencing_token?: number;
  recovery_authority?: OrchestrationTask["recovery_authority"];
  repair_base_candidate_sha?: string;
  replacement_spec_fingerprint?: string;
}

/** Non-authority mission metadata that may be changed without a lifecycle operation. */
export type MissionUpdatePatch = Partial<
  Pick<Mission, "constraints" | "artifact_refs" | "decision_refs" | "required_gates">
>;

export interface MissionTransitionOptions {
  recoveryDecisionId?: string;
}

export interface MissionCompletionOptions {
  expectedResumptionGeneration: number;
}

export interface MissionRevisionFence {
  revision: number;
  status: MissionStatus;
  resumptionGeneration: number;
  blockedEpisodeId: string | null;
}

export interface GateEvidencePublication {
  executionId: string;
  exitStatus: string;
  artifactRefs: string[];
  usage: Execution["usage"];
  recoveredMerged?: NonNullable<Execution["recovered_merged"]>;
  reviewedRecovered?: NonNullable<Execution["reviewed_recovered"]>;
  identity: CandidateEvidenceIdentity;
  reason: string;
  validationEvidence?: Omit<ValidationEvidence, "identity" | "identityHash" | "recordedAt">;
  reviewEvidence?: Omit<ReviewEvidence, "identity" | "identityHash" | "recordedAt">;
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
const MISSION_UPDATE_FIELDS = new Set<keyof MissionUpdatePatch>([
  "constraints",
  "artifact_refs",
  "decision_refs",
  "required_gates",
]);
const TASK_TRANSITION_METADATA_FIELDS = new Set<keyof TaskTransitionMetadata>([
  "attempt",
  "assigned_execution_id",
  "failure_reason",
]);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["SUCCEEDED", "FAILED", "CANCELED", "SKIPPED"]);
const RECOVERY_TRANSITIONS: Record<RecoveryStatus, ReadonlyArray<RecoveryStatus>> = {
  planned: ["started", "failed", "exhausted"],
  started: ["succeeded", "failed", "exhausted"],
  succeeded: [],
  failed: [],
  exhausted: [],
};

function persistenceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown persistence error";
}

/** Maps a platform StoredEvent back to an orchestration event. */
function fromStored(e: StoredEvent): OrchestrationEvent {
  return {
    event_id: e.event_id,
    mission_id: (e.payload.mission_id as string) ?? e.run_id ?? "",
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
  /** Replay-stable position of the most recent durable event for each checkpoint lineage. */
  private readonly taskCheckpointLastEventOrdinals = new Map<string, number>();
  private taskCheckpointEventOrdinal = 0;
  private readonly failureClassifications = new Map<string, FailureClassification>();
  private readonly recoveryDecisions = new Map<string, RecoveryDecision>();
  private readonly taskSupersessions = new Map<string, TaskSupersession>();
  private readonly evidenceInvalidations = new Map<string, EvidenceInvalidation>();
  private readonly candidates = new Map<string, CandidateRevision>();
  private readonly validationEvidence = new Map<string, ValidationEvidence>();
  private readonly reviewEvidence = new Map<string, ReviewEvidence>();
  private readonly candidateExecutionIds = new Set<string>();
  private readonly authoritativeExecutionStartOrder = new Map<string, number>();
  private executionStartSequence = 0;
  private readonly evidenceReplayErrors = new Map<string, string[]>();
  private readonly missionLeases = new Map<string, MissionLease>();
  private readonly repositoryLeases = new Map<string, RepositoryLease>();
  /** Last epochs survive release/expiry so a restarted owner cannot reuse a token. */
  private readonly missionLeaseEpochs = new Map<string, MissionLease>();
  private readonly repositoryLeaseEpochs = new Map<string, RepositoryLease>();
  private readonly missionResumptions: MissionResumption[] = [];
  private readonly missionStops: MissionStop[] = [];
  private readonly specRevisions = new Map<string, import("./specApproval.ts").MissionSpecRevision>();
  private readonly specReviews = new Map<string, import("./specApproval.ts").SpecReviewEvidence>();
  private readonly specApprovals = new Map<string, import("./specApproval.ts").SpecApproval>();
  private readonly specStages: import("./specApproval.ts").SpecStageAttempt[] = [];
  private readonly specInvalidations = new Map<string, { approvalId: string; reason: string; fencingToken: number }>();
  private readonly specMaterializations: Array<{
    missionId: string;
    approvalId: string;
    semanticSpecHash: string;
    created: string[];
    reused: string[];
  }> = [];
  private readonly persistenceErrors: MissionPersistenceDiagnostic[] = [];
  private readonly pendingWrites: Array<{
    event: OrchestrationEvent;
    stored: StoredEvent;
  }> = [];
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

  private emit(
    type: OrchestrationEventType,
    missionId: string,
    payload: Record<string, unknown>,
    timestamp = new Date().toISOString(),
  ): OrchestrationEvent {
    const durablePayload = structuredClone(payload);
    const event: OrchestrationEvent = {
      event_id: id("oevt"),
      mission_id: missionId,
      timestamp,
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
    this.advanceMissionRevision(missionId);
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
    if (!ORCHESTRATION_EVENT_TYPES.has(e.type)) return;
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
              updated_at: p.created_at,
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
          if (e.payload.failure_reason !== undefined) t.failure_reason = e.payload.failure_reason as string;
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
      case "task.authority_assigned": {
        const taskId = e.payload.task_id as string;
        const task = this.tasks.get(taskId);
        if (task) {
          task.mission_generation = e.payload.mission_generation as number;
          task.fencing_token = e.payload.fencing_token as number;
          if (e.payload.resumption_generation !== undefined) {
            task.resumption_generation = e.payload.resumption_generation as number;
          }
          if (e.payload.assigned_execution_id !== undefined) {
            task.assigned_execution_id = e.payload.assigned_execution_id as string;
          }
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
          if (e.type === "execution.started") this.recordAuthoritativeExecutionStart(ex);
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
      case "execution.gate_evidence_published": {
        this.applyGateEvidencePublication(e.payload);
        break;
      }
      case "execution.late_result_rejected": {
        const execution = e.payload.execution as Execution | undefined;
        if (execution) this.executions.set(execution.execution_id, copyExecution(execution));
        break;
      }
      case "execution.orphaned":
      case "execution.reconciled": {
        const execution = e.payload.execution as Execution | undefined;
        if (execution) this.executions.set(execution.execution_id, copyExecution(execution));
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
        if (checkpoint) this.recordTaskCheckpoint(checkpoint);
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
        const missionPatch = e.payload.mission_patch as Partial<Mission> | undefined;
        if (decision && missionPatch) {
          const mission = this.missions.get(decision.missionId);
          if (mission)
            this.missions.set(decision.missionId, {
              ...mission,
              ...missionPatch,
            });
        }
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
      case "candidate.changed": {
        const candidate = e.payload.candidate as CandidateRevision;
        if (candidate) {
          try {
            const identity = this.assertCandidateIdentity(
              candidate.missionId,
              candidate.identity,
              candidate.identityHash,
            );
            this.assertCandidateProvenance(candidate.missionId, identity, candidate.taskId, candidate.executionId);
            this.assertUnusedCandidateExecution(candidate.executionId);
            this.candidates.set(
              candidateKey(candidate.missionId, identity.repoId),
              copyCandidateRevision({ ...candidate, identity }),
            );
            this.candidateExecutionIds.add(candidate.executionId);
          } catch (error) {
            this.quarantineEvidence(candidate.missionId, error);
          }
        }
        break;
      }
      case "evidence.validation_recorded": {
        const evidence = e.payload.evidence as ValidationEvidence;
        if (evidence) {
          try {
            this.assertValidationEvidence(evidence);
            this.assertUnusedEvidenceExecution(evidence.executionId, this.validationEvidence.values());
            this.validationEvidence.set(evidence.evidenceId, copyValidationEvidence(evidence));
          } catch (error) {
            this.quarantineEvidence(evidence.missionId, error);
          }
        }
        break;
      }
      case "evidence.review_recorded": {
        const evidence = e.payload.evidence as ReviewEvidence;
        if (evidence) {
          try {
            this.assertReviewEvidence(evidence);
            this.assertUnusedEvidenceExecution(evidence.executionId, this.reviewEvidence.values());
            this.reviewEvidence.set(evidence.evidenceId, copyReviewEvidence(evidence));
          } catch (error) {
            this.quarantineEvidence(evidence.missionId, error);
          }
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
            this.missionLeaseEpochs.set(lease.missionId, { ...lease });
            if (transition === "expired" || transition === "fenced") this.missionLeases.delete(lease.missionId);
            else this.missionLeases.set(lease.missionId, { ...lease });
          }
        } else if (scope === "repository") {
          const lease = e.payload.lease as RepositoryLease;
          if (lease) {
            this.repositoryLeaseEpochs.set(lease.repoId, { ...lease });
            if (transition === "expired" || transition === "fenced") this.repositoryLeases.delete(lease.repoId);
            else this.repositoryLeases.set(lease.repoId, { ...lease });
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
      case "spec.stage": {
        const stage = e.payload.stage as import("./specApproval.ts").SpecStageAttempt;
        if (stage) this.specStages.push({ ...stage });
        break;
      }
      case "spec.revision": {
        const revision = e.payload.revision as import("./specApproval.ts").MissionSpecRevision;
        if (revision) this.specRevisions.set(revision.revisionId, structuredClone(revision));
        break;
      }
      case "spec.review": {
        const review = e.payload.review as import("./specApproval.ts").SpecReviewEvidence;
        if (review) this.specReviews.set(review.reviewId, structuredClone(review));
        break;
      }
      case "spec.approval": {
        const approval = e.payload.approval as import("./specApproval.ts").SpecApproval;
        if (approval) this.specApprovals.set(approval.missionId, structuredClone(approval));
        break;
      }
      case "spec.invalidation": {
        const invalidation = e.payload.invalidation as {
          missionId: string;
          approvalId: string;
          reason: string;
          fencingToken: number;
        };
        if (invalidation) this.specInvalidations.set(invalidation.missionId, invalidation);
        break;
      }
      case "spec.materialized": {
        const materialization = e.payload.materialization as {
          missionId: string;
          approvalId: string;
          semanticSpecHash: string;
          created: string[];
          reused: string[];
        };
        if (materialization) this.specMaterializations.push(materialization);
        break;
      }
    }
    this.advanceMissionRevision(e.mission_id);
  }

  private advanceMissionRevision(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) return;
    mission.revision = (mission.revision ?? 0) + 1;
  }

  // ── Missions ────────────────────────────────────────────────────────────

  createMission(input: MissionCreateInput): Mission {
    const now = new Date().toISOString();
    const mission: Mission = {
      mission_id: input.mission_id ?? id("MSN"),
      revision: 0,
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
    this.emit("mission.created", mission.mission_id, {
      actor: "system",
      mission,
    });
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

  transitionMission(
    missionId: string,
    to: MissionStatus,
    actorOrOptions: string | MissionTransitionOptions = "system",
    explicitOptions: MissionTransitionOptions = {},
  ): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const actor = typeof actorOrOptions === "string" ? actorOrOptions : "system";
    const options = validateMissionTransitionOptions(
      typeof actorOrOptions === "string" ? explicitOptions : actorOrOptions,
    );
    const repairRecoveryId = options.recoveryDecisionId;
    let repairDecision: RecoveryDecision | undefined;
    if (m.status === "BLOCKED" && to === "REPAIRING") {
      repairDecision = repairRecoveryId ? this.recoveryDecisions.get(repairRecoveryId) : undefined;
      if (!repairDecision) {
        throw new Error("BLOCKED -> REPAIRING requires a durable repair recovery decision ID");
      }
      if (
        repairDecision.missionId !== missionId ||
        ["STOP", "WAIT_FOR_REQUIREMENT", "PAUSE_FOR_PERSISTENCE", "PROBE_AND_BACKOFF"].includes(repairDecision.action)
      ) {
        throw new Error(`recovery ${repairRecoveryId} cannot enter active repair for mission ${missionId}`);
      }
      if (repairDecision.status !== "planned") {
        throw new Error(`repair recovery ${repairRecoveryId} must be planned, not ${repairDecision.status}`);
      }
      if (!m.blocked_episode_id || repairDecision.blockedEpisodeId !== m.blocked_episode_id) {
        throw new Error(`repair recovery ${repairRecoveryId} does not belong to the current blocked episode`);
      }
    }
    assertMissionTransition(m.status, to);
    const now = new Date().toISOString();
    const patch: Partial<Mission> = {
      status: to,
      updated_at: now,
      ...(to === "BLOCKED" ? { blocked_at: now, blocked_episode_id: id("BLK") } : {}),
    };
    this.missions.set(missionId, { ...m, ...patch });
    if (repairDecision) {
      const started: RecoveryDecision = {
        ...repairDecision,
        status: "started",
      };
      this.recoveryDecisions.set(started.recoveryId, started);
      this.emit(
        "recovery.started",
        missionId,
        {
          actor,
          decision: started,
          mission_id: missionId,
          mission_patch: patch,
        },
        now,
      );
    } else {
      this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch }, now);
    }
    if (to === "BLOCKED" && this.missions.get(missionId)?.blocked_episode_id) {
      const blockerEpisodeId = this.missions.get(missionId)!.blocked_episode_id!;
      for (const classification of [...this.failureClassifications.values()].filter(
        (entry) => entry.missionId === missionId && !entry.blockerEpisodeId,
      )) {
        const associated = { ...classification, blockerEpisodeId };
        this.failureClassifications.set(associated.classificationId, associated);
        this.emit("failure.classified", missionId, { actor: "system", classification: associated }, now);
      }
    }
    return this.getMission(missionId)!;
  }

  updateMission(missionId: string, patch: MissionUpdatePatch, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    if (Object.hasOwn(patch, "status")) {
      throw new Error("mission status must be changed through transitionMission");
    }
    const safePatch = validateMissionUpdatePatch(patch);
    const now = new Date().toISOString();
    const next = { ...m, ...safePatch, updated_at: now };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch: safePatch }, now);
    return this.getMission(missionId)!;
  }

  completeMission(missionId: string, options: MissionCompletionOptions, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const currentResumptionGeneration = this.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    if (options.expectedResumptionGeneration !== currentResumptionGeneration) {
      throw new Error(
        `stale mission resumption at completion: expected ${options.expectedResumptionGeneration}, current ${currentResumptionGeneration}`,
      );
    }
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
    this.emit("mission.failed", missionId, {
      actor,
      mission_id: missionId,
      failure_reason: reason,
    });
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
    const next = {
      ...m,
      acceptance_criteria: criteria,
      updated_at: new Date().toISOString(),
    };
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
    const next = {
      ...m,
      acceptance_criteria: criteria,
      updated_at: new Date().toISOString(),
    };
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
    const authority = this.missionLeases.get(input.mission_id);
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
      deliverables: input.deliverables ? [...input.deliverables] : [],
      execution_budget_ms: input.execution_budget_ms,
      checkpoint_policy: input.checkpoint_policy ? { ...input.checkpoint_policy } : undefined,
      required_output_artifacts: input.required_output_artifacts ? [...input.required_output_artifacts] : [],
      candidate_generation: input.candidate_generation ?? 0,
      mission_generation: input.mission_generation ?? authority?.generation ?? 0,
      resumption_generation:
        input.resumption_generation ??
        authority?.resumptionGeneration ??
        this.listMissionResumptions(input.mission_id).at(-1)?.generation ??
        0,
      fencing_token: input.fencing_token ?? authority?.fencingToken ?? 0,
      recovery_authority: input.recovery_authority ? { ...input.recovery_authority } : undefined,
      repair_base_candidate_sha: input.repair_base_candidate_sha,
      replacement_spec_fingerprint: input.replacement_spec_fingerprint,
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

  assignTaskAuthority(taskId: string, lease: MissionLease): OrchestrationTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.mission_id !== lease.missionId) throw new Error(`lease mission does not match task ${taskId}`);
    task.mission_generation = lease.generation;
    task.resumption_generation = lease.resumptionGeneration ?? 0;
    task.fencing_token = lease.fencingToken;
    this.emit("task.authority_assigned", task.mission_id, {
      actor: "system",
      task_id: taskId,
      mission_generation: lease.generation,
      resumption_generation: lease.resumptionGeneration ?? 0,
      fencing_token: lease.fencingToken,
    });
    return copyTask(task);
  }

  assignTaskExecution(taskId: string, executionId: string): OrchestrationTask {
    const task = this.tasks.get(taskId);
    const execution = this.executions.get(executionId);
    if (!task || !execution || execution.task_id !== taskId || execution.mission_id !== task.mission_id)
      throw new Error(`execution ${executionId} does not belong to task ${taskId}`);
    if (task.assigned_execution_id && task.assigned_execution_id !== executionId) {
      const assigned = this.executions.get(task.assigned_execution_id);
      if (assigned && !["SUCCEEDED", "FAILED", "CANCELED"].includes(assigned.status))
        throw new Error(`task ${taskId} already has an active assigned execution`);
    }
    task.assigned_execution_id = executionId;
    this.emit("task.authority_assigned", task.mission_id, {
      actor: "system",
      task_id: taskId,
      mission_generation: task.mission_generation,
      resumption_generation: task.resumption_generation,
      fencing_token: task.fencing_token,
      assigned_execution_id: executionId,
    });
    return copyTask(task);
  }

  listTasks(missionId?: string): OrchestrationTask[] {
    return [...this.tasks.values()].filter((t) => (missionId ? t.mission_id === missionId : true)).map(copyTask);
  }

  transitionTask(
    taskId: string,
    to: TaskStatus,
    actor = "system",
    metadata: TaskTransitionMetadata = {},
  ): OrchestrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (Object.hasOwn(metadata, "status")) {
      throw new Error("task status must be changed through transitionTask");
    }
    const extra = validateTaskTransitionMetadata(metadata);
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
    const event = this.emit(type, t.mission_id, {
      actor,
      task_id: taskId,
      status: to,
      ...extra,
    });
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
    if (TERMINAL_TASK_STATUSES.has(t.status)) {
      throw new Error(`terminal task ${taskId} is immutable`);
    }
    const next = { ...t, steer_requests: [...t.steer_requests, request] };
    this.tasks.set(taskId, next);
    this.emit("task.steered", t.mission_id, {
      actor,
      task_id: taskId,
      request,
    });
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
    resumption_generation?: number;
    fencing_token?: number;
    checkpoint_id?: string;
    repo_id?: string;
    base_sha?: string;
    candidate_generation?: number;
  }): Execution {
    const task = this.tasks.get(input.task_id);
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
      mission_generation: input.mission_generation ?? task?.mission_generation ?? 0,
      resumption_generation: input.resumption_generation ?? task?.resumption_generation ?? 0,
      fencing_token: input.fencing_token ?? task?.fencing_token ?? 0,
      checkpoint_id: input.checkpoint_id,
      repo_id: input.repo_id,
      base_sha: input.base_sha,
      candidate_generation: input.candidate_generation ?? task?.candidate_generation ?? 0,
    };
    this.executions.set(ex.execution_id, ex);
    this.emit("execution.created", input.mission_id, {
      actor: "system",
      execution: ex,
    });
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
    if (status === "RUNNING") this.recordAuthoritativeExecutionStart(next);
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

  /** Atomically settle one current execution and publish its candidate-bound gate evidence. */
  publishGateEvidenceIfAuthoritative(input: GateEvidencePublication): Promise<Execution> {
    const publish = this.emitChain.then(async () => {
      await this.drainPending();
      this.assertExecutionAuthoritative(input.executionId);
      const current = this.executions.get(input.executionId)!;
      const task = this.tasks.get(current.task_id)!;
      const now = new Date().toISOString();
      const identity = this.assertCandidateIdentity(
        current.mission_id,
        input.identity,
        hashCandidateEvidenceIdentity(input.identity),
      );
      const identityHash = hashCandidateEvidenceIdentity(identity);
      const execution: Execution = {
        ...current,
        status: "SUCCEEDED",
        ended_at: now,
        exit_status: input.exitStatus,
        artifact_refs: [...input.artifactRefs],
        usage: structuredClone(input.usage),
        ...(input.recoveredMerged?.length ? { recovered_merged: [...input.recoveredMerged] } : {}),
        ...(input.reviewedRecovered?.length ? { reviewed_recovered: [...input.reviewedRecovered] } : {}),
      };
      const candidate: CandidateRevision = {
        missionId: current.mission_id,
        taskId: task.task_id,
        executionId: current.execution_id,
        identity,
        identityHash,
        reason: input.reason.trim() || "candidate changed",
        recordedAt: now,
      };
      const evidenceRecordedAt = this.freshEvidenceTimestamp({
        missionId: current.mission_id,
        identityHash,
        recordedAt: now,
      });
      const validationEvidence = input.validationEvidence
        ? copyValidationEvidence({
            ...input.validationEvidence,
            identity,
            identityHash,
            recordedAt: evidenceRecordedAt,
          })
        : undefined;
      const reviewEvidence = input.reviewEvidence
        ? copyReviewEvidence({
            ...input.reviewEvidence,
            identity,
            identityHash,
            recordedAt: evidenceRecordedAt,
          })
        : undefined;
      const prior = this.candidates.get(candidateKey(current.mission_id, identity.repoId));
      const invalidation =
        prior && prior.identityHash !== identityHash
          ? {
              invalidationId: id("EI"),
              missionId: current.mission_id,
              identity: prior.identity,
              reason: input.reason.trim() || "candidate changed",
              invalidatedAt: now,
              scope: "all" as const,
            }
          : undefined;
      const payload = structuredClone({
        actor: "system",
        execution,
        candidate,
        ...(validationEvidence ? { validationEvidence } : {}),
        ...(reviewEvidence ? { reviewEvidence } : {}),
        ...(invalidation ? { invalidation } : {}),
      });
      this.assertGateEvidencePublication(payload);
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: current.mission_id,
        timestamp: now,
        type: "execution.gate_evidence_published",
        actor: "system",
        payload,
      };
      let authorityError: unknown;
      let appended: StoredEvent | undefined;
      try {
        appended = await this.backend.appendConditionally(
          {
            event_id: event.event_id,
            timestamp: event.timestamp,
            type: event.type,
            project_id: null,
            run_id: event.mission_id,
            worker_id: null,
            payload,
          },
          () => {
            try {
              this.assertExecutionAuthoritative(input.executionId);
              return true;
            } catch (error) {
              authorityError = error;
              return false;
            }
          },
          () => this.apply(event),
        );
      } catch (error) {
        if (!authorityError) this.recordPersistenceFailure(event, error);
        throw error;
      }
      if (!appended) throw authorityError ?? new Error("gate evidence authority changed before publication");
      this.clearPersistenceFailure(event.event_id);
      return this.getExecution(input.executionId)!;
    });
    this.emitChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
  }

  private assertGateEvidencePublication(payload: Record<string, unknown>): void {
    const execution = payload.execution as Execution;
    const candidate = payload.candidate as CandidateRevision;
    const validationEvidence = payload.validationEvidence as ValidationEvidence | undefined;
    const reviewEvidence = payload.reviewEvidence as ReviewEvidence | undefined;
    const current = this.executions.get(execution.execution_id);
    const task = current ? this.tasks.get(current.task_id) : undefined;
    if (!current || !task || current.status !== "RUNNING") {
      throw new Error("gate evidence execution is not currently authoritative");
    }
    this.assertExecutionAuthoritative(current.execution_id);
    const immutableMismatches = [
      current.task_id !== execution.task_id ? "task" : null,
      current.mission_id !== execution.mission_id ? "mission" : null,
      current.backend !== execution.backend ? "backend" : null,
      current.mission_generation !== execution.mission_generation ? "mission generation" : null,
      current.resumption_generation !== execution.resumption_generation ? "resumption generation" : null,
      current.candidate_generation !== execution.candidate_generation ? "candidate generation" : null,
      current.fencing_token !== execution.fencing_token ? "fencing token" : null,
    ].filter((value): value is string => value !== null);
    if (immutableMismatches.length > 0) {
      throw new Error(`gate evidence execution identity mismatch: ${immutableMismatches.join(", ")}`);
    }
    const identity = this.assertCandidateIdentity(candidate.missionId, candidate.identity, candidate.identityHash);
    this.assertSettledExecutionIdentity(task, execution, identity);
    if (
      candidate.missionId !== execution.mission_id ||
      candidate.taskId !== task.task_id ||
      candidate.executionId !== execution.execution_id ||
      task.repo_id !== identity.repoId ||
      execution.repo_id !== identity.repoId ||
      execution.base_sha !== identity.baseSha
    ) {
      throw new Error("gate evidence candidate provenance mismatch");
    }
    this.assertUnusedCandidateExecution(execution.execution_id);
    if (validationEvidence) {
      if (execution.backend !== "validation") throw new Error("validation evidence backend mismatch");
      this.assertGateEvidenceRecord(validationEvidence, candidate, execution, task);
      if (
        !validationEvidence.command.trim() ||
        !validationEvidence.profile.trim() ||
        !Number.isInteger(validationEvidence.exitCode)
      )
        throw new Error("malformed validation evidence");
      validateAcceptanceResults(validationEvidence.acceptanceResults, identity.acceptanceIds);
      this.assertUnusedEvidenceExecution(execution.execution_id, this.validationEvidence.values());
    }
    if (reviewEvidence) {
      if (execution.backend !== "review") throw new Error("review evidence backend mismatch");
      this.assertGateEvidenceRecord(reviewEvidence, candidate, execution, task);
      if (!reviewEvidence.reviewerSessionId.trim() || !reviewEvidence.model.trim() || !reviewEvidence.provider.trim())
        throw new Error("malformed review evidence identity");
      if (
        !Array.isArray(reviewEvidence.findings) ||
        reviewEvidence.findings.some((finding) => !finding.summary?.trim())
      )
        throw new Error("malformed review findings");
      validateAcceptanceResults(reviewEvidence.acceptanceResults, identity.acceptanceIds);
      this.assertUnusedEvidenceExecution(execution.execution_id, this.reviewEvidence.values());
    }
  }

  private assertGateEvidenceRecord(
    evidence: ValidationEvidence | ReviewEvidence,
    candidate: CandidateRevision,
    execution: Execution,
    task: OrchestrationTask,
  ): void {
    if (
      evidence.missionId !== candidate.missionId ||
      evidence.taskId !== task.task_id ||
      evidence.executionId !== execution.execution_id ||
      evidence.identityHash !== candidate.identityHash ||
      hashCandidateEvidenceIdentity(evidence.identity) !== candidate.identityHash
    ) {
      throw new Error("gate evidence provenance mismatch");
    }
  }

  private applyGateEvidencePublication(payload: Record<string, unknown>): void {
    try {
      this.assertGateEvidencePublication(payload);
      const execution = payload.execution as Execution;
      const candidate = payload.candidate as CandidateRevision;
      const invalidation = payload.invalidation as EvidenceInvalidation | undefined;
      const validationEvidence = payload.validationEvidence as ValidationEvidence | undefined;
      const reviewEvidence = payload.reviewEvidence as ReviewEvidence | undefined;
      this.executions.set(execution.execution_id, copyExecution(execution));
      if (invalidation)
        this.evidenceInvalidations.set(invalidation.invalidationId, copyEvidenceInvalidation(invalidation));
      this.candidates.set(
        candidateKey(candidate.missionId, candidate.identity.repoId),
        copyCandidateRevision(candidate),
      );
      this.candidateExecutionIds.add(candidate.executionId);
      if (validationEvidence)
        this.validationEvidence.set(validationEvidence.evidenceId, copyValidationEvidence(validationEvidence));
      if (reviewEvidence) this.reviewEvidence.set(reviewEvidence.evidenceId, copyReviewEvidence(reviewEvidence));
    } catch (error) {
      const execution = payload.execution as Execution | undefined;
      this.quarantineEvidence(execution?.mission_id ?? "unknown", error);
    }
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

  executionAuthoritativeStartOrder(executionId: string): number | undefined {
    return this.authoritativeExecutionStartOrder.get(executionId);
  }

  private recordAuthoritativeExecutionStart(execution: Execution): void {
    if (this.authoritativeExecutionStartOrder.has(execution.execution_id)) return;
    const task = this.tasks.get(execution.task_id);
    if (
      !task ||
      task.mission_id !== execution.mission_id ||
      task.assigned_execution_id !== execution.execution_id ||
      task.mission_generation !== execution.mission_generation ||
      task.resumption_generation !== execution.resumption_generation ||
      task.candidate_generation !== execution.candidate_generation ||
      task.fencing_token !== execution.fencing_token
    )
      return;
    this.authoritativeExecutionStartOrder.set(execution.execution_id, ++this.executionStartSequence);
  }

  /**
   * Assert that an execution still owns its result/mutation epoch.
   *
   * Execution status is the broker-local revocation fence: once timeout or
   * cancellation settles it, continuations from the backend may be observed
   * as evidence but can no longer publish artifacts, findings, checkpoints,
   * candidate state, or handoffs. Generation fields additionally prevent an
   * older execution from writing through a reassigned task.
   */
  assertExecutionAuthoritative(executionId: string): Execution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`unknown execution ${executionId}`);
    if (execution.status !== "RUNNING") {
      throw new Error(`execution ${executionId} is no longer authoritative (${execution.status})`);
    }
    const task = this.tasks.get(execution.task_id);
    if (!task) throw new Error(`unknown task ${execution.task_id}`);
    const mismatches = [
      task.mission_generation !== execution.mission_generation ? "mission generation" : null,
      task.resumption_generation !== execution.resumption_generation ? "resumption generation" : null,
      execution.resumption_generation !== (this.listMissionResumptions(execution.mission_id).at(-1)?.generation ?? 0)
        ? "current resumption generation"
        : null,
      task.candidate_generation !== execution.candidate_generation ? "candidate generation" : null,
      task.fencing_token !== execution.fencing_token ? "fencing token" : null,
      task.assigned_execution_id && task.assigned_execution_id !== executionId ? "assigned execution" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) {
      throw new Error(`stale execution identity for ${executionId}: ${mismatches.join(", ")}`);
    }
    return copyExecution(execution);
  }

  rejectLateExecution(executionId: string, reason: string, evidence?: Record<string, unknown>): Execution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`unknown execution ${executionId}`);
    // A late observation is append-only evidence. Never rewrite an already
    // terminal timeout/cancellation outcome with whatever the stale backend
    // happened to return later.
    const rejected: Execution =
      execution.status === "RUNNING"
        ? {
            ...execution,
            status: "CANCELED",
            exit_status: `late_result_rejected:${reason}`,
            ended_at: new Date().toISOString(),
          }
        : execution;
    if (execution.status === "RUNNING") this.executions.set(executionId, rejected);
    this.emit("execution.late_result_rejected", execution.mission_id, {
      actor: "system",
      execution: rejected,
      reason,
      ...(evidence ? { evidence } : {}),
    });
    return copyExecution(rejected);
  }

  /**
   * Fence executions that survived their controller episode before recovery
   * can dispatch replacement work. The orphan marker is durable first; replay
   * then observes either the still-live orphan or its terminal reconciliation.
   */
  reconcileOrphanedExecutions(missionId: string): Execution[] {
    const reconciled: Execution[] = [];
    for (const execution of this.listExecutions(missionId).filter((entry) => entry.status === "RUNNING")) {
      this.emit("execution.orphaned", missionId, {
        actor: "system",
        execution,
        reason: "blocked mission recovery fenced prior controller execution",
      });
      const terminal: Execution = {
        ...execution,
        status: "CANCELED",
        exit_status: "orphaned_execution_reconciled",
        ended_at: new Date().toISOString(),
      };
      this.executions.set(execution.execution_id, terminal);
      this.emit("execution.reconciled", missionId, {
        actor: "system",
        execution: terminal,
        reason: "prior execution fenced before replacement dispatch",
      });
      const task = this.tasks.get(execution.task_id);
      if (task?.status === "RUNNING" && task.assigned_execution_id === execution.execution_id) {
        this.transitionTask(task.task_id, "RETRYING", "system", {
          failure_reason: "orphaned execution fenced during mission recovery",
        });
        this.transitionTask(task.task_id, "READY");
      }
      reconciled.push(copyExecution(terminal));
    }
    return reconciled;
  }

  /** Append inert late evidence and keep append failures visible in persistenceDiagnostics(). */
  async recordLateExecution(executionId: string, reason: string, evidence: LateExecutionEvidence): Promise<boolean> {
    this.rejectLateExecution(executionId, reason, evidence);
    try {
      await this.flush();
      return true;
    } catch {
      // drainPending records the exact failed event for operator diagnostics.
      return false;
    }
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
    this.emit("finding.created", finding.mission_id, {
      actor: "agent",
      finding: f,
    });
    return { ...f };
  }

  resolveFinding(findingId: string): void {
    const f = this.findings.get(findingId);
    if (!f) return;
    f.status = "resolved";
    this.emit("finding.resolved", f.mission_id, {
      actor: "system",
      finding_id: findingId,
    });
  }

  listFindings(missionId?: string): ReviewFinding[] {
    return [...this.findings.values()]
      .filter((f) => (missionId ? f.mission_id === missionId : true))
      .map((f) => ({ ...f }));
  }

  /** Preserve a settled outcome while making failed lease cleanup durable and visible. */
  async recordOwnershipReleaseFailure(input: {
    missionId: string;
    taskId?: string;
    repoId?: string;
    generation: number;
    fencingToken: number;
    ownerId: string;
    renewBy: string;
    error: unknown;
  }): Promise<ReviewFinding> {
    const scope = input.repoId ? "repository" : "mission";
    const message = persistenceErrorMessage(input.error);
    const finding = this.addFinding({
      mission_id: input.missionId,
      task_id: input.taskId ?? null,
      severity: "major",
      category: "ownership_release",
      file: null,
      line: null,
      summary: `${scope} ownership release failed after outcome settlement`,
      evidence: JSON.stringify({
        scope,
        missionId: input.missionId,
        taskId: input.taskId ?? null,
        repoId: input.repoId ?? null,
        generation: input.generation,
        fencingToken: input.fencingToken,
        ownerId: input.ownerId,
        renewBy: input.renewBy,
        error: message,
      }),
      recommended_action: "Inspect writer health and reconcile the durable lease before the next mutation.",
    });
    // A failed flush remains queued and is also exposed through
    // persistenceDiagnostics(); never rewrite the already-settled outcome.
    await this.flush().catch(() => undefined);
    return finding;
  }

  // ── Durable reliability authority ──────────────────────────────────────

  bindWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
    if (!this.missions.has(manifest.missionId)) throw new Error(`unknown mission ${manifest.missionId}`);
    const copy = copyWorkspaceManifest(manifest);
    const prior = this.workspaceManifests.get(manifest.missionId);
    const type = prior ? "workspace.rebound" : "workspace.authorized";
    if (prior) this.invalidateCurrentCandidate(manifest.missionId, "workspace manifest rebound");
    this.workspaceManifests.set(manifest.missionId, copy);
    this.emit(type, manifest.missionId, { actor: "system", manifest: copy });
    return copyWorkspaceManifest(copy);
  }

  /** Publish a manifest only after its event is durably appended. */
  bindWorkspaceManifestDurably(
    manifest: WorkspaceManifest,
    expectedPredecessor: { generation: number; hash: string } | null,
  ): Promise<WorkspaceManifest> {
    const publish = this.emitChain.then(async () => {
      await this.drainPending();
      if (!this.missions.has(manifest.missionId)) throw new Error(`unknown mission ${manifest.missionId}`);
      const copy = copyWorkspaceManifest(manifest);
      const prior = this.workspaceManifests.get(manifest.missionId);
      const expectedGeneration = expectedPredecessor?.generation ?? 0;
      if (manifest.generation !== expectedGeneration + 1) {
        throw new Error(
          `workspace manifest generation must advance exactly once (${expectedGeneration} -> ${manifest.generation})`,
        );
      }
      const type = prior ? "workspace.rebound" : "workspace.authorized";
      const payload = structuredClone({ actor: "system", manifest: copy });
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: manifest.missionId,
        timestamp: new Date().toISOString(),
        type,
        actor: "system",
        payload,
      };
      const stored: StoredEvent = {
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.type,
        project_id: null,
        run_id: manifest.missionId,
        worker_id: null,
        payload,
      };
      let appended: StoredEvent | undefined;
      try {
        appended = await this.backend.appendConditionally(
          stored,
          () => {
            const durablePrior = this.backend
              .all()
              .filter(
                (candidate) =>
                  candidate.run_id === manifest.missionId &&
                  (candidate.type === "workspace.authorized" || candidate.type === "workspace.rebound"),
              )
              .at(-1)?.payload.manifest as WorkspaceManifest | undefined;
            if (expectedPredecessor === null) return durablePrior === undefined && manifest.generation === 1;
            return (
              durablePrior?.generation === expectedPredecessor.generation &&
              durablePrior.hash === expectedPredecessor.hash &&
              manifest.generation === expectedPredecessor.generation + 1
            );
          },
          () => this.apply(event),
        );
      } catch (error) {
        this.recordPersistenceFailure(event, error);
        throw error;
      }
      if (!appended) throw new Error("workspace manifest durable compare-and-swap was rejected");
      this.clearPersistenceFailure(event.event_id);
      if (prior) this.invalidateCurrentCandidate(manifest.missionId, "workspace manifest rebound");
      return copyWorkspaceManifest(copy);
    });
    this.emitChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
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
    this.recordTaskCheckpoint(copy);
    this.emit("task.checkpointed", checkpoint.missionId, {
      actor: "system",
      checkpoint: copy,
    });
    return copyTaskCheckpoint(copy);
  }

  /**
   * Serialize the authority check with durable checkpoint publication.
   * Unlike checkpointTask(), this does not expose the checkpoint in memory or
   * enqueue its event before the expected execution identity is current.
   */
  publishCheckpointIfAuthoritative(checkpoint: TaskCheckpoint): Promise<TaskCheckpoint> {
    const publish = this.emitChain.then(async () => {
      await this.drainPending();
      this.assertCheckpointAuthoritative(checkpoint);

      const copy = copyTaskCheckpoint(checkpoint);
      const payload = structuredClone({ actor: "system", checkpoint: copy });
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: checkpoint.missionId,
        timestamp: new Date().toISOString(),
        type: "task.checkpointed",
        actor: "system",
        payload,
      };
      const stored: StoredEvent = {
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.type,
        project_id: null,
        run_id: checkpoint.missionId,
        worker_id: null,
        payload,
      };
      let authorityError: unknown;
      try {
        const appended = await this.backend.appendConditionally(
          stored,
          () => {
            try {
              this.assertCheckpointAuthoritative(checkpoint);
              return true;
            } catch (error) {
              authorityError = error;
              return false;
            }
          },
          () => this.apply(event),
        );
        if (!appended) throw authorityError ?? new Error("checkpoint origin mismatch");
      } catch (error) {
        if (!authorityError) this.recordPersistenceFailure(event, error);
        throw error;
      }
      this.clearPersistenceFailure(event.event_id);
      return copyTaskCheckpoint(copy);
    });
    this.emitChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
  }

  private assertCheckpointAuthoritative(checkpoint: TaskCheckpoint): void {
    this.assertExecutionAuthoritative(checkpoint.executionId);
    const task = this.tasks.get(checkpoint.taskId);
    const repository = this.workspaceManifests
      .get(checkpoint.missionId)
      ?.repositories.find((candidate) => candidate.repoId === checkpoint.repoId);
    const mismatches = [
      !task || task.mission_id !== checkpoint.missionId ? "task" : null,
      task?.assigned_execution_id && task.assigned_execution_id !== checkpoint.executionId
        ? "execution assignment"
        : null,
      task?.repo_id !== checkpoint.repoId ? "repository" : null,
      !repository || repository.baseSha !== checkpoint.baseSha ? "base" : null,
      (task?.mission_generation ?? 0) !== checkpoint.missionGeneration ? "mission generation" : null,
      (task?.candidate_generation ?? 0) !== checkpoint.candidateGeneration ? "candidate generation" : null,
      (task?.fencing_token ?? 0) !== checkpoint.fencingToken ? "fencing token" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) throw new Error(`checkpoint origin mismatch: ${mismatches.join(", ")}`);
  }

  listTaskCheckpoints(missionId?: string, taskId?: string): TaskCheckpoint[] {
    return [...this.taskCheckpoints.values()]
      .filter((checkpoint) => (missionId ? checkpoint.missionId === missionId : true))
      .filter((checkpoint) => (taskId ? checkpoint.taskId === taskId : true))
      .sort(
        (left, right) =>
          (this.taskCheckpointLastEventOrdinals.get(left.checkpointId) ?? 0) -
          (this.taskCheckpointLastEventOrdinals.get(right.checkpointId) ?? 0),
      )
      .map(copyTaskCheckpoint);
  }

  private recordTaskCheckpoint(checkpoint: TaskCheckpoint): void {
    const copy = copyTaskCheckpoint(checkpoint);
    this.taskCheckpoints.set(copy.checkpointId, copy);
    this.taskCheckpointLastEventOrdinals.set(copy.checkpointId, ++this.taskCheckpointEventOrdinal);
  }

  classifyFailure(classification: FailureClassification): FailureClassification {
    if (!this.missions.has(classification.missionId)) throw new Error(`unknown mission ${classification.missionId}`);
    const copy = copyFailureClassification(classification);
    this.failureClassifications.set(copy.classificationId, copy);
    this.emit("failure.classified", classification.missionId, {
      actor: "system",
      classification: copy,
    });
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
    if (this.recoveryDecisions.has(decision.recoveryId)) {
      throw new Error(`duplicate recovery ID ${decision.recoveryId}`);
    }
    const mission = this.missions.get(decision.missionId)!;
    if (decision.action === "REPAIR_BLOCKED_MISSION" && (mission.status !== "BLOCKED" || !mission.blocked_episode_id)) {
      throw new Error("blocked-mission repair must be planned during a durable BLOCKED episode");
    }
    const copy: RecoveryDecision = {
      ...decision,
      ...(decision.startingCandidateContent
        ? { startingCandidateContent: { ...decision.startingCandidateContent } }
        : {}),
      status: "planned",
      resumptionGeneration: this.listMissionResumptions(decision.missionId).at(-1)?.generation ?? 0,
      ...(mission.status === "BLOCKED" && decision.action !== "STOP"
        ? { blockedEpisodeId: mission.blocked_episode_id }
        : {}),
    };
    this.recoveryDecisions.set(copy.recoveryId, copy);
    this.emit("recovery.planned", decision.missionId, {
      actor: "system",
      decision: copy,
    });
    return copyRecoveryDecision(copy);
  }

  transitionRecovery(recoveryId: string, status: Exclude<RecoveryStatus, "planned">): RecoveryDecision {
    const decision = this.recoveryDecisions.get(recoveryId);
    if (!decision) throw new Error(`unknown recovery ${recoveryId}`);
    if (!RECOVERY_TRANSITIONS[decision.status].includes(status)) {
      throw new Error(`illegal recovery transition ${decision.status} -> ${status}`);
    }
    if (status === "started" && decision.action === "REPAIR_BLOCKED_MISSION") {
      throw new Error("blocked-mission repair must start atomically through transitionMission");
    }
    const next = { ...decision, status };
    this.recoveryDecisions.set(recoveryId, next);
    this.emit(`recovery.${status}` as OrchestrationEventType, decision.missionId, {
      actor: "system",
      decision: next,
    });
    return copyRecoveryDecision(next);
  }

  listRecoveryDecisions(missionId?: string): RecoveryDecision[] {
    return [...this.recoveryDecisions.values()]
      .filter((decision) => (missionId ? decision.missionId === missionId : true))
      .map(copyRecoveryDecision);
  }

  getRecoveryDecision(recoveryId: string): RecoveryDecision | undefined {
    const decision = this.recoveryDecisions.get(recoveryId);
    return decision ? copyRecoveryDecision(decision) : undefined;
  }

  supersedeTask(supersession: TaskSupersession): TaskSupersession {
    const failed = this.tasks.get(supersession.failedTaskId);
    if (!failed || failed.mission_id !== supersession.missionId || failed.status !== "FAILED") {
      throw new Error(`supersession requires a failed task ${supersession.failedTaskId}`);
    }
    if (supersession.replacementTaskIds.length === 0) throw new Error("supersession requires replacement task IDs");
    if (this.taskSupersessions.has(supersession.supersessionId)) {
      throw new Error(`duplicate supersession ID ${supersession.supersessionId}`);
    }
    if (new Set(supersession.replacementTaskIds).size !== supersession.replacementTaskIds.length) {
      throw new Error("supersession requires unique replacement task IDs");
    }
    if (supersession.replacementTaskIds.includes(failed.task_id)) {
      throw new Error(`failed task ${failed.task_id} cannot replace itself`);
    }
    if (this.listTaskSupersessions(supersession.missionId).some((entry) => entry.failedTaskId === failed.task_id)) {
      throw new Error(`task ${failed.task_id} is already superseded`);
    }
    const failedAcceptance = new Set(failed.acceptance_ids ?? []);
    const declaredAcceptance = new Set(supersession.acceptanceIds);
    if (failed.repo_id !== supersession.repoId || [...failedAcceptance].some((id) => !declaredAcceptance.has(id))) {
      throw new Error("supersession does not match failed task repository coverage and acceptance coverage");
    }
    const expectedCoverage = taskCoverageFingerprint(failed);
    if (supersession.coverageFingerprint !== expectedCoverage) {
      throw new Error("supersession does not match immutable failed task coverage");
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
    if (supersession.recoveryDecisionId) {
      const decision = this.recoveryDecisions.get(supersession.recoveryDecisionId);
      if (!decision || decision.missionId !== supersession.missionId) {
        throw new Error("supersession recovery decision does not match mission");
      }
      if (!supersession.expectedReplacementFingerprints) {
        throw new Error("recovery supersession requires replacement fingerprints");
      }
      if (Object.keys(supersession.expectedReplacementFingerprints).length !== replacements.length) {
        throw new Error("recovery supersession requires exactly one fingerprint per ordered replacement");
      }
      for (const replacement of replacements) {
        const authority = replacement?.recovery_authority;
        const expected = supersession.expectedReplacementFingerprints?.[replacement!.task_id];
        if (
          replacement?.replacement_spec_fingerprint !== expected ||
          (authority !== undefined &&
            (authority.recoveryDecisionId !== supersession.recoveryDecisionId ||
              authority.supersessionId !== supersession.supersessionId ||
              authority.originalTaskId !== supersession.failedTaskId ||
              expected !== authority.expectedReplacementFingerprint))
        ) {
          throw new Error("supersession replacement recovery fingerprint mismatch");
        }
      }
    }
    const copy = copyTaskSupersession(supersession);
    this.taskSupersessions.set(copy.supersessionId, copy);
    this.emit("task.superseded", supersession.missionId, {
      actor: "system",
      supersession: copy,
    });
    return copyTaskSupersession(copy);
  }

  listTaskSupersessions(missionId?: string): TaskSupersession[] {
    return [...this.taskSupersessions.values()]
      .filter((supersession) => (missionId ? supersession.missionId === missionId : true))
      .map(copyTaskSupersession);
  }

  /** Current transitive leaves for a task's immutable supersession lineage. */
  taskSupersessionLeaves(taskId: string, visiting = new Set<string>()): OrchestrationTask[] {
    if (visiting.has(taskId)) return [];
    const lineage = [...this.taskSupersessions.values()].find((entry) => entry.failedTaskId === taskId);
    const task = this.tasks.get(taskId);
    if (!lineage) return task ? [copyTask(task)] : [];
    const next = new Set(visiting).add(taskId);
    return lineage.replacementTaskIds.flatMap((replacementId) => this.taskSupersessionLeaves(replacementId, next));
  }

  isTaskSatisfiedBySupersession(taskId: string): boolean {
    const leaves = this.taskSupersessionLeaves(taskId);
    return leaves.length > 0 && leaves.every((task) => task.status === "SUCCEEDED");
  }

  getTaskSupersession(supersessionId: string): TaskSupersession | undefined {
    const supersession = this.taskSupersessions.get(supersessionId);
    return supersession ? copyTaskSupersession(supersession) : undefined;
  }

  invalidateEvidence(invalidation: EvidenceInvalidation): EvidenceInvalidation {
    if (!this.missions.has(invalidation.missionId)) throw new Error(`unknown mission ${invalidation.missionId}`);
    const copy = copyEvidenceInvalidation(invalidation);
    this.evidenceInvalidations.set(copy.invalidationId, copy);
    this.emit("evidence.invalidated", invalidation.missionId, {
      actor: "system",
      invalidation: copy,
    });
    return copyEvidenceInvalidation(copy);
  }

  recordCandidate(
    missionId: string,
    rawIdentity: CandidateEvidenceIdentity,
    reason: string,
    provenance: { taskId: string; executionId: string },
  ): CandidateRevision {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const identity = this.assertCandidateIdentity(missionId, rawIdentity, hashCandidateEvidenceIdentity(rawIdentity));
    const identityHash = hashCandidateEvidenceIdentity(identity);
    this.assertCandidateProvenance(missionId, identity, provenance.taskId, provenance.executionId);
    this.assertUnusedCandidateExecution(provenance.executionId);
    const key = candidateKey(missionId, identity.repoId);
    const prior = this.candidates.get(key);
    if (prior && prior.identityHash !== identityHash) this.invalidateCandidate(prior, reason);
    const candidate: CandidateRevision = {
      missionId,
      taskId: provenance.taskId,
      executionId: provenance.executionId,
      identity,
      identityHash,
      reason: reason.trim() || "candidate changed",
      recordedAt: new Date().toISOString(),
    };
    this.candidates.set(key, candidate);
    this.candidateExecutionIds.add(candidate.executionId);
    this.emit("candidate.changed", missionId, { actor: "system", candidate });
    return copyCandidateRevision(candidate);
  }

  getCandidate(missionId: string, repoId?: string): CandidateRevision | undefined {
    const candidates = [...this.candidates.values()].filter((entry) => entry.missionId === missionId);
    const candidate = repoId
      ? this.candidates.get(candidateKey(missionId, repoId))
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    return candidate ? copyCandidateRevision(candidate) : undefined;
  }

  listCandidates(missionId: string): CandidateRevision[] {
    return [...this.candidates.values()].filter((entry) => entry.missionId === missionId).map(copyCandidateRevision);
  }

  evidenceDiagnostics(missionId: string): string[] {
    return [...(this.evidenceReplayErrors.get(missionId) ?? [])];
  }

  recordValidationEvidence(raw: ValidationEvidence): ValidationEvidence {
    this.assertValidationEvidence(raw);
    this.assertUnusedEvidenceExecution(raw.executionId, this.validationEvidence.values());
    const evidence = copyValidationEvidence({
      ...raw,
      recordedAt: this.freshEvidenceTimestamp(raw),
    });
    this.validationEvidence.set(evidence.evidenceId, evidence);
    this.emit("evidence.validation_recorded", evidence.missionId, {
      actor: "system",
      evidence,
    });
    return copyValidationEvidence(evidence);
  }

  listValidationEvidence(missionId?: string): ValidationEvidence[] {
    return [...this.validationEvidence.values()]
      .filter((evidence) => (missionId ? evidence.missionId === missionId : true))
      .map(copyValidationEvidence);
  }

  recordReviewEvidence(raw: ReviewEvidence): ReviewEvidence {
    this.assertReviewEvidence(raw);
    this.assertUnusedEvidenceExecution(raw.executionId, this.reviewEvidence.values());
    const evidence = copyReviewEvidence({
      ...raw,
      recordedAt: this.freshEvidenceTimestamp(raw),
    });
    this.reviewEvidence.set(evidence.evidenceId, evidence);
    this.emit("evidence.review_recorded", evidence.missionId, {
      actor: "system",
      evidence,
    });
    return copyReviewEvidence(evidence);
  }

  listReviewEvidence(missionId?: string): ReviewEvidence[] {
    return [...this.reviewEvidence.values()]
      .filter((evidence) => (missionId ? evidence.missionId === missionId : true))
      .map(copyReviewEvidence);
  }

  private assertEvidenceRecord(missionId: string, identity: CandidateEvidenceIdentity, identityHash: string): void {
    this.assertCandidateIdentity(missionId, identity, identityHash);
  }

  private assertCandidateIdentity(
    missionId: string,
    raw: CandidateEvidenceIdentity,
    identityHash: string,
  ): CandidateEvidenceIdentity {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const identity = buildCandidateEvidenceIdentity(raw);
    if (hashCandidateEvidenceIdentity(identity) !== identityHash) throw new Error("malformed candidate evidence hash");
    const manifest = this.workspaceManifests.get(missionId);
    if (!manifest || manifest.hash !== identity.workspaceManifestHash)
      throw new Error("candidate identity does not match the current workspace manifest");
    const binding = manifest.repositories.find((repository) => repository.repoId === identity.repoId);
    if (!binding || binding.baseSha !== identity.baseSha)
      throw new Error("candidate identity does not match the current repository/base");
    return identity;
  }

  private assertEvidenceProvenance(raw: ValidationEvidence | ReviewEvidence, backend: "validation" | "review"): void {
    this.assertEvidenceRecord(raw.missionId, raw.identity, raw.identityHash);
    const task = this.tasks.get(raw.taskId);
    const execution = this.executions.get(raw.executionId);
    if (!task || !execution) throw new Error("evidence execution is not a successful authoritative execution");
    this.assertSettledExecutionIdentity(task, execution, raw.identity, backend);
    if (
      task.mission_id !== raw.missionId ||
      execution.mission_id !== raw.missionId ||
      execution.task_id !== task.task_id
    )
      throw new Error("evidence provenance mission/task mismatch");
    if (
      task.repo_id !== raw.identity.repoId ||
      execution.repo_id !== raw.identity.repoId ||
      execution.base_sha !== raw.identity.baseSha
    )
      throw new Error("evidence provenance repository mismatch");
  }

  private assertCandidateProvenance(
    missionId: string,
    identity: CandidateEvidenceIdentity,
    taskId?: string,
    executionId?: string,
  ): void {
    const task = taskId ? this.tasks.get(taskId) : undefined;
    const execution = executionId ? this.executions.get(executionId) : undefined;
    if (!task || !execution) throw new Error("candidate requires a successful authoritative execution");
    this.assertSettledExecutionIdentity(task, execution, identity);
    if (task.mission_id !== missionId || execution.mission_id !== missionId || execution.task_id !== task.task_id)
      throw new Error("candidate provenance mission/task mismatch");
    if (
      task.repo_id !== identity.repoId ||
      execution.repo_id !== identity.repoId ||
      execution.base_sha !== identity.baseSha
    )
      throw new Error("candidate provenance repository mismatch");
  }

  private assertSettledExecutionIdentity(
    task: OrchestrationTask,
    execution: Execution,
    identity: CandidateEvidenceIdentity,
    backend?: "validation" | "review",
  ): void {
    if (
      execution.status !== "SUCCEEDED" ||
      !execution.ended_at ||
      !Number.isFinite(Date.parse(execution.ended_at)) ||
      (backend !== undefined && execution.backend !== backend)
    )
      throw new Error("evidence execution is not a successful authoritative execution");
    const mismatches = [
      task.mission_generation !== identity.missionGeneration ? "mission generation" : null,
      execution.mission_generation !== identity.missionGeneration ? "execution mission generation" : null,
      task.candidate_generation !== execution.candidate_generation ? "candidate generation" : null,
      task.fencing_token !== execution.fencing_token ? "fencing token" : null,
      task.assigned_execution_id !== execution.execution_id ? "assigned execution" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) throw new Error(`evidence execution is not authoritative: ${mismatches.join(", ")}`);
  }

  private assertUnusedCandidateExecution(executionId: string): void {
    if (this.candidateExecutionIds.has(executionId))
      throw new Error(`historical execution ${executionId} already recorded candidate evidence`);
  }

  private assertUnusedEvidenceExecution<T extends { executionId: string }>(
    executionId: string,
    existing: IterableIterator<T>,
  ): void {
    if ([...existing].some((evidence) => evidence.executionId === executionId))
      throw new Error(`historical execution ${executionId} already recorded evidence`);
  }

  private assertValidationEvidence(raw: ValidationEvidence): void {
    this.assertEvidenceProvenance(raw, "validation");
    if (!raw.command.trim() || !raw.profile.trim() || !Number.isInteger(raw.exitCode))
      throw new Error("malformed validation evidence");
    validateAcceptanceResults(raw.acceptanceResults, raw.identity.acceptanceIds);
  }

  private assertReviewEvidence(raw: ReviewEvidence): void {
    this.assertEvidenceProvenance(raw, "review");
    if (!raw.reviewerSessionId.trim() || !raw.model.trim() || !raw.provider.trim())
      throw new Error("malformed review evidence identity");
    if (!Array.isArray(raw.findings) || raw.findings.some((finding) => !finding.summary?.trim()))
      throw new Error("malformed review findings");
    validateAcceptanceResults(raw.acceptanceResults, raw.identity.acceptanceIds);
  }

  private quarantineEvidence(missionId: string, error: unknown): void {
    const diagnostics = this.evidenceReplayErrors.get(missionId) ?? [];
    diagnostics.push(error instanceof Error ? error.message : String(error));
    this.evidenceReplayErrors.set(missionId, diagnostics);
  }

  private freshEvidenceTimestamp(raw: {
    missionId: string;
    identityHash: string;
    recordedAt: string;
  }): string {
    const latestInvalidation = this.listEvidenceInvalidations(raw.missionId)
      .filter((entry) => hashCandidateEvidenceIdentity(entry.identity) === raw.identityHash)
      .reduce((latest, entry) => Math.max(latest, Date.parse(entry.invalidatedAt)), Number.NEGATIVE_INFINITY);
    const requested = Date.parse(raw.recordedAt);
    const now = Date.now();
    return new Date(Math.max(Number.isFinite(requested) ? requested : now, now, latestInvalidation + 1)).toISOString();
  }

  private invalidateCurrentCandidate(missionId: string, reason: string): void {
    for (const current of this.listCandidates(missionId)) this.invalidateCandidate(current, reason);
  }

  invalidateRepositoryEvidence(missionId: string, repoId: string, reason: string): void {
    const current = this.candidates.get(candidateKey(missionId, repoId));
    if (current) this.invalidateCandidate(current, reason);
  }

  invalidateRepositoryReviewEvidence(missionId: string, repoId: string, reason: string): void {
    const current = this.candidates.get(candidateKey(missionId, repoId));
    if (!current) return;
    this.invalidateEvidence({
      invalidationId: id("EI"),
      missionId,
      identity: current.identity,
      reason,
      invalidatedAt: new Date().toISOString(),
      scope: "review",
    });
  }

  private invalidateCandidate(current: CandidateRevision, reason: string): void {
    this.invalidateEvidence({
      invalidationId: id("EI"),
      missionId: current.missionId,
      identity: current.identity,
      reason,
      invalidatedAt: new Date().toISOString(),
      scope: "all",
    });
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

  getLatestMissionLease(missionId: string): MissionLease | undefined {
    const lease = this.missionLeaseEpochs.get(missionId);
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
    const lease = this.repositoryLeases.get(repoId);
    return lease?.missionId === missionId ? { ...lease } : undefined;
  }

  getRepositoryLeaseByRepoId(repoId: string): RepositoryLease | undefined {
    const lease = this.repositoryLeases.get(repoId);
    return lease ? { ...lease } : undefined;
  }

  getLatestRepositoryLease(repoId: string): RepositoryLease | undefined {
    const lease = this.repositoryLeaseEpochs.get(repoId);
    return lease ? { ...lease } : undefined;
  }

  /** Local takeover is permitted only while this process owns the JSONL writer boundary. */
  hasExclusiveWriterAuthority(): boolean {
    const backend = this.backend as EventStoreBackend & {
      ownsWriterLock?: () => boolean;
    };
    return backend.ownsWriterLock?.() ?? false;
  }

  private applyLeaseTransition(
    transition: LeaseTransition,
    scope: "mission" | "repository",
    lease: MissionLease | RepositoryLease,
  ): void {
    if (!this.missions.has(lease.missionId)) throw new Error(`unknown mission ${lease.missionId}`);
    if (scope === "mission") {
      const prior = this.missionLeaseEpochs.get(lease.missionId);
      if (prior && prior.generation !== lease.generation) {
        this.invalidateCurrentCandidate(lease.missionId, "mission generation changed");
      }
      this.missionLeaseEpochs.set(lease.missionId, { ...lease });
      if (transition === "expired" || transition === "fenced") this.missionLeases.delete(lease.missionId);
      else this.missionLeases.set(lease.missionId, { ...lease });
    } else {
      const repositoryLease = lease as RepositoryLease;
      this.repositoryLeaseEpochs.set(repositoryLease.repoId, {
        ...repositoryLease,
      });
      if (transition === "expired" || transition === "fenced") this.repositoryLeases.delete(repositoryLease.repoId);
      else
        this.repositoryLeases.set(repositoryLease.repoId, {
          ...repositoryLease,
        });
    }
    this.emit(`lease.${transition}`, lease.missionId, {
      actor: "system",
      scope,
      lease,
    });
  }

  resumeMission(missionId: string, reason: string): MissionResumption {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const currentLease = this.missionLeases.get(missionId);
    if (currentLease) {
      this.applyLeaseTransition("fenced", "mission", currentLease);
      for (const repository of this.listRepositoryLeases(missionId)) {
        this.applyLeaseTransition("fenced", "repository", repository);
      }
    }
    const resumption = {
      missionId,
      reason,
      resumedAt: new Date().toISOString(),
      generation: (this.listMissionResumptions(missionId).at(-1)?.generation ?? 0) + 1,
      stopGeneration: this.listMissionStops(missionId).at(-1)?.generation ?? 0,
    };
    this.missionResumptions.push(resumption);
    this.emit("mission.resumed", missionId, { actor: "system", resumption });
    return { ...resumption };
  }

  listMissionResumptions(missionId?: string): MissionResumption[] {
    return this.missionResumptions
      .filter((resumption) => (missionId ? resumption.missionId === missionId : true))
      .map((resumption) => ({ ...resumption }));
  }

  stopMission(
    missionId: string,
    input: Omit<
      MissionStop,
      | "missionId"
      | "stoppedAt"
      | "generation"
      | "resumptionGeneration"
      | "blockedEpisodeId"
      | "recoveryDeadline"
      | "settlementIdentity"
    >,
  ): MissionStop {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    const resumptionGeneration = this.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    const deadlines = this.listRecoveryDecisions(missionId)
      .filter((decision) => (decision.resumptionGeneration ?? 0) === resumptionGeneration)
      .map((decision) => decision.deadline)
      .filter((deadline) => Number.isFinite(Date.parse(deadline)))
      .sort();
    const stop: MissionStop = {
      missionId,
      reason: input.reason,
      preservedWork: [...input.preservedWork],
      attemptedRecoveries: [...input.attemptedRecoveries],
      resumeCondition: input.resumeCondition,
      stoppedAt: new Date().toISOString(),
      generation: (this.listMissionStops(missionId).at(-1)?.generation ?? 0) + 1,
      resumptionGeneration,
      blockedEpisodeId: mission.blocked_episode_id ?? null,
      recoveryDeadline: deadlines[0] ?? null,
    };
    this.missionStops.push(stop);
    this.emit("mission.stopped", missionId, { actor: "system", stop });
    return copyMissionStop(stop);
  }

  /** Settle an exact durable mission snapshot once across every store sharing the backend. */
  stopMissionIfCurrent(
    missionId: string,
    input: Omit<
      MissionStop,
      | "missionId"
      | "stoppedAt"
      | "generation"
      | "resumptionGeneration"
      | "blockedEpisodeId"
      | "recoveryDeadline"
      | "settlementIdentity"
    >,
    expected: MissionRevisionFence,
  ): Promise<MissionStop | undefined> {
    const settle = this.emitChain.then(async () => {
      await this.drainPending();

      const durableBefore = MissionStore.open(this.backend);
      const existingBefore = durableBefore.currentStopForGeneration(missionId, expected.resumptionGeneration);
      if (existingBefore) {
        return settlementIdentityMatches(existingBefore.settlementIdentity, expected)
          ? copyMissionStop(existingBefore)
          : undefined;
      }
      if (!durableBefore.matchesMissionFence(missionId, expected)) return undefined;

      const deadlines = durableBefore
        .listRecoveryDecisions(missionId)
        .filter((decision) => (decision.resumptionGeneration ?? 0) === expected.resumptionGeneration)
        .map((decision) => decision.deadline)
        .filter((deadline) => Number.isFinite(Date.parse(deadline)))
        .sort();
      const stop: MissionStop = {
        missionId,
        reason: input.reason,
        preservedWork: [...input.preservedWork],
        attemptedRecoveries: [...input.attemptedRecoveries],
        resumeCondition: input.resumeCondition,
        stoppedAt: new Date().toISOString(),
        generation: (durableBefore.listMissionStops(missionId).at(-1)?.generation ?? 0) + 1,
        resumptionGeneration: expected.resumptionGeneration,
        blockedEpisodeId: expected.blockedEpisodeId,
        recoveryDeadline: deadlines[0] ?? null,
        settlementIdentity: { ...expected },
      };
      const payload = structuredClone({ actor: "system", stop });
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: missionId,
        timestamp: stop.stoppedAt,
        type: "mission.stopped",
        actor: "system",
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
      let committedByAnotherStore: MissionStop | undefined;
      let appended: StoredEvent | undefined;
      try {
        appended = await this.backend.appendConditionally(
          stored,
          () => {
            const durableCurrent = MissionStore.open(this.backend);
            const existing = durableCurrent.currentStopForGeneration(missionId, expected.resumptionGeneration);
            if (existing) {
              if (settlementIdentityMatches(existing.settlementIdentity, expected)) {
                committedByAnotherStore = existing;
              }
              return false;
            }
            return durableCurrent.matchesMissionFence(missionId, expected);
          },
          () => this.apply(event),
        );
      } catch (error) {
        this.recordPersistenceFailure(event, error);
        throw error;
      }
      if (appended) {
        this.clearPersistenceFailure(event.event_id);
        return copyMissionStop(stop);
      }
      return committedByAnotherStore ? copyMissionStop(committedByAnotherStore) : undefined;
    });
    this.emitChain = settle.then(
      () => undefined,
      () => undefined,
    );
    return settle;
  }

  private currentStopForGeneration(missionId: string, resumptionGeneration: number): MissionStop | undefined {
    return this.missionStops
      .filter((stop) => stop.missionId === missionId && stop.resumptionGeneration === resumptionGeneration)
      .at(-1);
  }

  private matchesMissionFence(missionId: string, expected: MissionRevisionFence): boolean {
    const mission = this.missions.get(missionId);
    const currentGeneration =
      this.missionResumptions.filter((resumption) => resumption.missionId === missionId).at(-1)?.generation ?? 0;
    return (
      !!mission &&
      !["COMPLETE", "FAILED", "CANCELED"].includes(mission.status) &&
      currentGeneration === expected.resumptionGeneration &&
      mission.revision === expected.revision &&
      mission.status === expected.status &&
      (mission.blocked_episode_id ?? null) === expected.blockedEpisodeId
    );
  }

  listMissionStops(missionId?: string): MissionStop[] {
    return this.missionStops.filter((stop) => (missionId ? stop.missionId === missionId : true)).map(copyMissionStop);
  }

  // ── Autonomous spec approval records ────────────────────────────────────

  appendSpecStage(stage: import("./specApproval.ts").SpecStageAttempt): void {
    this.apply(this.emit("spec.stage", stage.missionId, { actor: "system", stage }));
  }

  appendSpecRevision(revision: import("./specApproval.ts").MissionSpecRevision): void {
    this.apply(this.emit("spec.revision", revision.missionId, { actor: "system", revision }));
  }

  appendSpecReview(review: import("./specApproval.ts").SpecReviewEvidence): void {
    this.apply(this.emit("spec.review", review.missionId, { actor: "system", review }));
  }

  appendSpecApproval(approval: import("./specApproval.ts").SpecApproval): void {
    this.apply(this.emit("spec.approval", approval.missionId, { actor: "system", approval }));
  }

  /** Durable invalidation event carrying the prior approval ID + new fencing identity. */
  invalidateSpecApproval(missionId: string, approvalId: string, reason: string, fencingToken: number): void {
    this.apply(this.emit("spec.invalidation", missionId, {
      actor: "system",
      invalidation: { missionId, approvalId, reason, fencingToken },
    }));
  }

  appendSpecMaterialization(
    missionId: string,
    approvalId: string,
    semanticSpecHash: string,
    created: string[],
    reused: string[],
  ): void {
    this.apply(this.emit("spec.materialized", missionId, {
      actor: "system",
      materialization: { missionId, approvalId, semanticSpecHash, created, reused },
    }));
  }

  getSpecRevision(missionId: string): import("./specApproval.ts").MissionSpecRevision | null {
    let latest: import("./specApproval.ts").MissionSpecRevision | null = null;
    for (const revision of this.specRevisions.values()) {
      if (revision.missionId !== missionId) continue;
      if (!latest || revision.revisionNumber > latest.revisionNumber) latest = revision;
    }
    return latest ? structuredClone(latest) : null;
  }

  getSpecReview(missionId: string): import("./specApproval.ts").SpecReviewEvidence | null {
    let latest: import("./specApproval.ts").SpecReviewEvidence | null = null;
    for (const review of this.specReviews.values()) {
      if (review.missionId !== missionId) continue;
      if (!latest || review.reviewedAt > latest.reviewedAt) latest = review;
    }
    return latest ? structuredClone(latest) : null;
  }

  getSpecApproval(missionId: string): import("./specApproval.ts").SpecApproval | null {
    const approval = this.specApprovals.get(missionId);
    return approval ? structuredClone(approval) : null;
  }

  listSpecStages(missionId: string): import("./specApproval.ts").SpecStageAttempt[] {
    return this.specStages.filter((stage) => stage.missionId === missionId).map((stage) => ({ ...stage }));
  }

  getSpecInvalidation(missionId: string): { approvalId: string; reason: string; fencingToken: number } | null {
    const invalidation = this.specInvalidations.get(missionId);
    return invalidation ? { ...invalidation } : null;
  }

  listSpecMaterializations(missionId: string): Array<{
    approvalId: string;
    semanticSpecHash: string;
    created: string[];
    reused: string[];
  }> {
    return this.specMaterializations
      .filter((materialization) => materialization.missionId === missionId)
      .map((materialization) => ({
        approvalId: materialization.approvalId,
        semanticSpecHash: materialization.semanticSpecHash,
        created: [...materialization.created],
        reused: [...materialization.reused],
      }));
  }
}

function candidateKey(missionId: string, repoId: string): string {
  return `${missionId}\u0000${repoId}`;
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
    acceptance_criteria: mission.acceptance_criteria.map((criterion) => ({
      ...criterion,
    })),
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
    ...(task.deliverables ? { deliverables: [...task.deliverables] } : {}),
    ...(task.checkpoint_policy ? { checkpoint_policy: { ...task.checkpoint_policy } } : {}),
    ...(task.required_output_artifacts ? { required_output_artifacts: [...task.required_output_artifacts] } : {}),
    ...(task.recovery_authority ? { recovery_authority: { ...task.recovery_authority } } : {}),
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
    ...(supersession.expectedReplacementFingerprints
      ? {
          expectedReplacementFingerprints: {
            ...supersession.expectedReplacementFingerprints,
          },
        }
      : {}),
  };
}

function copyRecoveryDecision(decision: RecoveryDecision): RecoveryDecision {
  return {
    ...decision,
    ...(decision.startingCandidateContent
      ? { startingCandidateContent: { ...decision.startingCandidateContent } }
      : {}),
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

function copyEvidenceIdentity(identity: CandidateEvidenceIdentity): CandidateEvidenceIdentity {
  return {
    ...identity,
    acceptanceIds: [...identity.acceptanceIds],
    artifactHashes: [...identity.artifactHashes],
  };
}

function copyCandidateRevision(candidate: CandidateRevision): CandidateRevision {
  return { ...candidate, identity: copyEvidenceIdentity(candidate.identity) };
}

function copyValidationEvidence(evidence: ValidationEvidence): ValidationEvidence {
  return {
    ...evidence,
    identity: copyEvidenceIdentity(evidence.identity),
    testSummary: structuredClone(evidence.testSummary),
    acceptanceResults: evidence.acceptanceResults?.map((result) => ({
      ...result,
    })),
  };
}

function copyReviewEvidence(evidence: ReviewEvidence): ReviewEvidence {
  return {
    ...evidence,
    identity: copyEvidenceIdentity(evidence.identity),
    findings: evidence.findings.map((finding) => ({ ...finding })),
    acceptanceResults: evidence.acceptanceResults?.map((result) => ({
      ...result,
    })),
  };
}

function copyMissionStop(stop: MissionStop): MissionStop {
  return {
    ...stop,
    preservedWork: [...stop.preservedWork],
    attemptedRecoveries: [...stop.attemptedRecoveries],
    ...(stop.settlementIdentity ? { settlementIdentity: { ...stop.settlementIdentity } } : {}),
  };
}

function settlementIdentityMatches(actual: MissionStop["settlementIdentity"], expected: MissionRevisionFence): boolean {
  return (
    actual?.revision === expected.revision &&
    actual.status === expected.status &&
    actual.resumptionGeneration === expected.resumptionGeneration &&
    actual.blockedEpisodeId === expected.blockedEpisodeId
  );
}

function validateMissionUpdatePatch(patch: MissionUpdatePatch): MissionUpdatePatch {
  for (const key of Object.keys(patch)) {
    if (!MISSION_UPDATE_FIELDS.has(key as keyof MissionUpdatePatch)) {
      throw new Error(`unsupported mission update field ${key}`);
    }
  }
  return {
    ...(patch.constraints !== undefined ? { constraints: [...patch.constraints] } : {}),
    ...(patch.artifact_refs !== undefined ? { artifact_refs: [...patch.artifact_refs] } : {}),
    ...(patch.decision_refs !== undefined ? { decision_refs: [...patch.decision_refs] } : {}),
    ...(patch.required_gates !== undefined ? { required_gates: [...patch.required_gates] } : {}),
  };
}

function validateMissionTransitionOptions(options: MissionTransitionOptions): MissionTransitionOptions {
  for (const key of Object.keys(options)) {
    if (key !== "recoveryDecisionId") throw new Error(`unsupported mission transition option ${key}`);
  }
  if (options.recoveryDecisionId !== undefined && typeof options.recoveryDecisionId !== "string") {
    throw new Error("mission transition recoveryDecisionId must be a string");
  }
  return options.recoveryDecisionId === undefined ? {} : { recoveryDecisionId: options.recoveryDecisionId };
}

function validateTaskTransitionMetadata(metadata: TaskTransitionMetadata): TaskTransitionMetadata {
  for (const key of Object.keys(metadata)) {
    if (!TASK_TRANSITION_METADATA_FIELDS.has(key as keyof TaskTransitionMetadata)) {
      throw new Error(`unsupported task transition metadata field ${key}`);
    }
  }

  const copy: TaskTransitionMetadata = {};
  if (metadata.attempt !== undefined) {
    if (!Number.isInteger(metadata.attempt) || metadata.attempt < 0) {
      throw new Error("task transition attempt must be a non-negative integer");
    }
    copy.attempt = metadata.attempt;
  }
  if (metadata.assigned_execution_id !== undefined) {
    if (metadata.assigned_execution_id !== null && typeof metadata.assigned_execution_id !== "string") {
      throw new Error("task transition assigned_execution_id must be a string or null");
    }
    copy.assigned_execution_id = metadata.assigned_execution_id;
  }
  if (metadata.failure_reason !== undefined) {
    if (typeof metadata.failure_reason !== "string") {
      throw new Error("task transition failure_reason must be a string");
    }
    copy.failure_reason = metadata.failure_reason;
  }
  return copy;
}
