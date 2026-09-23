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
  criterion: string;
  status: "pending" | "passed" | "failed";
  /** Evidence reference when satisfied. */
  evidence?: string;
}

/** A mission: the durable unit of engineering work. */
export interface Mission {
  mission_id: EntityId;
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
}
