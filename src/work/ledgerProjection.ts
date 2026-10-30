import type { Candidate, Evidence, LedgerEvent, WorkItem, WorkItemStatus } from "../core/types.ts";
import type { Ledger } from "../ledger/Ledger.ts";
import type {
  RunHealth,
  VerificationStatus,
  WorkGraph,
  WorkRun,
  WorkSession,
  WorkTask,
  WorkTaskState,
} from "./types.ts";

const STATE_BY_STATUS: Record<WorkItemStatus, WorkTaskState> = {
  DEFINED: "open",
  PLANNING: "open",
  READY: "open",
  EXECUTING: "working",
  VERIFYING: "working",
  REVIEWING: "working",
  INTEGRATING: "working",
  COMPLETED: "done",
  BLOCKED: "blocked",
  // Not done: a failed or partial item needs someone, and BUDGET_EXHAUSTED is a stop, not success.
  FAILED: "blocked",
  PARTIAL: "blocked",
  BUDGET_EXHAUSTED: "blocked",
  CANCELLED: "cancelled",
  NEEDS_HUMAN: "needs_input",
};

export function workStateOf(status: WorkItemStatus): WorkTaskState {
  return STATE_BY_STATUS[status] ?? "blocked";
}

/** Work items that have not started: no candidate is expected yet, or none ever will be. */
const NOT_STARTED: ReadonlySet<WorkItemStatus> = new Set(["DEFINED", "PLANNING", "READY", "CANCELLED"]);

const HEALTH_BY_EVENT: Partial<Record<LedgerEvent["type"], RunHealth>> = {
  "agent.started": "active",
  "agent.completed": "finished",
  "agent.failed": "failed",
};

/** Evidence belongs to the candidate's current commit/tree, when the candidate records one. */
function evidenceMatches(candidate: Candidate, evidence: Evidence): boolean {
  if (!candidate.head_commit && !candidate.tree) return true;
  const s = evidence.summary;
  if (candidate.head_commit && s.head_commit !== candidate.head_commit) return false;
  if (candidate.tree && s.tree !== candidate.tree) return false;
  return true;
}

export interface ProjectionOptions {
  /** Injectable clock (epoch ms) so liveness is testable without sleeping. */
  now?: () => number;
  /** `execution.stale_after_ms`. */
  staleAfterMs?: number;
  /**
   * Extra evidence types a work item must have passing rows for, from policy (for example
   * `verify.test` for a high-risk item). Evidence rows also declare the stages their own run required.
   */
  requiredEvidence?: (wi: WorkItem) => readonly string[];
}

export const DEFAULT_STALE_AFTER_MS = 300_000;

interface RunClock {
  heartbeat: string | null;
  progress: string | null;
  phase: "waiting" | "recovering" | null;
}

export interface ProjectionCursor {
  /** Index into the Ledger's append-only event list: events before it have been applied. */
  position: number;
  last_event_id: string | null;
}

/**
 * Task, run and session view of the Ledger. Work items, plan tasks, candidates
 * and evidence come from the Ledger's own materialized views (no second replay
 * of their rules); runs and sessions come from `agent.*` events and from the
 * `run_id` envelope field. The event list is append-only, so a position is a
 * complete cursor: `catchUp` consumes only what follows it.
 */
export class LedgerWorkProjection {
  private readonly ledger: Ledger;
  private readonly runs = new Map<string, WorkRun>();
  private readonly clocks = new Map<string, RunClock>();
  private readonly opts: ProjectionOptions;
  private position = 0;
  private lastEventId: string | null = null;

  constructor(ledger: Ledger, opts: ProjectionOptions = {}) {
    this.ledger = ledger;
    this.opts = opts;
  }

  cursor(): ProjectionCursor {
    return { position: this.position, last_event_id: this.lastEventId };
  }

  /** Apply any events past the cursor; returns how many were new. */
  catchUp(): number {
    const events = this.ledger.events();
    const fresh = events.slice(this.position);
    for (const event of fresh) {
      this.applyRunFacts(event);
      this.lastEventId = event.event_id;
    }
    this.position = events.length;
    return fresh.length;
  }

  private applyRunFacts(event: LedgerEvent): void {
    const heartbeat = event.type === "agent.heartbeat";
    const health = HEALTH_BY_EVENT[event.type];
    // A run exists because an agent lifecycle event said so, or because the writer named one
    // explicitly. The actor's run id alone is not enough: claims and evidence an agent
    // records would otherwise create runs that never finish.
    const runId = health || heartbeat ? (event.run_id ?? event.actor.run_id) : event.run_id;
    if (!runId) return;
    const taskId = event.task_id ?? event.work_item_id;
    if (!taskId) return;
    const prior = this.runs.get(runId);
    this.noteClock(runId, event, heartbeat);
    const owner = [event.actor.role, event.actor.model].filter(Boolean).join("@") || null;
    const priorTerminal = prior?.health === "finished" || prior?.health === "failed";
    // A terminal run is final: a late or duplicated lifecycle event does not reopen or rewrite it.
    const next = priorTerminal ? undefined : health;
    const terminal = next === "finished" || next === "failed";
    this.runs.set(runId, {
      id: runId,
      task_id: prior?.task_id ?? taskId,
      source: "ledger",
      session_id: prior?.session_id ?? event.session_id ?? null,
      health: next ?? prior?.health ?? "active",
      outcome: terminal ? (next === "failed" ? "failed" : "completed") : (prior?.outcome ?? null),
      model: prior?.model ?? event.actor.model ?? null,
      worktree: prior?.worktree ?? null,
      started_at: prior?.started_at ?? (next === "active" ? event.timestamp : null),
      ended_at: terminal ? event.timestamp : (prior?.ended_at ?? null),
      owner: prior?.owner ?? owner,
    });
  }

  private noteClock(runId: string, event: LedgerEvent, heartbeat: boolean): void {
    const clock = this.clocks.get(runId) ?? { heartbeat: null, progress: null, phase: null };
    const later = (a: string | null, b: string): string => (a && a > b ? a : b);
    if (heartbeat) {
      clock.heartbeat = later(clock.heartbeat, event.timestamp);
      const reported = event.payload.last_progress_at;
      if (typeof reported === "string") clock.progress = later(clock.progress, reported);
      const phase = event.payload.phase;
      clock.phase = phase === "waiting" || phase === "recovering" ? phase : null;
    } else {
      // Any other event that names the run is movement; the start also counts as the first heartbeat.
      clock.progress = later(clock.progress, event.timestamp);
      if (event.type === "agent.started") clock.heartbeat = later(clock.heartbeat, event.timestamp);
    }
    this.clocks.set(runId, clock);
  }

  /**
   * Health a run has right now. Terminal events are final. Otherwise: no heartbeat inside the stale
   * threshold is `unknown` (we cannot see it, so it is not healthy); a heartbeat that reports waiting or
   * recovering says so; a heartbeat without meaningful progress past the threshold is `stalled`.
   */
  private liveHealth(run: WorkRun): RunHealth {
    if (run.health === "finished" || run.health === "failed") return run.health;
    const clock = this.clocks.get(run.id);
    const stale = this.opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const now = (this.opts.now ?? Date.now)();
    const seen = Date.parse(clock?.heartbeat ?? run.started_at ?? "");
    if (!Number.isFinite(seen) || now - seen > stale) return "unknown";
    if (clock?.phase) return clock.phase;
    const moved = Date.parse(clock?.progress ?? clock?.heartbeat ?? "");
    return Number.isFinite(moved) && now - moved > stale ? "stalled" : "active";
  }

  /**
   * Verification is bound to the current candidate, which is the Ledger's
   * revision identity: evidence for another candidate, or for another commit/tree
   * of this candidate, is stale, not passing. `unverified` evidence never counts.
   * `passed` needs a passing row for every gate the work requires: the stages the
   * verification run itself declared required (`summary.required_stages`) plus any
   * policy-supplied evidence types. A missing required gate is `incomplete`. A work
   * item that has started but has no candidate is `unknown`, not "not required".
   */
  private verificationOf(workItemId: string): VerificationStatus {
    const wi = this.ledger.getWorkItem(workItemId);
    const candidates = this.ledger.listCandidates(workItemId);
    if (candidates.length === 0) return wi && NOT_STARTED.has(wi.status) ? "not_required" : "unknown";
    const currentId = wi?.current_candidate_id ?? wi?.incumbent_candidate_id ?? null;
    const current = currentId ? candidates.find((c) => c.id === currentId) : undefined;
    if (!current) return "pending";
    const all = this.ledger.listEvidence(current.id).filter((e) => e.trust !== "unverified");
    // A candidate that records its verified commit/tree binds its evidence; one that does not (older
    // writers) cannot be checked, so its evidence is taken as written.
    const evidence = all.filter((e) => evidenceMatches(current, e));
    if (evidence.length === 0) {
      const earlier =
        all.length > 0 || candidates.some((c) => c.id !== current.id && this.ledger.listEvidence(c.id).length > 0);
      return earlier ? "stale" : "pending";
    }
    if (!evidence.every((e) => e.status === "passed")) return "failed";
    const required = new Set<string>(this.opts.requiredEvidence && wi ? this.opts.requiredEvidence(wi) : []);
    for (const e of evidence) {
      const stages = e.summary.required_stages;
      if (Array.isArray(stages))
        for (const name of stages) if (typeof name === "string") required.add(`verify.${name}`);
    }
    for (const type of required)
      if (!evidence.some((e) => e.type === type && e.status === "passed")) return "incomplete";
    return "passed";
  }

  graph(): WorkGraph {
    this.catchUp();
    const tasks: WorkTask[] = [];
    for (const wi of this.ledger.listWorkItems()) {
      tasks.push({
        id: wi.id,
        source: "ledger",
        title: wi.goal,
        state: workStateOf(wi.status),
        raw_status: wi.status,
        verification_status: this.verificationOf(wi.id),
        ...(wi.blocked_reason && workStateOf(wi.status) === "blocked" ? { blocked_reason: wi.blocked_reason } : {}),
        parent_id: null,
        created_at: wi.created_at,
        updated_at: wi.updated_at,
        run_ids: [],
        session_ids: [],
      });
      for (const t of this.ledger.listTasks(wi.id)) {
        tasks.push({
          id: t.id,
          source: "ledger",
          title: t.title,
          state:
            t.status === "completed"
              ? "done"
              : t.status === "blocked" || t.status === "failed"
                ? "blocked"
                : t.status === "started"
                  ? "working"
                  : "open",
          raw_status: t.status,
          // A plan task reports its own evidence once it has produced a work item; otherwise it has none.
          verification_status:
            t.result_work_item_id && this.ledger.getWorkItem(t.result_work_item_id)
              ? this.verificationOf(t.result_work_item_id)
              : "unknown",
          ...(t.blocked_reason && t.status === "blocked" ? { blocked_reason: t.blocked_reason } : {}),
          parent_id: wi.id,
          created_at: null,
          updated_at: null,
          run_ids: [],
          session_ids: [],
        });
      }
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const runs = [...this.runs.values()].map((r) => {
      const clock = this.clocks.get(r.id);
      return {
        ...r,
        health: this.liveHealth(r),
        last_heartbeat_at: clock?.heartbeat ?? null,
        last_progress_at: clock?.progress ?? null,
      };
    });
    const sessions = new Map<string, WorkSession>();
    for (const run of runs) {
      const task = byId.get(run.task_id);
      if (task) {
        task.run_ids.push(run.id);
        if (run.session_id && !task.session_ids.includes(run.session_id)) task.session_ids.push(run.session_id);
      }
      if (run.session_id) {
        const s = sessions.get(run.session_id) ?? {
          id: run.session_id,
          source: "ledger" as const,
          task_ids: [],
          run_ids: [],
        };
        if (!s.task_ids.includes(run.task_id)) s.task_ids.push(run.task_id);
        s.run_ids.push(run.id);
        sessions.set(s.id, s);
      }
    }
    return { tasks, runs, sessions: [...sessions.values()], handoffs: [], conflicts: [] };
  }
}
