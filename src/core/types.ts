/**
 * Core domain types for the Pi Engineering runtime.
 *
 * These types are the contract between the ledger, the worker runtime, the
 * context broker, verification, and the workflows. They are deliberately
 * storage-agnostic: persistence is the ledger's concern, not the domain model's.
 *
 * The design follows `docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md`.
 */

export type EventType =
  | "work_item.created"
  | "work_item.updated"
  | "plan.created"
  | "task.created"
  | "task.ready"
  | "task.started"
  | "task.completed"
  | "task.blocked"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "candidate.created"
  | "candidate.changed"
  | "candidate.rejected"
  | "candidate.promoted"
  | "hypothesis.created"
  | "hypothesis.rejected"
  | "fact.verified"
  | "decision.proposed"
  | "decision.accepted"
  | "finding.created"
  | "finding.resolved"
  | "entity.updated"
  | "evidence.recorded"
  | "verification.started"
  | "verification.completed"
  | "review.started"
  | "review.completed"
  | "requirement.created"
  | "invariant.created"
  | "test-obligation.created"
  | "artifact.created"
  | "budget.warning"
  | "budget.exhausted"
  | "merge.requested"
  | "merge.completed"
  | "context.package.assembled";

export interface LedgerEvent {
  event_id: string;
  work_item_id: string | null;
  timestamp: string;
  actor: Actor;
  type: EventType;
  payload: Record<string, unknown>;
}

export type ActorType = "agent" | "user" | "system";

/**
 * True only for machine-generated evidence references (stored artifacts,
 * recorded evidence, test runs). Agent-authored text like "symbol://x" or a
 * free-form note is NOT machine evidence, so claims citing it stay hypotheses
 * (INV-006: hypotheses must never be silently promoted to facts).
 */
export function isMachineEvidence(ref: string | undefined | null): boolean {
  if (!ref) return false;
  return ref.startsWith("artifact://") || ref.startsWith("test-run://") || /^EVID-/i.test(ref);
}

export interface Actor {
  type: ActorType;
  run_id?: string;
  role?: WorkerRole;
  model?: string;
}

/** Worker roles defined by the spec. */
export type WorkerRole =
  | "planner"
  | "scout"
  | "implementer"
  | "debugger"
  | "test-designer"
  | "test-generator"
  | "reviewer"
  | "architecture-reviewer"
  | "security-review"
  | "performance-review"
  | "clean-room-challenger"
  | "summarizer";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type WorkItemStatus =
  | "DEFINED"
  | "PLANNING"
  | "READY"
  | "EXECUTING"
  | "VERIFYING"
  | "REVIEWING"
  | "INTEGRATING"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED"
  | "NEEDS_HUMAN"
  | "BUDGET_EXHAUSTED";

export interface WorkItem {
  id: string;
  goal: string;
  status: WorkItemStatus;
  risk: RiskLevel;
  repositories: string[];
  created_at: string;
  updated_at: string;
  current_candidate_id: string | null;
  incumbent_candidate_id: string | null;
}

export type CandidateStatus =
  | "CREATED"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "ELIGIBLE"
  | "REVIEWING"
  | "PROMOTED"
  | "REJECTED";

export interface Candidate {
  id: string;
  work_item_id: string;
  parent_id: string | null;
  status: CandidateStatus;
  base_commit: string;
  branch: string;
  worktree_path: string | null;
  producer_run_id: string | null;
  producer_role: WorkerRole;
  diff: string | null;
  changed_files: string[];
  evidence_ids: string[];
  rejection_reason: string | null;
  created_at: string;
}

export type TaskKind = "implementation" | "investigation" | "test" | "review";

export interface Task {
  id: string;
  work_item_id: string;
  title: string;
  kind: TaskKind;
  depends_on: string[];
  status: "ready" | "started" | "completed" | "blocked" | "proposed";
  scope_paths: string[];
  risk: RiskLevel;
}

export type EvidenceTrust = "authoritative" | "deterministic" | "observed" | "reviewed" | "unverified";

export interface Evidence {
  id: string;
  candidate_id: string | null;
  type: string;
  tool: string;
  command: string | null;
  started_at: string;
  finished_at: string;
  exit_code: number;
  status: "passed" | "failed" | "error";
  summary: Record<string, unknown>;
  artifacts: string[];
  trust: EvidenceTrust;
}

export interface ArtifactMeta {
  id: string;
  category: string;
  uri: string;
  size: number;
  created_at: string;
  summary: string;
}

export type EntityStatus = "open" | "verified" | "rejected" | "resolved" | "accepted" | "implemented";

export interface LedgerEntity {
  id: string;
  kind:
    | "requirement"
    | "invariant"
    | "fact"
    | "hypothesis"
    | "decision"
    | "finding"
    | "test-obligation";
  claim: string;
  status: EntityStatus;
  evidence: string[];
  confidence?: number;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  candidate_id?: string;
  work_item_id?: string;
  created_at: string;
}

/** Bounded, structured result produced by a delegated worker (INV worker output contract). */
export interface Claim {
  claim: string;
  evidence: string;
}

export interface WorkerResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  claims: Claim[];
  evidence_refs: string[];
  new_hypotheses: string[];
  proposed_tasks: string[];
  /** Role-specific payload (e.g. candidate_id for implementers). */
  details: Record<string, unknown>;
  error?: string;
}

/** Aggregate context/autonomy telemetry for a workflow run (spec §41). */
export interface Telemetry {
  /** Worker invocations per role. */
  workers: Partial<Record<WorkerRole, number>>;
  /** Total tool executions across all worker sessions. */
  toolCalls: number;
  /** Verification stages executed. */
  verifyStages: number;
  /** Evidence records created. */
  evidence: number;
  /** Worker invocations that returned blocked/failed (proxy for needing help). */
  blockedOrFailedWorkers: number;
  /** Aggregate worker token usage. */
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  turns: number;
}

/** Token/usage accounting for a single worker invocation. */
export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
  model: string;
}

export interface TokenBudget {
  role: WorkerRole;
  targetTokens: number;
  hardMaxTokens: number;
}

/** Role budget table from spec §10.6. */
export const ROLE_BUDGETS: Record<WorkerRole, TokenBudget> = {
  planner: { role: "planner", targetTokens: 12000, hardMaxTokens: 32000 },
  scout: { role: "scout", targetTokens: 10000, hardMaxTokens: 24000 },
  implementer: { role: "implementer", targetTokens: 16000, hardMaxTokens: 40000 },
  debugger: { role: "debugger", targetTokens: 18000, hardMaxTokens: 48000 },
  "test-designer": { role: "test-designer", targetTokens: 10000, hardMaxTokens: 24000 },
  "test-generator": { role: "test-generator", targetTokens: 10000, hardMaxTokens: 24000 },
  reviewer: { role: "reviewer", targetTokens: 10000, hardMaxTokens: 24000 },
  "architecture-reviewer": { role: "architecture-reviewer", targetTokens: 16000, hardMaxTokens: 40000 },
  "security-review": { role: "security-review", targetTokens: 10000, hardMaxTokens: 24000 },
  "performance-review": { role: "performance-review", targetTokens: 10000, hardMaxTokens: 24000 },
  "clean-room-challenger": { role: "clean-room-challenger", targetTokens: 12000, hardMaxTokens: 32000 },
  summarizer: { role: "summarizer", targetTokens: 4000, hardMaxTokens: 8000 },
};
