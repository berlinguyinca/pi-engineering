/**
 * Per-session view of the work read model. A pure function of a `WorkGraph` (the existing projection): no store,
 * no I/O, no clock. The Ledger and MissionStore remain the write authorities.
 */
import type { RunHealth, WorkGraph, WorkRun, WorkTask, WorkTaskState } from "./types.ts";

export const LIVE_HEALTH: ReadonlySet<RunHealth> = new Set(["active", "waiting", "stalled", "recovering", "unknown"]);

export interface SessionTaskSummary {
  id: string;
  title: string;
  state: WorkTaskState;
  /** Runs (attempts) of this task, all sessions. */
  attempts: number;
  /** Runs of this task that belong to the requested session. */
  session_attempts: number;
}

export interface SessionRetryState {
  /** Attempts beyond the first, summed over this session's tasks. */
  retries: number;
  /** Failed attempts in this session. */
  failed_attempts: number;
  /** Tasks whose newest attempt failed: they are waiting on a retry or a person. */
  tasks_awaiting_retry: string[];
}

export interface SessionSummary {
  session_id: string;
  /** False when the projection knows nothing about the session. */
  known: boolean;
  tasks: SessionTaskSummary[];
  /** Task counts by user-visible state. */
  counts: Record<WorkTaskState, number>;
  running: number;
  /** open/working/etc. tasks that are blocked or need input. */
  blocked: number;
  done: number;
  live_runs: number;
  /** Newest timestamp over the session's runs and tasks, or null. */
  last_activity_at: string | null;
  /** PR references, from the optional resolver; the projection itself carries none. */
  linked_prs: string[];
  retry: SessionRetryState;
}

export interface SessionSummaryOptions {
  /** Resolves PR refs for a task from a source that already holds them (e.g. Ledger edges). Default: none. */
  linkedPrs?: (taskId: string) => readonly string[];
}

const newest = (a: string | null, b: string | null | undefined): string | null => (b && (!a || b > a) ? b : a);

const runStamp = (r: WorkRun): string | null =>
  [r.last_progress_at, r.last_heartbeat_at, r.ended_at, r.started_at].reduce<string | null>(newest, null);

export function emptyCounts(): Record<WorkTaskState, number> {
  return { open: 0, working: 0, needs_input: 0, blocked: 0, done: 0, cancelled: 0 };
}

export function getSessionSummary(
  graph: WorkGraph,
  sessionId: string,
  opts: SessionSummaryOptions = {},
): SessionSummary {
  const sessionRuns = graph.runs.filter((r) => r.session_id === sessionId);
  const runTaskIds = new Set(sessionRuns.map((r) => r.task_id));
  const owned: WorkTask[] = graph.tasks.filter((t) => t.session_ids.includes(sessionId) || runTaskIds.has(t.id));
  const counts = emptyCounts();
  for (const t of owned) counts[t.state]++;
  let last: string | null = null;
  for (const t of owned) last = newest(last, t.updated_at);
  for (const r of sessionRuns) last = newest(last, runStamp(r));
  const attemptsOf = (id: string): WorkRun[] => graph.runs.filter((r) => r.task_id === id);
  const awaiting: string[] = [];
  let retries = 0;
  for (const t of owned) {
    const all = attemptsOf(t.id);
    const mine = all.filter((r) => r.session_id === sessionId);
    if (mine.length > 1) retries += mine.length - 1;
    const newestRun = [...all].sort((a, b) => (runStamp(a) ?? "").localeCompare(runStamp(b) ?? "")).at(-1);
    if (newestRun?.health === "failed" && t.state !== "done" && t.state !== "cancelled") awaiting.push(t.id);
  }
  const linked = new Set<string>();
  for (const t of owned) for (const pr of opts.linkedPrs?.(t.id) ?? []) linked.add(pr);
  const liveRuns = sessionRuns.filter((r) => LIVE_HEALTH.has(r.health)).length;
  return {
    session_id: sessionId,
    known: owned.length > 0 || sessionRuns.length > 0 || graph.sessions.some((s) => s.id === sessionId),
    tasks: owned.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      attempts: attemptsOf(t.id).length,
      session_attempts: sessionRuns.filter((r) => r.task_id === t.id).length,
    })),
    counts,
    running: liveRuns,
    blocked: counts.blocked + counts.needs_input,
    done: counts.done,
    live_runs: liveRuns,
    last_activity_at: last,
    linked_prs: [...linked].sort(),
    retry: {
      retries,
      failed_attempts: sessionRuns.filter((r) => r.health === "failed").length,
      tasks_awaiting_retry: awaiting,
    },
  };
}

/** Sessions that have unresolved work or a live run, with their last activity; used by the status row. */
export function listActiveSessions(graph: WorkGraph): { id: string; live: boolean; last: string | null }[] {
  const ids = new Set<string>();
  for (const s of graph.sessions) ids.add(s.id);
  for (const r of graph.runs) if (r.session_id) ids.add(r.session_id);
  const out: { id: string; live: boolean; last: string | null }[] = [];
  for (const id of ids) {
    const s = getSessionSummary(graph, id);
    const unresolved = s.tasks.some((t) => t.state !== "done" && t.state !== "cancelled");
    if (!unresolved && s.live_runs === 0) continue;
    out.push({ id, live: s.live_runs > 0, last: s.last_activity_at });
  }
  return out;
}
