/**
 * Compact terminal rendering of the work graph (Missionless Execution Fabric,
 * phase 5). Pure text: one line per task, newest last, with state, verification
 * and live-run count kept as separate facts so "run finished" is never shown as
 * "task done".
 */
import type { WorkGraph, WorkTask } from "./types.ts";

const LIVE = new Set(["active", "waiting", "stalled", "recovering"]);

function line(task: WorkTask, graph: WorkGraph): string {
  const runs = graph.runs.filter((r) => r.task_id === task.id);
  const live = runs.filter((r) => LIVE.has(r.health)).length;
  const failed = runs.filter((r) => r.health === "failed").length;
  const parts = [`${task.state}`, `verify:${task.verification_status}`];
  if (runs.length > 0)
    parts.push(
      `runs ${runs.length - live - failed}/${runs.length} done${live ? `, ${live} live` : ""}${failed ? `, ${failed} failed` : ""}`,
    );
  const title = task.title.length > 70 ? `${task.title.slice(0, 69)}…` : task.title;
  const why = task.blocked_reason ? `\n  blocked: ${task.blocked_reason}` : "";
  return `${task.id} [${task.source}] ${title} — ${parts.join(" · ")}${why}`;
}

export function formatWorkStatus(graph: WorkGraph, limit = 10): string {
  if (graph.tasks.length === 0) return "No tracked work yet.";
  const shown = graph.tasks.slice(-limit);
  const header = `${graph.tasks.length} task${graph.tasks.length === 1 ? "" : "s"}${graph.tasks.length > shown.length ? ` (last ${shown.length})` : ""}`;
  const handoffs =
    graph.handoffs.length > 0
      ? `\n${graph.handoffs.length} handoff${graph.handoffs.length === 1 ? "" : "s"} recorded`
      : "";
  const conflicts =
    graph.conflicts.length > 0
      ? `\nWARNING: ${graph.conflicts.length} id(s) present in two stores: ${graph.conflicts.join(", ")}`
      : "";
  return `${header}\n${shown.map((t) => line(t, graph)).join("\n")}${handoffs}${conflicts}`;
}
