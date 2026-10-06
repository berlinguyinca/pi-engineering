/**
 * Planner/Worker execution mode — domain contracts.
 *
 * Engineering missions split into a cheap fast model that plans (structured
 * task contracts forming a DAG) and a strong coder model that implements each
 * contract, with the fast model reviewing. Models are NEVER named here: roles
 * resolve to models through capability requirements, deployment aliases, and
 * preferred model families, and the actual alias→model binding lives in
 * InferWeave. That is what makes the backing model of a role swappable at
 * runtime without touching this code or the Pi session.
 *
 * Responsibilities: this module owns planning, contracts, review, correction,
 * escalation, convergence, handoffs and role/model telemetry. It does not own
 * model hosting, routing, capacity or lifecycle — that is InferWeave's.
 */

/** Roles the planner/worker mode assigns. Kept small on purpose. */
export const PLANNER_WORKER_ROLES = ["planner", "implementer", "reviewer", "escalation"] as const;
export type PlannerWorkerRole = (typeof PLANNER_WORKER_ROLES)[number];

/**
 * Per-contract lifecycle. Distinct from the mission-level TaskStatus: this is
 * the contract's execution state as tracked by the planner/worker executor.
 */
export type ContractStatus =
  | "pending"
  | "ready"
  | "running"
  | "reviewing"
  | "needs_fix"
  | "blocked"
  | "passed"
  | "failed"
  | "escalated";

/** One structured task contract: the planner's output unit. */
export interface TaskContract {
  id: string;
  /** What must be true when this contract is done. */
  objective: string;
  /** Contract ids that must have passed before this one runs. */
  depends_on: string[];
  /** Write-scope paths (directories or files) the contract may touch. */
  scope: string[];
  /** Machine-checkable acceptance criteria. */
  acceptance: string[];
  /** Deterministic verification commands/checks that must pass. */
  verification: string[];
  /** Hard constraints the implementer must respect. */
  constraints: string[];
  /** Per-contract risk; drives the review plan. */
  risk: "low" | "medium" | "high";
  /** Files most relevant to the contract (bounded; not a transcript). */
  relevant_files?: string[];
}

/** Bounded mission summary handed to the planner and every worker. */
export interface MissionBrief {
  mission_id: string;
  /** One-paragraph summary of the mission (bounded). */
  summary: string;
  goal: string;
  /** Architectural context lines (bounded, verified). */
  architectural_context: string[];
  acceptance_criteria: string[];
  constraints: string[];
  repository: string;
  risk_profile: "low" | "medium" | "high" | "critical";
}

/** A model as InferWeave (or any gateway) advertises it. No hardcoded names. */
export interface CatalogModel {
  /** "provider/model-id" exactly as the gateway names it. */
  model: string;
  /** Deployment alias this model serves (e.g. "coding-implementation"). */
  alias?: string;
  /** Opaque family tag (e.g. "fast_reasoning", "code_implementation"). */
  family?: string;
  capabilities: string[];
  contextWindow: number;
  modalities: string[];
  tools: boolean;
  structuredOutput: boolean;
  healthy: boolean;
  /** Current load 0..1 reported by the gateway. */
  load: number;
  queuedJobs: number;
  /** Resident in InferWeave: switching to it is cheap (no load latency). */
  resident: boolean;
  /** Recent-failure penalty 0..1 (failure-aware switching). */
  penalty?: number;
}

/**
 * A role's model requirement: capability requirements (hard) plus
 * alias/family preferences (soft). This is the stable interface between pi
 * roles and InferWeave — never a model id.
 */
export interface RoleModelSpec {
  role: PlannerWorkerRole;
  /** Hard capability requirements. */
  requires: string[];
  /** Preferred deployment alias (soft; deployment-defined, not a model id). */
  preferred_alias?: string;
  /** Preferred model family (soft; deployment-defined). */
  preferred_family?: string;
  /** Prefer a resident (already-loaded) model when equally capable. */
  prefer_resident?: boolean;
  /** Minimum context window the handoff must fit into. */
  min_context?: number;
}

export interface RejectedCandidate {
  model: string;
  stage: "health" | "capability" | "context" | "excluded" | "denied";
  reason: string;
}

/** Full, explainable resolution decision (mirrors the capability router's shape). */
export interface RoleResolutionDecision {
  role: PlannerWorkerRole;
  selected: CatalogModel | null;
  candidates: Array<{ model: string; score: number }>;
  rejected: RejectedCandidate[];
  rationale: string[];
}

/** One issue a reviewer raises against a contract's implementation. */
export interface ReviewIssue {
  severity: "blocking" | "major" | "minor";
  summary: string;
  file?: string;
}

/** Structured review verdict: the reviewer's ONLY output shape. */
export interface ReviewVerdict {
  status: "pass" | "needs_fix" | "replan" | "escalate";
  issues: ReviewIssue[];
  required_changes: string[];
  /** The implementation violated the contract's scope/acceptance/constraints. */
  contract_violation: boolean;
  evidence?: string;
}

/**
 * A bounded correction contract: what to change next, generated from a failed
 * review. Never "fix the review comments" — a concrete, bounded re-statement.
 */
export interface CorrectionContract {
  contract_id: string;
  attempt: number;
  /** Bounded: at most MAX_CORRECTION_CHANGES entries. */
  required_changes: string[];
  /** Bounded: at most MAX_CORRECTION_ISSUES entries, blocking/major first. */
  issues: ReviewIssue[];
  /** Verification that must pass for the correction to count. */
  verification: string[];
}

export interface DependencyResult {
  contract_id: string;
  summary: string;
  changed_files: string[];
  evidence_refs: string[];
}

/**
 * The structured handoff between roles — the stable interface for passing
 * work. A planner→worker handoff carries the mission summary, architectural
 * context, the contract, dependency results and relevant files. It never
 * carries the planner's full transcript.
 */
export interface HandoffArtifact {
  kind: "planner_to_worker" | "worker_to_reviewer" | "reviewer_to_corrector" | "dependency_result";
  from_role: PlannerWorkerRole | "mission";
  to_role: PlannerWorkerRole;
  mission_summary: string;
  architectural_context: string[];
  contract: TaskContract;
  dependency_results: DependencyResult[];
  relevant_files: string[];
  correction?: CorrectionContract;
  /** Worker outcome attached for worker→reviewer handoffs. */
  worker_outcome?: { status: string; summary: string; evidence_refs: string[]; changed_files: string[] };
  /** Rough token estimate of this handoff (compatibility checks use it). */
  token_estimate: number;
}

export type CompatibilityVerdict =
  | { compatible: true; notes: string[] }
  | {
      compatible: false;
      reasons: string[];
      /** compact: the handoff can be shrunk to fit; reject: it cannot. */
      remedy: "compact" | "reject";
    };

/** Every role/model transition is an explicit, observable event. */
export interface ModelTransitionEvent {
  seq: number;
  at: string;
  from: string | null;
  to: string;
  reason: string;
  task: string;
  role: PlannerWorkerRole;
}

/** Convergence failure: the same failure keeps repeating locally. */
export interface LocalLoopStalledEvent {
  at: string;
  contract_id: string;
  attempts: number;
  failure_signature: string;
}

/** Per (role, model) accounting. */
export interface RoleModelMetrics {
  role: PlannerWorkerRole;
  model: string;
  invocations: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  tool_calls: number;
  wall_time_ms: number;
  retries: number;
  failures: number;
  escalations: number;
  findings: number;
}

/** Escalation ladder configuration (configurable repeated failures). */
export interface EscalationLadder {
  /** Failed attempts on one contract before the escalation role is used. */
  max_local_attempts: number;
  /** Failed escalation attempts before the contract is parked for a human. */
  max_escalation_attempts: number;
  /** Replans allowed for BLOCKED+evidence / contract violation. */
  max_replans: number;
}

export const DEFAULT_ESCALATION_LADDER: EscalationLadder = {
  max_local_attempts: 2,
  max_escalation_attempts: 1,
  max_replans: 2,
};

/** Contract-level state tracked by the executor. */
export interface ContractState {
  contract: TaskContract;
  status: ContractStatus;
  attempt: number;
  escalation_attempt: number;
  replans: number;
  last_model: string | null;
  correction: CorrectionContract | null;
  failure_signatures: string[];
  /** Evidence: summaries of what happened each attempt. */
  history: Array<{ at: string; status: ContractStatus; note: string }>;
  stalled?: LocalLoopStalledEvent;
  blocked_reason?: string;
}

/** The executor's full report: everything an operator or benchmark can read. */
export interface PlannerWorkerReport {
  mission_id: string;
  mode: "planner-worker";
  status: "completed" | "failed" | "escalated" | "stalled";
  contracts: ContractState[];
  transitions: ModelTransitionEvent[];
  stalled_events: LocalLoopStalledEvent[];
  metrics: RoleModelMetrics[];
  wall_time_ms: number;
  evidence_refs: string[];
  failure_reason: string | null;
}
