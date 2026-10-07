/**
 * Planner/Worker execution mode — domain contracts.
 *
 * Engineering missions split cognitive roles across models: a planner turns the
 * mission into structured task contracts forming a DAG, implementers carry out
 * each contract in an isolated worktree, and a reviewer judges each result.
 * Models are NEVER named here: roles resolve to models through capability
 * requirements, deployment aliases and preferred model families, and the actual
 * alias→model binding lives in the gateway (InferWeave). That is what makes the
 * backing model of a role swappable at any inference boundary without touching
 * this code or the Pi session.
 *
 * This module owns planning, contracts, review, correction, escalation,
 * convergence, handoffs and role/model telemetry. It does not own model hosting,
 * routing, capacity or lifecycle — that belongs to the gateway.
 */

/** Execution modes selectable with `/engineering-mode`. */
export const ENGINEERING_MODES = ["auto", "planner-worker", "single"] as const;
export type EngineeringMode = (typeof ENGINEERING_MODES)[number];

/** Cognitive roles the planner/worker mode assigns. */
export const PLANNER_WORKER_ROLES = [
  "planner",
  "researcher",
  "implementer",
  "reviewer",
  "debugger",
  "fixer",
  "escalation",
] as const;
export type PlannerWorkerRole = (typeof PLANNER_WORKER_ROLES)[number];

export type ContractRisk = "low" | "medium" | "high";

/** Per-contract lifecycle (spec §4). */
export const CONTRACT_STATUSES = [
  "pending",
  "ready",
  "running",
  "reviewing",
  "needs_fix",
  "blocked",
  "passed",
  "failed",
  "escalated",
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Write scope of a contract: repository-relative globs. */
export interface ContractScope {
  allowed: string[];
  forbidden: string[];
}

/** One structured task contract: the planner's output unit (spec §3). */
export interface TaskContract {
  task_id: string;
  /** What must be true when this contract is done. */
  objective: string;
  /** Contract ids that must have passed before this one runs. */
  depends_on: string[];
  scope: ContractScope;
  /** Checkable acceptance criteria. */
  acceptance: string[];
  /** Deterministic verification commands that must exit 0. */
  verification: string[];
  /** Hard constraints the implementer must respect. */
  constraints: string[];
  /** Drives review frequency (spec §20). */
  risk: ContractRisk;
  /** Files most relevant to the contract (bounded; never a transcript). */
  relevant_files: string[];
  /** Planner decisions the implementer must follow (bounded). */
  decisions: string[];
}

/** Bounded mission summary handed to the planner and every worker. */
export interface MissionBrief {
  mission_id: string;
  /** One-paragraph summary of the mission (bounded). */
  summary: string;
  /** Architectural context lines (bounded, verified). */
  architectural_context: string[];
  acceptance_criteria: string[];
  constraints: string[];
}

/** The planner's structured output. */
export interface PlannerOutput {
  contracts: TaskContract[];
  /** Mission-wide decisions every handoff carries. */
  decisions: string[];
  architectural_context: string[];
}

/** One issue a reviewer raises against an implementation. */
export interface ReviewIssue {
  severity: "blocking" | "major" | "minor";
  summary: string;
  file?: string;
}

export type ReviewStatus = "pass" | "needs_fix" | "replan" | "escalate";

/** Structured review verdict: the reviewer's ONLY output shape (spec §5). */
export interface ReviewVerdict {
  status: ReviewStatus;
  issues: ReviewIssue[];
  required_changes: string[];
  /** The implementation violated the contract's scope/acceptance/constraints. */
  contract_violation: boolean;
}

/**
 * A bounded correction contract generated from a failed review or failed
 * verification (spec §6). Never "fix the review comments".
 */
export interface CorrectionContract {
  task_id: string;
  attempt: number;
  objective: string;
  required_changes: string[];
  issues: ReviewIssue[];
  verification: string[];
  /** Scope is inherited and may only narrow, never widen. */
  scope: ContractScope;
}

/** What a finished dependency hands to its dependents (no transcripts). */
export interface DependencyResult {
  task_id: string;
  summary: string;
  changed_files: string[];
}

export type HandoffKind = "planner_to_worker" | "worker_to_reviewer" | "reviewer_to_fixer" | "to_escalation";

/**
 * The compact handoff between roles (spec §18) — the stable interface between
 * agents. It never carries the planner's reasoning transcript.
 */
export interface HandoffArtifact {
  kind: HandoffKind;
  mission_id: string;
  task_id: string;
  from_role: PlannerWorkerRole;
  to_role: PlannerWorkerRole;
  mission_summary: string;
  architectural_context: string[];
  objective: string;
  relevant_files: string[];
  decisions: string[];
  constraints: string[];
  acceptance: string[];
  verification: string[];
  scope: ContractScope;
  dependency_results: DependencyResult[];
  correction?: CorrectionContract;
  /** Worker outcome attached for worker→reviewer handoffs. */
  worker_outcome?: { summary: string; changed_files: string[]; diff: string; verification: VerificationRun[] };
  /** Rough token estimate (chars/4) used by the compatibility check. */
  token_estimate: number;
}

/** One verification command run. */
export interface VerificationRun {
  command: string;
  exit_code: number;
  passed: boolean;
  /** Bounded tail of the combined output. */
  output_tail: string;
  duration_ms: number;
}

/** Escalation ladder configuration (spec §8). */
export interface EscalationLadder {
  /** Implementation attempts by the local implementer before diagnosis. */
  max_local_attempts: number;
  /** Local retries after a debugger diagnosis before frontier escalation. */
  max_diagnosed_attempts: number;
  /** Escalation-model attempts before the contract fails. */
  max_escalation_attempts: number;
  /** Replans allowed per mission (BLOCKED+evidence / replan verdicts). */
  max_replans: number;
}

export const DEFAULT_ESCALATION_LADDER: EscalationLadder = {
  max_local_attempts: 2,
  max_diagnosed_attempts: 1,
  max_escalation_attempts: 1,
  max_replans: 2,
};

/** Convergence configuration (spec §21). */
export interface ConvergenceConfig {
  /** Attempts with no measurable progress before LOCAL_LOOP_STALLED. */
  stall_after: number;
}

export const DEFAULT_CONVERGENCE: ConvergenceConfig = { stall_after: 2 };

/** Every role/model transition is an explicit, observable event (spec §12). */
export interface ModelTransitionEvent {
  type: "MODEL_TRANSITION";
  seq: number;
  at: string;
  from: string | null;
  to: string;
  reason: string;
  task: string;
  role: PlannerWorkerRole;
  /** How the context crossed the boundary (spec §17). */
  context: "handoff" | "compact" | "direct";
}

/** Convergence failure (spec §21). */
export interface LocalLoopStalledEvent {
  type: "LOCAL_LOOP_STALLED";
  at: string;
  task_id: string;
  attempts: number;
  reasons: string[];
}

/** Per (role, model) accounting (spec §22). */
export interface RoleModelMetrics {
  role: PlannerWorkerRole;
  model: string;
  invocations: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  wall_time_ms: number;
  tool_calls: number;
  retries: number;
  failures: number;
  review_failures: number;
  accepted_tasks: number;
  rejected_tasks: number;
  escalations: number;
}

/** Contract-level state tracked by the executor. */
export interface ContractState {
  contract: TaskContract;
  status: ContractStatus;
  /** Implementation attempts so far (all models). */
  attempt: number;
  /** Which ladder rung the contract is on. */
  rung: "local" | "diagnosed" | "escalated";
  last_model: string | null;
  correction: CorrectionContract | null;
  changed_files: string[];
  summary: string;
  worktree: string | null;
  history: Array<{ at: string; from: ContractStatus; to: ContractStatus; note: string }>;
  stalled?: LocalLoopStalledEvent;
  blocked_reason?: string;
}

export type PlannerWorkerOutcome = "completed" | "failed" | "escalated" | "stalled" | "rejected";

/** The executor's full report: everything an operator or benchmark reads. */
export interface PlannerWorkerReport {
  mission_id: string;
  mode: "planner-worker";
  status: PlannerWorkerOutcome;
  contracts: ContractState[];
  transitions: ModelTransitionEvent[];
  stalled_events: LocalLoopStalledEvent[];
  metrics: RoleModelMetrics[];
  replans: number;
  wall_time_ms: number;
  failure_reason: string | null;
}
