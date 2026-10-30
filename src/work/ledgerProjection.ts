import type { LedgerEvent, WorkItemStatus } from "../core/types.ts";
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
  private position = 0;
  private lastEventId: string | null = null;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
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
    const health = HEALTH_BY_EVENT[event.type];
    // A run exists because an agent lifecycle event said so, or because the writer named one
    // explicitly. The actor's run id alone is not enough: claims and evidence an agent
    // records would otherwise create runs that never finish.
    const runId = health ? (event.run_id ?? event.actor.run_id) : event.run_id;
    if (!runId) return;
    const taskId = event.task_id ?? event.work_item_id;
    if (!taskId) return;
    const prior = this.runs.get(runId);
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
    });
  }

  /**
   * Verification is bound to the current candidate, which is the Ledger's
   * revision identity: evidence for another candidate is stale, not passing.
   * `unverified` evidence never counts as a pass. A work item that has started
   * but has no candidate is `unknown`, not "not required".
   */
  private verificationOf(workItemId: string): VerificationStatus {
    const wi = this.ledger.getWorkItem(workItemId);
    const candidates = this.ledger.listCandidates(workItemId);
    if (candidates.length === 0) return wi && NOT_STARTED.has(wi.status) ? "not_required" : "unknown";
    const current = wi?.current_candidate_id ?? wi?.incumbent_candidate_id ?? null;
    if (!current) return "pending";
    const evidence = this.ledger.listEvidence(current).filter((e) => e.trust !== "unverified");
    if (evidence.length === 0) {
      const earlier = candidates.some((c) => c.id !== current && this.ledger.listEvidence(c.id).length > 0);
      return earlier ? "stale" : "pending";
    }
    return evidence.every((e) => e.status === "passed") ? "passed" : "failed";
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
          verification_status: "unknown",
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
    const runs = [...this.runs.values()].map((r) => ({ ...r }));
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
