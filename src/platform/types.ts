/**
 * Pi Engineering Platform — shared domain contracts.
 *
 * The canonical runtime model from MASTER_SPEC:
 *   Workspace -> Project -> Repository -> Work Item -> Run -> Task graph -> Worker.
 *
 * This module is pi-engineering-owned domain state that is NOT supplied
 * upstream: the single-project `src/ledger` models work items/candidates/tasks
 * but has no Workspace/Project/Repository registry, no persisted Run entity and
 * no distinct Worker entity with lifecycle/heartbeat. These contracts are
 * deliberately storage-agnostic (persistence is an EventStore concern) and
 * deliberately decoupled from the external tools they integrate with.
 */

/** A normalized, unique identifier for a platform entity. */
export type EntityId = string;

/** A named collection of projects (the top of the canonical model). */
export interface Workspace {
  id: EntityId;
  name: string;
  /** Projects are referenced by id; the registry owns the graph. */
  projectIds: EntityId[];
  created_at: string;
}

/** A project: one logical engineering unit, possibly spanning many repositories. */
export interface Project {
  id: EntityId;
  name: string;
  /**
   * Canonical git remote for the project. Normalizing worktrees to a single
   * remote keeps a multi-worktree project one project (spec 02 / multi-project UI).
   */
  canonicalRemote: string | null;
  /** True when the project spans several repositories. */
  multiRepo: boolean;
  repositoryIds: EntityId[];
  /** Risk class governing policy-based approval (Plannotator "policy" mode). */
  riskClass: RiskClass;
  created_at: string;
}

/** A single checkout / worktree of a repository belonging to a project. */
export interface Repository {
  id: EntityId;
  projectId: EntityId;
  /** Filesystem root of the checkout. */
  root: string;
  remote: string | null;
  /** Worktree roots used by concurrent mutators, kept for isolation accounting. */
  worktreeRoots: string[];
  created_at: string;
}

/** Risk classes used by the approval gate. */
export type RiskClass = "low" | "medium" | "high" | "critical";

export type RunStatus = "PENDING" | "PLANNING" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";

/**
 * A run: one invocation of the engineering pipeline against a project.
 * Child runs (delegated to a worker) reference their parent so the persisted
 * Run graph is complete and reconstructable from events.
 */
export interface Run {
  id: EntityId;
  projectId: EntityId;
  workItemId: string | null;
  goal: string;
  status: RunStatus;
  parentRunId: EntityId | null;
  started_at: string;
  finished_at: string | null;
  /** Human intervention / approval decision for this run (Plannotator correlation). */
  approval: ApprovalRecord | null;
}

/** Plannotator approval outcome correlated to a run/plan. */
export interface ApprovalRecord {
  mode: "interactive" | "autonomous" | "policy" | "disabled" | "not_required";
  decision: "approved" | "rejected" | "annotated" | "bypassed" | "none";
  /** External Plannotator decision id when the external tool was consulted. */
  externalDecisionId: string | null;
  /** Reference to the persisted plan artifact. */
  planRef: string | null;
  /** Human/operator who approved, when known. */
  approvedBy: string | null;
  /** Policy reason for autonomous bypass or policy-mode invocation. */
  reason: string | null;
  annotations: string[];
  decided_at: string;
}

export type WorkerStatus =
  | "IDLE"
  | "BOOTSTRAPPING"
  | "RUNNING"
  | "BLOCKED"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "RECOVERING";

/** Resource ceilings applied to a worker. */
export interface WorkerLimits {
  maxTokens: number;
  maxAttempts: number;
  timeoutMs: number;
  maxTools: number;
}

/**
 * A worker: an addressable child execution unit. One Worker contract is shared
 * by local and remote workers (spec 12). Every worker carries IDs, lifecycle,
 * heartbeat, events, budgets and cancel/restart semantics.
 */
export interface Worker {
  id: EntityId;
  runId: EntityId | null;
  projectId: EntityId;
  role: string;
  status: WorkerStatus;
  model: string | null;
  worktree: string | null;
  parentWorkerId: EntityId | null;
  limits: WorkerLimits;
  /** Location is a placement attribute, never a second orchestration API (spec 12). */
  location: { host: string; remote: boolean };
  created_at: string;
  updated_at: string;
  heartbeat_at: string | null;
  /** Increments on each (re)start; idempotent commands key off this. */
  generation: number;
}

/** Platform event types, versioned alongside the domain. */
export type PlatformEventType =
  | "platform.workspace.created"
  | "platform.project.created"
  | "platform.project.updated"
  | "platform.repository.registered"
  | "platform.worktree.added"
  | "platform.run.created"
  | "platform.run.started"
  | "platform.run.status"
  | "platform.run.approval"
  | "platform.run.completed"
  | "platform.worker.created"
  | "platform.worker.heartbeat"
  | "platform.worker.status"
  | "platform.worker.restarted"
  | "platform.worker.cancelled"
  | "platform.worker.completed";

/** A platform event, shaped like the ledger's events for one event model. */
export interface PlatformEvent {
  event_id: EntityId;
  /** Canonical project scope of the event (null for workspace-level events). */
  project_id: EntityId | null;
  run_id: EntityId | null;
  worker_id: EntityId | null;
  timestamp: string;
  type: PlatformEventType;
  actor: "system" | "user" | "agent";
  payload: Record<string, unknown>;
}
