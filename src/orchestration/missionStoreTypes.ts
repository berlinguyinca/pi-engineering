/**
 * MissionStore event/record types, constants and replay helpers (moved verbatim
 * out of missionStore.ts; the public names are re-exported from there).
 */

import type { GithubLinkPatch, GithubLinkRecord } from "../github/types.ts";
import type { StoredEvent } from "../platform/eventstore/backend.ts";
import type { CanonicalLifecycleState } from "./canonicalLifecycle.ts";
import type {
  CandidateEvidenceIdentity,
  Execution,
  FailureCategory,
  Mission,
  MissionStatus,
  OrchestrationTask,
  RecoveryStatus,
  ReviewEvidence,
  TaskStatus,
  TaskTransitionMetadata,
  ValidationEvidence,
} from "./types.ts";

export interface DagProjection {
  missionId: string;
  /** Task node ids, dependency edges `[from, to]` and issue links `[task, issue]` as last projected. */
  tasks: string[];
  dependencies: Array<[string, string]>;
  issueLinks: Array<[string, string]>;
}

export function applyGithubLinkPatch(link: GithubLinkRecord, patch: GithubLinkPatch): GithubLinkRecord {
  return {
    ...link,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notFoundCount !== undefined ? { notFoundCount: patch.notFoundCount } : {}),
    ...(patch.epoch !== undefined ? { epoch: patch.epoch } : {}),
    observed: { ...link.observed, ...(patch.observed ?? {}) },
  };
}

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
  | "handoff.created"
  | "handoff.transitioned"
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
  | "github.link_recorded"
  | "github.link_suggested"
  | "github.suggestion_resolved"
  | "github.link_corrected"
  | "github.evidence_stale"
  | "github.rereview_requested"
  | "github.gate_decided"
  | "dag.projected"
  | "candidate.changed"
  | "evidence.validation_recorded"
  | "evidence.review_recorded"
  | "execution.gate_evidence_published"
  | "mission.resumed"
  | "mission.stopped"
  | "mission.disk_suspend_marked"
  | "mission.disk_suspend_resolved"
  | "spec.stage"
  | "spec.revision"
  | "spec.review"
  | "spec.approval"
  | "spec.invalidation"
  | "spec.materialized"
  | "plan.revision"
  | "plan.policy"
  | "plan.decision"
  | "lane.acquired"
  | "lane.released"
  | "lane.wait"
  | "lane.stale_taken"
  | "lane.index_corrupt"
  | "repository.wait"
  | "repository.wait_cleared";

export interface RepositoryWait {
  missionId: string;
  repoId: string;
  holderMissionId: string;
  holderOwnerId: string;
}

export const LEGACY_AUTHORITY_LOSS =
  /stale (?:mission|repository) (?:fencing|resumption)|lease expired|lease renewal failed|custody of another live session/;

export const ORCHESTRATION_EVENT_TYPES: ReadonlySet<string> = new Set<OrchestrationEventType>([
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
  "handoff.created",
  "handoff.transitioned",
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
  "github.link_recorded",
  "github.link_suggested",
  "github.suggestion_resolved",
  "github.link_corrected",
  "github.evidence_stale",
  "github.rereview_requested",
  "github.gate_decided",
  "dag.projected",
  "candidate.changed",
  "evidence.validation_recorded",
  "evidence.review_recorded",
  "execution.gate_evidence_published",
  "mission.resumed",
  "mission.stopped",
  "mission.disk_suspend_marked",
  "mission.disk_suspend_resolved",
  "spec.stage",
  "spec.revision",
  "spec.review",
  "spec.approval",
  "spec.invalidation",
  "spec.materialized",
  "plan.revision",
  "plan.policy",
  "plan.decision",
  "lane.acquired",
  "lane.released",
  "lane.wait",
  "lane.stale_taken",
  "lane.index_corrupt",
  "repository.wait",
  "repository.wait_cleared",
  "lane.acquired",
  "lane.released",
  "lane.wait",
  "lane.stale_taken",
  "lane.index_corrupt",
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
  Pick<
    Mission,
    | "constraints"
    | "artifact_refs"
    | "decision_refs"
    | "required_gates"
    | "operator_model_pin"
    | "operator_model_decided_at"
    | "operator_paused_at"
    | "execution_mode"
  >
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
  /**
   * P4 provenance: the model that actually served the gate run. Gate executions
   * (review/integration/validation) settle through this publication rather than
   * the setExecutionStatus path, so the serving model must flow through here to
   * reach the execution record's `model` field (what /mission-status reads).
   */
  model?: string;
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

export const MAX_PERSISTENCE_DIAGNOSTICS = 50;
export const MISSION_UPDATE_FIELDS = new Set<keyof MissionUpdatePatch>([
  "constraints",
  "artifact_refs",
  "decision_refs",
  "required_gates",
  "operator_model_pin",
  "operator_paused_at",
  "operator_model_decided_at",
  "execution_mode",
]);
export const TASK_TRANSITION_METADATA_FIELDS = new Set<keyof TaskTransitionMetadata>([
  "attempt",
  "assigned_execution_id",
  "failure_reason",
]);
export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["SUCCEEDED", "FAILED", "CANCELED", "SKIPPED"]);

/**
 * (#416) Transient/interruption categories that a concurrent disk-pressure
 * suspend explains for a task that was RUNNING at suspend time. Genuine
 * defects — validation, review, merge, authorization, scope, requirement,
 * deadlock — are deliberately absent: a disk outage never excuses them.
 */
export const DISK_SUSPENDED_EXCUSABLE: ReadonlySet<FailureCategory> = new Set([
  "PROVIDER_TRANSIENT",
  "PROVIDER_PERMANENT",
  "TASK_BUDGET_EXHAUSTED",
  "ORPHANED_EXECUTION",
  "INVALID_WORKER_OUTPUT",
  "PERSISTENCE_FAILURE",
  "EVIDENCE_UNAVAILABLE",
]);
export const RECOVERY_TRANSITIONS: Record<RecoveryStatus, ReadonlyArray<RecoveryStatus>> = {
  planned: ["started", "failed", "exhausted"],
  started: ["succeeded", "failed", "exhausted"],
  succeeded: [],
  failed: [],
  exhausted: [],
};

export function persistenceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown persistence error";
}

/** Maps a platform StoredEvent back to an orchestration event. */
export function fromStored(e: StoredEvent): OrchestrationEvent {
  return {
    event_id: e.event_id,
    mission_id: (e.payload.mission_id as string) ?? e.run_id ?? "",
    timestamp: e.timestamp,
    type: e.type as OrchestrationEventType,
    actor: (e.payload.actor as OrchestrationEvent["actor"]) ?? "system",
    payload: e.payload,
  };
}

/** A mission's canonical lifecycle state and the projection version that produced it. */
export interface CanonicalLifecycle {
  canonicalState: CanonicalLifecycleState;
  lifecycleSchemaVersion: number;
}

export interface CanonicalLifecycleRecord extends CanonicalLifecycle {
  /** The `MissionStatus` this record was written for; a later status makes it stale. */
  status: MissionStatus;
}

/** Thrown by `MissionStore.addHandoffRecord` when a handoff record fails validation. */
export class HandoffRecordError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`invalid handoff record: ${errors.join("; ")}`);
    this.name = "HandoffRecordError";
    this.errors = errors;
  }
}
