/**
 * Admission check for externally submitted missions (created by
 * `src/orchestration/externalEntry.ts` with ids `MSN-ext-*` in status NEW).
 *
 * A supervisor may dispatch an external mission only when it is still in NEW
 * and no live controller lease is held on it. External missions (created in
 * NEW) are never dispatched by the normal scheduler — this module tells a
 * supervisor which of them may be admitted now and why the rest cannot. Pure
 * function: no I/O.
 *
 * Lease liveness: a lease is live while its `renewBy` is a present timestamp
 * that is not earlier than `now` (`renewBy >= now`). A missing or expired
 * `renewBy` means the mission is free to admit.
 */

export type ExternalMissionAdmission = {
  mission_id: string;
  reason: "admit" | "skip_running" | "skip_terminal" | "skip_leased";
};

/** Shape accepted for admission decisions; a superset of the store's Mission. */
export interface ExternalAdmissionInput {
  mission_id: string;
  status: string;
  created_at?: string;
  lease?: {
    ownerId?: string;
    renewBy?: string;
  };
}

const EXT_PREFIX = "MSN-ext-";

const RUNNING_STATUSES = new Set(["RUNNING", "EXECUTING", "PLANNING", "INTEGRATING", "REVIEWING"]);

const TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED", "CANCELED", "BLOCKED"]);

/**
 * For every `MSN-ext-*` mission, whether a supervisor may admit it now. Results
 * are ordered oldest `created_at` first. Non-external missions are ignored.
 */
export function listAdmissibleExternalMissions(
  missions: ExternalAdmissionInput[],
  now: Date,
): ExternalMissionAdmission[] {
  const nowMs = now.getTime();
  const createdByMissionId = new Map<string, string>();
  const results: ExternalMissionAdmission[] = [];

  for (const mission of missions) {
    if (!mission.mission_id.startsWith(EXT_PREFIX)) continue;

    createdByMissionId.set(mission.mission_id, mission.created_at ?? "");

    const renewBy = mission.lease?.renewBy;
    const leaseLive = renewBy !== undefined && renewBy !== null && Date.parse(renewBy) >= nowMs;

    let reason: ExternalMissionAdmission["reason"];
    if (leaseLive) {
      reason = "skip_leased";
    } else if (RUNNING_STATUSES.has(mission.status)) {
      reason = "skip_running";
    } else if (TERMINAL_STATUSES.has(mission.status)) {
      reason = "skip_terminal";
    } else {
      reason = "admit";
    }
    results.push({ mission_id: mission.mission_id, reason });
  }

  results.sort(
    (a, b) =>
      Date.parse(createdByMissionId.get(a.mission_id) ?? "") - Date.parse(createdByMissionId.get(b.mission_id) ?? ""),
  );

  return results;
}
