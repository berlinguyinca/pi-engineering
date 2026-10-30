/**
 * Generic work read model (Missionless Execution Fabric, phase 2).
 *
 * These are derived views, never a store: the Ledger is the write authority for
 * new work and MissionStore for existing Missions (docs/specs/
 * pi-engineering-missionless-fabric-20261028-v1/EVENT-OWNER-MAP.md). A task's
 * state, its verification, and the health of its runs are separate dimensions,
 * so a finished run never implies a finished task.
 */

export type WorkSource = "ledger" | "mission";

/** User-visible task state. */
export type WorkTaskState = "open" | "working" | "needs_input" | "blocked" | "done" | "cancelled";

/**
 * `unknown` is an addition to the spec's five values: a legacy Mission has no
 * revision-bound evidence this projection can read, so it must not claim one.
 */
export type VerificationStatus = "not_required" | "pending" | "passed" | "failed" | "stale" | "incomplete" | "unknown";

/**
 * `unknown` is a run with no heartbeat inside the stale threshold (or an offline service): state unknown,
 * never presented as healthy.
 */
export type RunHealth = "active" | "waiting" | "stalled" | "recovering" | "unknown" | "failed" | "finished";

export interface WorkTask {
  id: string;
  source: WorkSource;
  title: string;
  state: WorkTaskState;
  /** The store's own status, unmapped. */
  raw_status: string;
  verification_status: VerificationStatus;
  /** Why a gate refused completion, when it did. */
  blocked_reason?: string;
  parent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  run_ids: string[];
  session_ids: string[];
}

export interface WorkRun {
  id: string;
  task_id: string;
  source: WorkSource;
  session_id: string | null;
  health: RunHealth;
  /** Terminal detail the health value cannot carry, e.g. "cancelled". */
  outcome: string | null;
  model: string | null;
  worktree: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Who runs it (`role@model`), when an event said so. */
  owner?: string | null;
  /** Last `agent.started` / `agent.heartbeat` for the run. */
  last_heartbeat_at?: string | null;
  /** Last event that shows work moving (anything but a bare heartbeat), or what a heartbeat reported. */
  last_progress_at?: string | null;
}

export interface WorkSession {
  id: string;
  source: WorkSource;
  task_ids: string[];
  run_ids: string[];
}

export interface WorkHandoff {
  id: string;
  source: WorkSource;
  task_id: string;
  from_session: string;
  to_session: string | null;
  state: string;
  created_at: string | null;
}

export interface WorkGraph {
  tasks: WorkTask[];
  runs: WorkRun[];
  sessions: WorkSession[];
  handoffs: WorkHandoff[];
  /** Ids present in more than one source: a task writable in two stores. Must stay empty. */
  conflicts: string[];
}

export const emptyWorkGraph = (): WorkGraph => ({ tasks: [], runs: [], sessions: [], handoffs: [], conflicts: [] });

/** Merge graphs from different stores. The first source to claim an id keeps it; repeats are reported. */
export function mergeWorkGraphs(...graphs: WorkGraph[]): WorkGraph {
  const out = emptyWorkGraph();
  const seen = new Set<string>();
  const take = <T extends { id: string }>(target: T[], items: T[], kind: string): void => {
    for (const item of items) {
      const key = `${kind}:${item.id}`;
      if (seen.has(key)) {
        out.conflicts.push(key);
        continue;
      }
      seen.add(key);
      target.push(item);
    }
  };
  for (const g of graphs) {
    take(out.tasks, g.tasks, "task");
    take(out.runs, g.runs, "run");
    take(out.sessions, g.sessions, "session");
    take(out.handoffs, g.handoffs, "handoff");
    out.conflicts.push(...g.conflicts);
  }
  return out;
}
