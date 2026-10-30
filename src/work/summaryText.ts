/**
 * Deterministic, model-free views over the work read model (Missionless Execution Fabric, phase 5):
 * `/summary` timeline, the compact status row, `/task <id>` and `/team`. Pure text, bounded, derived from a
 * `WorkGraph` plus a few event facts. No store, no I/O, no clock except the injected `now`.
 */
import type { WorkGraph, WorkRun, WorkTask } from "./types.ts";

/** The slice of a Ledger event the timeline needs. */
export interface TimelineEvent {
  timestamp: string;
  type: string;
  task_id?: string | null;
  work_item_id?: string | null;
  run_id?: string | null;
}

const LIVE = new Set(["active", "waiting", "stalled", "recovering", "unknown"]);
const MAX_LINE = 160;
const MAX_TASKS = 12;
const MAX_EVENTS = 10;

const clip = (s: string, n = MAX_LINE): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const runState = (r: WorkRun): string => (r.health === "unknown" ? "state unknown" : r.health);
const beat = (r: WorkRun): string => (r.last_heartbeat_at ? `heartbeat ${r.last_heartbeat_at}` : "no heartbeat");
const liveRuns = (g: WorkGraph, taskId?: string): WorkRun[] =>
  g.runs.filter((r) => LIVE.has(r.health) && (taskId === undefined || r.task_id === taskId));

function taskLine(t: WorkTask, g: WorkGraph): string {
  const runs = g.runs.filter((r) => r.task_id === t.id);
  const live = runs.filter((r) => LIVE.has(r.health)).length;
  const runPart = runs.length ? ` · runs ${runs.length}${live ? ` (${live} live)` : ""}` : "";
  return clip(`${t.id} [${t.state}] ${t.title} — verify:${t.verification_status}${runPart}`);
}

/** `/summary`: tasks, runs with health, verification, blocked reasons, handoffs and the last events, oldest first. */
export function formatWorkSummary(
  graph: WorkGraph,
  events: readonly TimelineEvent[] = [],
  opts: { maxTasks?: number; maxEvents?: number } = {},
): string {
  const maxTasks = opts.maxTasks ?? MAX_TASKS;
  const maxEvents = opts.maxEvents ?? MAX_EVENTS;
  if (graph.tasks.length === 0 && events.length === 0) return "No tracked work yet.";
  const out: string[] = [];
  const count = (s: WorkTask["state"]): number => graph.tasks.filter((t) => t.state === s).length;
  out.push(
    `Work summary: ${graph.tasks.length} task(s) — ${count("done")} done, ${count("working")} working, ${count("blocked") + count("needs_input")} blocked/needs input, ${count("open")} open, ${count("cancelled")} cancelled`,
  );
  const unresolved = graph.tasks.filter((t) => t.state !== "done" && t.state !== "cancelled");
  const shown = unresolved.slice(-maxTasks);
  if (shown.length > 0) {
    out.push(`Unresolved${unresolved.length > shown.length ? ` (last ${shown.length} of ${unresolved.length})` : ""}:`);
    for (const t of shown) {
      out.push(`  ${taskLine(t, graph)}`);
      if (t.blocked_reason) out.push(`    blocked: ${clip(t.blocked_reason, 120)}`);
    }
  }
  const live = liveRuns(graph);
  if (live.length > 0) {
    out.push("Live runs:");
    for (const r of live.slice(0, maxTasks))
      out.push(`  ${r.id} on ${r.task_id}: ${runState(r)} · owner ${r.owner ?? "unknown"} · ${beat(r)}`);
    if (live.length > maxTasks) out.push(`  … ${live.length - maxTasks} more`);
  }
  if (graph.handoffs.length > 0) {
    out.push(`Handoffs (${graph.handoffs.length}):`);
    for (const h of graph.handoffs.slice(-5))
      out.push(`  ${h.id} ${h.task_id}: ${h.from_session} → ${h.to_session ?? "unclaimed"} [${h.state}]`);
  }
  if (graph.conflicts.length > 0)
    out.push(`WARNING: ${graph.conflicts.length} id(s) present in two stores: ${graph.conflicts.join(", ")}`);
  const recent = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-maxEvents);
  if (recent.length > 0) {
    out.push(`Last ${recent.length} event(s):`);
    for (const e of recent) {
      const who = e.run_id ?? e.task_id ?? e.work_item_id;
      out.push(`  ${e.timestamp} ${e.type}${who ? ` ${who}` : ""}`);
    }
  }
  return out.join("\n");
}

/**
 * One status row, never multi-line. `undefined` when there is nothing live or unresolved to say, so the status
 * bar stays empty instead of showing "0 tasks".
 */
export function formatWorkStatusRow(graph: WorkGraph): string | undefined {
  const open = graph.tasks.filter((t) => t.state !== "done" && t.state !== "cancelled");
  if (open.length === 0) return undefined;
  const live = liveRuns(graph);
  const unknown = live.filter((r) => r.health === "unknown").length;
  const blocked = open.filter((t) => t.state === "blocked" || t.state === "needs_input").length;
  const parts = [`work ${open.length} open`];
  if (live.length)
    parts.push(`${live.length} run${live.length === 1 ? "" : "s"}${unknown ? ` (${unknown} unknown)` : ""}`);
  if (blocked) parts.push(`${blocked} blocked`);
  return parts.join(" | ");
}

/** `/task <id>`: one task with its runs, verification, blocked reason and handoffs. */
export function formatTaskView(graph: WorkGraph, id: string): string {
  const t = graph.tasks.find((x) => x.id === id);
  if (!t) return `No task ${clip(id, 60)}. Run /work to list tracked work.`;
  const out = [
    `${t.id} [${t.source}] ${clip(t.title)}`,
    `  state ${t.state} (${t.raw_status}) · verify:${t.verification_status}`,
  ];
  if (t.blocked_reason) out.push(`  blocked: ${clip(t.blocked_reason, 120)}`);
  if (t.parent_id) out.push(`  parent ${t.parent_id}`);
  if (t.updated_at) out.push(`  updated ${t.updated_at}`);
  const runs = graph.runs.filter((r) => r.task_id === t.id);
  for (const r of runs.slice(-MAX_TASKS))
    out.push(
      `  run ${r.id} ${runState(r)}${r.outcome ? ` (${r.outcome})` : ""} · owner ${r.owner ?? "unknown"} · ${beat(r)}`,
    );
  if (runs.length > MAX_TASKS) out.push(`  … ${runs.length - MAX_TASKS} earlier run(s)`);
  for (const h of graph.handoffs.filter((x) => x.task_id === t.id).slice(-5))
    out.push(`  handoff ${h.id} ${h.from_session} → ${h.to_session ?? "unclaimed"} [${h.state}]`);
  return out.join("\n");
}

/** `/team`: the delegation preference and, per task, the runs that are alive. Read-only. */
export function formatTeamView(graph: WorkGraph, preference: string): string {
  const out = [`Execution preference: ${preference}`];
  const byTask = new Map<string, WorkRun[]>();
  for (const r of liveRuns(graph)) byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r]);
  if (byTask.size === 0) {
    out.push("No live runs.");
    return out.join("\n");
  }
  const titles = new Map(graph.tasks.map((t) => [t.id, t.title]));
  let n = 0;
  for (const [taskId, runs] of byTask) {
    if (n++ >= MAX_TASKS) {
      out.push(`… ${byTask.size - MAX_TASKS} more task(s) with live runs`);
      break;
    }
    out.push(clip(`${taskId} ${titles.get(taskId) ?? ""}`));
    for (const r of runs) out.push(`  ${r.id} ${runState(r)} · owner ${r.owner ?? "unknown"} · ${beat(r)}`);
  }
  return out.join("\n");
}
