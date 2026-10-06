/**
 * Pi Engineering orchestration — domain contracts (spec 00 §3).
 *
 * Mission / Task / Execution are the durable units of engineering work, owned
 * by the orchestration runtime and persisted through an append-only event
 * store. These types are storage-agnostic; persistence is the MissionStore's
 * concern.
 */

/** A normalized, unique identifier. */
export type EntityId = string;

/** Canonical mission lifecycle (spec 00 §4). */
export type MissionStatus =
  | "NEW"
  | "CLASSIFYING"
  | "PLANNING"
  | "READY"
  | "QUEUED"
  | "STARTING"
  | "EXECUTING"
  | "INTEGRATING"
  | "VALIDATING"
  | "REVIEWING"
  | "REPAIRING"
  | "FINAL_VALIDATION"
  | "COMPLETE"
  | "WAITING_FOR_USER"
  // Resilience states: transient infrastructure / gateway / capacity / model
  // waits, context recovery, process recovery, and the terminal-on-exhaustion
  // pause. A mission parks in one of these instead of failing so that progress
  // is preserved and it resumes automatically when infrastructure recovers.
  | "WAITING_FOR_LLM"
  | "WAITING_FOR_CAPACITY"
  | "WAITING_FOR_GATEWAY"
  | "WAITING_FOR_MODEL"
  | "WAITING_FOR_TOOL"
  | "RECOVERING_CONTEXT"
  | "RECOVERING_PROCESS"
  | "PAUSED_INFRASTRUCTURE"
  | "NEEDS_ATTENTION"
  | "BLOCKED"
  | "CANCELING"
  | "CANCELED"
  | "FAILED";

/** Workflow classes (spec 00 §5). */
export type WorkflowClass =
  | "conversation"
  | "research"
  | "investigation"
  | "engineering"
  | "review"
  | "engineering_review"
  | "incident_fix"
  | "refactor"
  | "migration"
  | "security_sensitive";

/** Semantic intents (spec 01 §Stage A). */
export type Intent =
  | "explain"
  | "research"
  | "investigate"
  | "implement"
  | "modify"
  | "refactor"
  | "fix"
  | "review"
  | "validate"
  | "release"
  | "security-review"
  | "migrate";

/** Mandatory gates that can be required by policy (spec 00 §6). */
export type RequiredGate =
  | "validation"
  | "independent_review"
  | "security_review"
  | "migration_validation"
  | "compatibility_review"
  | "dependency_validation";

export type RiskProfile = "low" | "medium" | "high" | "critical";

/** A single acceptance criterion with a deterministic pass state. */
export interface AcceptanceCriterion {
  /** Stable identity used by task coverage and revision-bound evidence. */
  acceptance_id?: EntityId;
  criterion: string;
  status: "pending" | "passed" | "failed";
  /** Evidence reference when satisfied. */
  evidence?: string;
}

/** A mission: the durable unit of engineering work. */
export interface Mission {
  mission_id: EntityId;
  /** Replay-stable ordinal of the latest authoritative event for this mission. */
  revision: number;
  title: string;
  goal: string;
  user_request: string;
  repository: string;
  base_ref: string;
  constraints: string[];
  acceptance_criteria: AcceptanceCriterion[];
  risk_profile: RiskProfile;
  workflow_class: WorkflowClass;
  status: MissionStatus;
  created_at: string;
  updated_at: string;
  parent_session_id: string | null;
  task_ids: EntityId[];
  artifact_refs: string[];
  decision_refs: string[];
  required_gates: RequiredGate[];
  failure_reason: string | null;
  completed_at: string | null;
  /** Timestamp identifying the current/most recent durable BLOCKED episode. */
  blocked_at?: string;
  /** Unique authority token for the current/most recent durable BLOCKED episode. */
  blocked_episode_id?: EntityId;
  /**
   * The operator's explicit model choice this mission adopted (Pi `/model`),
   * honoured by every later worker dispatch over role pins and the router.
   * Absent/null: automatic routing.
   */
  operator_model_pin?: OperatorModelPin | null;
}

/** A model the operator chose explicitly for a session's missions. */
export interface OperatorModelPin {
  provider: string;
  id: string;
  /** When the operator chose it. */
  set_at: string;
}

export type TaskKind =
  | "agent"
  | "process"
  | "review"
  | "integration"
  | "validation"
  | "approval"
  | "aggregation"
  | "research";

export type TaskStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "WAITING"
  | "SUCCEEDED"
  | "FAILED"
  | "RETRYING"
  | "CANCELED"
  | "SKIPPED"
  | "BLOCKED";

export type IsolationMode = "none" | "worktree";

export type FailurePolicy = "retry" | "replan" | "repair" | "block" | "ask_user";

/** Bounded checkpoint cadence for one task execution. */
export interface TaskCheckpointPolicy {
  /** Persist after this many meaningful worker activity records. */
  activity_milestone: number;
  /** Persist this long before the execution deadline. */
  before_deadline_ms: number;
}

/** Immutable durable authority for a checkpoint-derived replacement task. */
export interface TaskRecoveryAuthority {
  recoveryDecisionId: EntityId;
  expectedReplacementFingerprint: string;
  originalTaskId: EntityId;
  originalExecutionId: EntityId;
  checkpointId: EntityId;
  supersessionId: EntityId;
  resumptionGeneration: number;
}

/** A task: one node in a mission's dependency graph. */
export interface OrchestrationTask {
  task_id: EntityId;
  mission_id: EntityId;
  kind: TaskKind;
  role: string;
  objective: string;
  depends_on: EntityId[];
  status: TaskStatus;
  priority: number;
  mutates_repo: boolean;
  write_domains: string[];
  isolation: IsolationMode;
  execution_requirements: Record<string, unknown>;
  assigned_execution_id: EntityId | null;
  artifacts: string[];
  attempt: number;
  max_attempts: number;
  failure_policy: FailurePolicy;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Steering/cancel requests applied while running. */
  steer_requests: string[];
  /** Repository-scoped execution authority. Absent on legacy events. */
  repo_id?: EntityId;
  /** Stable acceptance criteria this task is responsible for. */
  acceptance_ids?: EntityId[];
  /** Explicit bounded outputs used to split and reconcile work. */
  deliverables?: string[];
  /** Hard wall-clock budget for one execution attempt. */
  execution_budget_ms?: number;
  /** Durable checkpoint cadence. */
  checkpoint_policy?: TaskCheckpointPolicy;
  /** Artifact classes the worker must return. */
  required_output_artifacts?: string[];
  /** Candidate revision generation this task may affect. */
  candidate_generation?: number;
  /** Mission ownership generation at dispatch. */
  mission_generation?: number;
  /** Explicit mission-resumption epoch at dispatch. */
  resumption_generation?: number;
  /** Fences results from revoked or expired owners. */
  fencing_token?: number;
  /** Durable diagnostic attached by a lifecycle transition. */
  failure_reason?: string;
  /** Durable checkpoint lineage; never reconstructed from model requirements. */
  recovery_authority?: TaskRecoveryAuthority;
  /** Independently Git-verified candidate base for a fresh gate-repair worker. */
  repair_base_candidate_sha?: string;
  /** Immutable full replacement/manifest/checkpoint fingerprint for replay and dispatch. */
  replacement_spec_fingerprint?: string;
}

/** The complete allow-list of metadata a task lifecycle transition may update. */
export interface TaskTransitionMetadata {
  attempt?: number;
  assigned_execution_id?: EntityId | null;
  failure_reason?: string;
}

/** Execution backends the broker can dispatch to (spec 03). */
export type ExecutionBackend = "agent" | "process" | "review" | "integration" | "validation" | "research";

export type ExecutionStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

/** A concrete child session/subagent/subprocess (spec 00 §3 Execution). */
export interface Execution {
  execution_id: EntityId;
  task_id: EntityId;
  mission_id: EntityId;
  backend: ExecutionBackend;
  session_id: string | null;
  pid: number | null;
  worktree: string | null;
  model: string | null;
  thinking_level: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_status: string | null;
  usage: Record<string, unknown>;
  /** artifact:// refs to stdout/stderr/structured output. */
  logs: string[];
  artifact_refs: string[];
  status: ExecutionStatus;
  /**
   * Integration executions only: recovered worker commits (from a
   * wall-clock-timed-out execution) that this integration verifiably merged —
   * the exact worker ref is an ancestor of HEAD afterwards. Consumed by the
   * completion gate; absent when nothing recovered was merged.
   */
  recovered_merged?: RecoveredMerge[];
  /**
   * Review executions only: recovered tasks this review was explicitly asked
   * to check for completeness (their objective was in the review request).
   * The completion gate counts only such a review for a recovery supersede.
   */
  reviewed_recovered?: EntityId[];
  /** Mission ownership generation at dispatch. Absent on legacy events. */
  mission_generation?: number;
  /** Explicit mission-resumption epoch at dispatch. Absent on legacy events. */
  resumption_generation?: number;
  /** Fences results from revoked or expired owners. */
  fencing_token?: number;
  /** Checkpoint lineage for this bounded execution. */
  checkpoint_id?: EntityId;
  /** Immutable repository/base/candidate identity captured at execution creation. */
  repo_id?: EntityId;
  base_sha?: string;
  candidate_generation?: number;
}

/** A canonical filesystem root explicitly authorized for a mission. */
export interface AuthorizedRoot {
  canonicalPath: string;
  source: "launch_cwd" | "explicit_user_path" | "existing_manifest" | "request_repo_reference";
  access: "read" | "write";
}

/** One Git repository bound into a mission workspace. */
export interface RepositoryBinding {
  repoId: EntityId;
  canonicalRoot: string;
  remote?: string;
  baseRef: string;
  baseSha: string;
  writableDomains: string[];
  validationProfileRef?: string;
}

/** Durable authority and repository topology for a material mission. */
export interface WorkspaceManifest {
  manifestId: EntityId;
  missionId: EntityId;
  generation: number;
  authorizedRoots: AuthorizedRoot[];
  repositories: RepositoryBinding[];
  dependencyEdges: Array<{ fromRepoId: EntityId; toRepoId: EntityId }>;
  hash: string;
  createdAt: string;
}

/** Preserved task work. A checkpoint is not validation or approval evidence. */
export interface TaskCheckpoint {
  checkpointId: EntityId;
  executionId: EntityId;
  missionId: EntityId;
  taskId: EntityId;
  repoId: EntityId;
  baseSha: string;
  candidateSha: string | null;
  branch: string | null;
  worktree: string | null;
  committedChanges: string[];
  preservedUncommittedChanges: string[];
  completedDeliverables: string[];
  remainingDeliverables: string[];
  acceptanceIds: EntityId[];
  validationEvidenceRefs: string[];
  artifactRefs: string[];
  artifactHashes: string[];
  workerId: string | null;
  sessionId: string | null;
  model: string | null;
  sequence: number;
  missionGeneration: number;
  candidateGeneration: number;
  fencingToken: number;
  createdAt: string;
}

/** Explicit lineage that accounts for an immutable failed task. */
export interface TaskSupersession {
  supersessionId: EntityId;
  missionId: EntityId;
  failedTaskId: EntityId;
  replacementTaskIds: EntityId[];
  repoId: EntityId;
  acceptanceIds: EntityId[];
  /** Immutable hash of the failed task's objective, deliverables, and repository coverage. */
  coverageFingerprint?: string;
  reason: string;
  createdAt: string;
  recoveryDecisionId?: EntityId;
  expectedReplacementFingerprints?: Record<EntityId, string>;
}

export interface AcceptanceEvidenceResult {
  acceptanceId: EntityId;
  status: "passed" | "failed";
  detail: string;
}

/** Identity shared by validation, review, and invalidation records. */
export interface CandidateEvidenceIdentity {
  workspaceManifestHash: string;
  missionGeneration: number;
  repoId: EntityId;
  baseSha: string;
  candidateSha: string;
  diffHash: string;
  acceptanceIds: EntityId[];
  artifactHashes: string[];
}

/** The independently persisted revision that gate evidence must match exactly. */
export interface CandidateRevision {
  missionId: EntityId;
  taskId: EntityId;
  executionId: EntityId;
  identity: CandidateEvidenceIdentity;
  identityHash: string;
  reason: string;
  recordedAt: string;
}

export interface ValidationEvidence {
  evidenceId: EntityId;
  missionId: EntityId;
  taskId: EntityId;
  executionId: EntityId;
  identity: CandidateEvidenceIdentity;
  identityHash: string;
  command: string;
  profile: string;
  exitCode: number;
  testSummary: Record<string, unknown>;
  noTargets: boolean;
  accessible: boolean;
  acceptanceResults?: AcceptanceEvidenceResult[];
  recordedAt: string;
}

export type ReviewVerdict = "approve" | "request_changes";
export type ReviewIndependenceMode = "independent" | "same_model_reduced";

export interface ReviewEvidence {
  evidenceId: EntityId;
  missionId: EntityId;
  taskId: EntityId;
  executionId: EntityId;
  identity: CandidateEvidenceIdentity;
  identityHash: string;
  reviewerSessionId: string;
  model: string;
  provider: string;
  verdict: ReviewVerdict;
  independenceMode: ReviewIndependenceMode;
  findings: Array<Pick<ReviewFinding, "severity" | "summary" | "status">>;
  outputValid: boolean;
  accessible: boolean;
  acceptanceResults?: AcceptanceEvidenceResult[];
  recordedAt: string;
}

export type FailureCategory =
  | "WORKSPACE_SCOPE_MISMATCH"
  | "EVIDENCE_UNAVAILABLE"
  | "TASK_BUDGET_EXHAUSTED"
  | "PROVIDER_TRANSIENT"
  | "PROVIDER_PERMANENT"
  | "INVALID_WORKER_OUTPUT"
  | "VALIDATION_FAILED"
  | "REVIEW_FAILED"
  | "IMPLEMENTATION_DEFECT"
  | "MERGE_CONFLICT"
  | "AUTHORIZATION_OR_CREDENTIAL"
  | "REQUIREMENT_AMBIGUITY"
  | "ORPHANED_EXECUTION"
  | "DEADLOCKED_DAG"
  | "PERSISTENCE_FAILURE";

/** Stable, machine-readable diagnosis of one failure. */
export interface FailureClassification {
  classificationId: EntityId;
  missionId: EntityId;
  taskId: EntityId | null;
  executionId: EntityId | null;
  category: FailureCategory;
  evidenceRefs: string[];
  fingerprint: string;
  summary: string;
  classifiedAt: string;
  /** Durable BLOCKED episode this failure belongs to when one already exists. */
  blockerEpisodeId?: EntityId;
}

export type RecoveryAction =
  | "REBUILD_WORKSPACE_MANIFEST"
  | "RECONSTRUCT_EVIDENCE"
  | "CHECKPOINT_SPLIT_AND_REPLACE"
  | "PROBE_AND_BACKOFF"
  | "REPAIR_WORKER_OUTPUT"
  | "CREATE_REPAIR_TASKS"
  | "REBUILD_INTEGRATION_CANDIDATE"
  | "FENCE_RECONCILE_AND_RESUME"
  | "WAIT_FOR_REQUIREMENT"
  | "PAUSE_FOR_PERSISTENCE"
  | "REPAIR_BLOCKED_MISSION"
  | "STOP";

export type RecoveryStatus = "planned" | "started" | "succeeded" | "failed" | "exhausted";

/** Bounded recovery choice whose budget and schedule survive restart. */
export interface RecoveryDecision {
  recoveryId: EntityId;
  missionId: EntityId;
  classificationId: EntityId;
  action: RecoveryAction;
  expectedMaterialChange: string;
  attempt: number;
  maxAttempts: number;
  /** Opt-in recovery deadline; null when recovery has no time limit (the default). */
  deadline: string | null;
  nextActionAt: string;
  status: RecoveryStatus;
  decidedAt: string;
  /** Stable classifier fingerprint used for restart-safe strategy accounting. */
  failureFingerprint?: string;
  /** Durable identity of the BLOCKED episode this repair decision may consume. */
  blockedEpisodeId?: EntityId;
  /** Explicit operator resumption epoch; restart alone never increments it. */
  resumptionGeneration?: number;
  /** Candidate evidence baseline that a mutating repair must durably supersede. */
  startingCandidateIdentityHash?: string | null;
  /** Git content baseline; metadata/artifact changes do not satisfy mutation recovery. */
  startingCandidateContent?: { candidateSha: string; diffHash: string } | null;
}

export interface EvidenceInvalidation {
  invalidationId: EntityId;
  missionId: EntityId;
  identity: CandidateEvidenceIdentity;
  reason: string;
  invalidatedAt: string;
  /** Omitted legacy records invalidate every evidence class for the identity. */
  scope?: "all" | "validation" | "review";
}

export interface MissionLease {
  missionId: EntityId;
  generation: number;
  ownerId: string;
  acquiredAt: string;
  renewBy: string;
  fencingToken: number;
  /** Explicit resumption epoch this lease may dispatch for. */
  resumptionGeneration?: number;
}

export interface RepositoryLease extends MissionLease {
  repoId: EntityId;
}

export type LeaseTransition = "acquired" | "renewed" | "expired" | "fenced";

export interface MissionResumption {
  missionId: EntityId;
  reason: string;
  resumedAt: string;
  generation: number;
  stopGeneration: number;
}

export interface MissionStop {
  missionId: EntityId;
  reason: string;
  preservedWork: string[];
  attemptedRecoveries: EntityId[];
  resumeCondition: string;
  stoppedAt: string;
  generation: number;
  resumptionGeneration: number;
  blockedEpisodeId: EntityId | null;
  recoveryDeadline: string | null;
  /** Exact durable mission snapshot consumed by an atomic settlement. */
  settlementIdentity?: {
    revision: number;
    status: MissionStatus;
    resumptionGeneration: number;
    blockedEpisodeId: EntityId | null;
  };
}

/** A recovered worker commit merged by integration. */
export interface RecoveredMerge {
  task_id: EntityId;
  branch: string;
  ref: string;
}

/** Result of the semantic + policy router (spec 01). */
export interface IntentResult {
  intent: Intent[];
  confidence: number;
  suggested_workflow: WorkflowClass;
  risk_hints: string[];
  needs_scout: boolean;
  /** True when deterministic policy upgraded the workflow from the semantic guess. */
  escalated: boolean;
  reasons: string[];
}

/** Structured reviewer finding (spec 07). */
export interface ReviewFinding {
  finding_id: string;
  mission_id: EntityId;
  task_id: EntityId | null;
  severity: "blocking" | "major" | "minor";
  category: string;
  file: string | null;
  line: number | null;
  summary: string;
  evidence: string | null;
  recommended_action: string;
  status: "open" | "accepted" | "resolved";
  created_at: string;
}

/** Deterministic completion gate verdict (spec 07). */
export interface CompletionVerdict {
  can_complete: boolean;
  reasons: string[];
  missing_gates: RequiredGate[];
  unresolved_findings: number;
  running_tasks: number;
  /**
   * FAILED tasks that no longer block because their committed work was
   * recovered, merged, validated and completeness-reviewed. Reported so a
   * completion over a FAILED task is auditable.
   */
  superseded_by_recovery?: string[];
}
