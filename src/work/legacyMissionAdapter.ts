import type { Execution, Mission, MissionStatus, OrchestrationTask, TaskStatus } from "../orchestration/types.ts";
import type { HandoffRecord } from "../runtime/host/handoffKinds.ts";
import type { RunHealth, WorkGraph, WorkRun, WorkSession, WorkTask, WorkTaskState } from "./types.ts";

/**
 * The read surface the adapter needs. MissionStore satisfies it structurally;
 * naming only readers makes "read-only" a property of the type, not a promise.
 */
export interface MissionReader {
  listMissions(): Mission[];
  listTasks(missionId?: string): OrchestrationTask[];
  listExecutions(missionId?: string, taskId?: string): Execution[];
  listHandoffRecords(missionId?: string): HandoffRecord[];
}

const MISSION_STATE: Partial<Record<MissionStatus, WorkTaskState>> = {
  NEW: "open",
  CLASSIFYING: "open",
  PLANNING: "open",
  READY: "open",
  QUEUED: "open",
  COMPLETE: "done",
  WAITING_FOR_USER: "needs_input",
  NEEDS_ATTENTION: "needs_input",
  BLOCKED: "blocked",
  FAILED: "blocked",
  CANCELED: "cancelled",
};

/** Everything not listed (executing, validating, repairing, waiting on infrastructure, recovering, canceling) is in flight. */
export function missionWorkState(status: MissionStatus): WorkTaskState {
  return MISSION_STATE[status] ?? "working";
}

function taskWorkState(status: TaskStatus): WorkTaskState {
  switch (status) {
    case "SUCCEEDED":
      return "done";
    case "FAILED":
      return "blocked";
    case "CANCELED":
    case "SKIPPED":
      return "cancelled";
    case "BLOCKED":
      return "blocked";
    case "PENDING":
    case "READY":
      return "open";
    default:
      return "working";
  }
}

function runHealth(status: Execution["status"]): RunHealth {
  switch (status) {
    case "RUNNING":
      return "active";
    case "PENDING":
      return "waiting";
    case "FAILED":
      return "failed";
    default:
      return "finished";
  }
}

/**
 * Project existing Missions into the generic work graph without writing: a
 * Mission is a task, its orchestration tasks are child tasks, an Execution is a
 * run, and a HandoffRecord is a handoff between sessions. Historical ids are
 * kept so links and viewers stay valid.
 */
export function projectLegacyMissions(reader: MissionReader): WorkGraph {
  const tasks: WorkTask[] = [];
  const runs: WorkRun[] = [];
  const sessions = new Map<string, WorkSession>();
  const handoffs: WorkGraph["handoffs"] = [];
  const taskById = new Map<string, WorkTask>();

  for (const m of reader.listMissions()) {
    const root: WorkTask = {
      id: m.mission_id,
      source: "mission",
      title: m.title,
      state: missionWorkState(m.status),
      raw_status: m.status,
      // This adapter reads no evidence, so it does not claim a pass, even for COMPLETE.
      verification_status: "unknown",
      parent_id: null,
      created_at: m.created_at,
      updated_at: m.updated_at ?? null,
      run_ids: [],
      session_ids: [],
    };
    tasks.push(root);
    taskById.set(root.id, root);

    for (const t of reader.listTasks(m.mission_id)) {
      const child: WorkTask = {
        id: t.task_id,
        source: "mission",
        title: t.objective,
        state: taskWorkState(t.status),
        raw_status: t.status,
        verification_status: "unknown",
        parent_id: m.mission_id,
        created_at: null,
        updated_at: null,
        run_ids: [],
        session_ids: [],
      };
      tasks.push(child);
      taskById.set(child.id, child);
    }

    for (const e of reader.listExecutions(m.mission_id)) {
      runs.push({
        id: e.execution_id,
        task_id: e.task_id,
        source: "mission",
        session_id: e.session_id,
        health: runHealth(e.status),
        outcome: e.status === "CANCELED" ? "cancelled" : e.status === "FAILED" ? (e.error ?? "failed") : null,
        model: e.model,
        worktree: e.worktree,
        started_at: e.started_at,
        ended_at: e.ended_at,
      });
      for (const owner of [taskById.get(e.task_id), root]) {
        if (!owner) continue;
        owner.run_ids.push(e.execution_id);
        if (e.session_id && !owner.session_ids.includes(e.session_id)) owner.session_ids.push(e.session_id);
      }
      if (e.session_id) {
        const s = sessions.get(e.session_id) ?? {
          id: e.session_id,
          source: "mission" as const,
          task_ids: [],
          run_ids: [],
        };
        for (const id of [e.task_id, m.mission_id]) if (!s.task_ids.includes(id)) s.task_ids.push(id);
        s.run_ids.push(e.execution_id);
        sessions.set(s.id, s);
      }
    }

    for (const h of reader.listHandoffRecords(m.mission_id)) {
      handoffs.push({
        id: h.id,
        source: "mission",
        task_id: m.mission_id,
        from_session: h.predecessor.sessionId,
        to_session: h.successor?.sessionId ?? null,
        state: h.state,
        created_at: h.createdAt,
      });
    }
  }
  return { tasks, runs, sessions: [...sessions.values()], handoffs, conflicts: [] };
}
