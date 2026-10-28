import type { MissionObservability } from "./observability/MissionObservability.ts";
import type { ReviewEvidence, TaskStatus } from "./types.ts";

/**
 * Feed a settled review into observability.
 *
 * The review evidence is the record of what an independent reviewer actually
 * said about the current candidate; before this producer, observability never
 * heard any of it. A mission whose reviewer asked for changes and a mission
 * whose reviewer had not answered yet looked identical on every surface.
 *
 * Findings are recorded under the same identity the completion gate uses for
 * them (`<evidenceId>:<index>`), so a later repair that resolves one closes the
 * same record instead of orphaning it.
 */
export function recordReviewSettlement(
  observability: MissionObservability | null | undefined,
  missionId: string,
  status: TaskStatus,
  evidence: ReviewEvidence | undefined,
): void {
  if (!observability || !evidence) return;
  observability.reviewStarted(missionId, evidence.reviewerSessionId, evidence.model);
  (evidence.findings ?? []).forEach((finding, index) => {
    observability.reviewFinding(missionId, finding.severity, finding.summary, null, `${evidence.evidenceId}:${index}`);
  });
  // A review task that died mid-flight is not a completed review; the window
  // stays open so the operator sees the review as unfinished.
  if (status === "SUCCEEDED") observability.reviewCompleted(missionId);
}

/**
 * Open a repair round for the findings it was created from, and close each one
 * it actually settled. A round that produced nothing leaves its findings open —
 * the next review, not the repair task's success, decides whether a finding is
 * gone.
 */
export function recordRepairRound(
  observability: MissionObservability | null | undefined,
  missionId: string,
  taskId: string,
  findingIds: readonly string[],
  settled: boolean,
): void {
  if (!observability) return;
  observability.repairStarted(missionId, taskId);
  if (!settled) return;
  for (const findingId of findingIds) observability.repairCompleted(missionId, taskId, findingId);
}

/**
 * Record what the completion gate decided. Only the failure path is emitted
 * here: the pass path already owns its own producers (`observeGatePassed`), and
 * the reasons are the gate's own strings — never invented ones.
 */
export function recordGateVerdict(
  observability: MissionObservability | null | undefined,
  missionId: string,
  verdict: { can_complete: boolean; reasons: readonly string[] },
): void {
  if (!observability) return;
  observability.gateStarted(missionId);
  if (!verdict.can_complete) observability.gateFailed(missionId, [...verdict.reasons]);
}
