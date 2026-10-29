/**
 * Evidence policy for generic work (Missionless Execution Fabric, phase 3).
 *
 * A pure function over the read model: it decides whether a task may be called
 * complete and names what blocks it. It does not replace the Mission
 * `CompletionGate`, which keeps judging Missions; it gives Ledger-owned tasks
 * the same discipline (no completion while a run is live, none on failed,
 * stale, pending or unknown verification) without a Mission.
 */
import type { RunHealth, WorkRun, WorkTask } from "./types.ts";

export interface CompletionVerdict {
  complete: boolean;
  blockers: string[];
}

const LIVE_RUN: ReadonlySet<RunHealth> = new Set(["active", "waiting", "stalled", "recovering"]);

export function evaluateWorkCompletion(task: WorkTask, runs: readonly WorkRun[]): CompletionVerdict {
  const blockers: string[] = [];
  if (task.state === "cancelled") blockers.push("task is cancelled");
  if (task.state === "blocked" || task.state === "needs_input") blockers.push(`task is ${task.state}`);
  if (task.state === "open") blockers.push("task has not started");
  for (const run of runs) {
    if (run.task_id === task.id && LIVE_RUN.has(run.health)) blockers.push(`run ${run.id} is ${run.health}`);
  }
  switch (task.verification_status) {
    case "passed":
    case "not_required":
      break;
    case "unknown":
      blockers.push("verification status is unknown");
      break;
    default:
      blockers.push(`verification is ${task.verification_status}`);
  }
  return { complete: blockers.length === 0, blockers };
}
