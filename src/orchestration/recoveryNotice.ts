import type { MissionObservability } from "./observability/MissionObservability.ts";
import type { WaitingReason } from "./observability/types.ts";
import type { MissionSchedulerStatusNotice } from "./scheduler.ts";

/**
 * Turn one scheduler recovery notice into what the operator's surfaces need:
 * a waiting reason, an open/closed recovery window, and the report line the
 * scheduler has always printed.
 *
 * The scheduler knows a mission is recovering; observability used to hear only
 * about the waiting reason. That gap is why a mission could sit in recovery for
 * eleven minutes and the projection could not say so: `summary.recovery` is
 * derived from durable recovery decisions, so without these events the only
 * evidence of a recovery window was the wall clock.
 */
export function recordSchedulerStatus(
  notice: MissionSchedulerStatusNotice,
  observability: MissionObservability | null | undefined,
  report: (missionId: string, line: string) => void,
): void {
  if (notice.action === "resumed") {
    observability?.clearWaiting(notice.missionId);
    observability?.recoveryCompleted(notice.missionId);
    report(
      notice.missionId,
      `[mission ${notice.missionId}] recovery succeeded; worker execution resumed (attempt ${notice.attempt})`,
    );
    return;
  }

  const waitingReason: WaitingReason =
    notice.status === "WAITING_FOR_CAPACITY"
      ? "rate_limit"
      : notice.status === "RECOVERING_CONTEXT"
        ? "model_request"
        : "external_resource";
  const next = notice.nextActionAt ? `; next recovery check ${new Date(notice.nextActionAt).toISOString()}` : "";
  const detail =
    notice.action === "paused"
      ? `Recovery stopped with no active worker: ${notice.reason}. Mission is paused and resumable.`
      : `No active worker while recovery runs: ${notice.reason}; attempt ${notice.attempt}${next}`;

  observability?.setWaiting(notice.missionId, waitingReason, detail);
  // The scheduler's notice carries a task id, not a worker id; the recovery
  // window only needs a stable key to attribute the attempt to work.
  if (notice.action === "paused") observability?.recoveryFailed(notice.missionId);
  else observability?.recoveryStarted(notice.missionId, notice.taskId, notice.action, notice.attempt, detail);

  report(notice.missionId, `[mission ${notice.missionId}] ${detail}`);
}
