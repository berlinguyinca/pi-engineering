import type { WorkerActivity } from "../workers/WorkerExecutor.ts";
import type { MissionObservability } from "./observability/MissionObservability.ts";

/**
 * The loop signals a worker's activity stream actually carries.
 *
 * Before this, observability was told only about tool *signatures*: a worker
 * that read the same file nine times in a row — the classic picture of going in
 * circles — left no repeated_file_read signal, and a worker whose every tool
 * call failed left no repeated_error signal. The tracker had the thresholds and
 * nobody fed it.
 *
 * Meaningful progress is deliberately NOT re-emitted here. A WORKER_ACTIVITY
 * event flagged meaningful resets every loop counter for that worker
 * (MissionObservability's reducer), so emitting a second meaningful event per
 * activity would erase the signals this producer exists to collect. The activity
 * sentence the orchestrator already records advances `lastMeaningfulProgressAt`
 * on its own.
 */

/** The file tools whose events carry a normalized `toolTarget` (src/workers/activity.ts FILE_TOOLS). */
const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

export function recordWorkerActivity(
  observability: MissionObservability | null | undefined,
  missionId: string,
  workerId: string,
  event: WorkerActivity,
): void {
  if (!observability || event.kind !== "tool") return;

  // The identical-invocation signal the orchestrator has always produced.
  if (event.phase === "started" && event.invocationSignature) {
    observability.noteWorkerTool(missionId, workerId, event.invocationSignature);
  }
  if (event.phase === "failed") {
    observability.noteWorkerError(missionId, workerId, `${event.toolName ?? "tool"}:${event.phase}`);
  }
  // Only paths the event itself carries: a read with no target is not evidence
  // of anything, and inventing one would blame the worker for the event's gap.
  if (READ_TOOLS.has(event.toolName ?? "")) {
    if (event.toolTarget) observability.noteWorkerRead(missionId, workerId, event.toolTarget);
  } else if (WRITE_TOOLS.has(event.toolName ?? "")) {
    // A real change clears the read repetition: rereading a file you are
    // editing is work, not a loop.
    observability.workerFileChanged(missionId, workerId);
  }
}
