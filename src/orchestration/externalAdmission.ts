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
 * Lease liveness: a lease is live while its `renewBy` is a present, parseable
 * timestamp that is not earlier than `now` (`renewBy >= now`). A missing or
 * expired `renewBy` means the mission is free to admit. An unparseable
 * `renewBy` is treated as live (fail closed): we cannot prove the lease has
 * lapsed, so a supervisor must not take the mission over.
 */

export type ExternalMissionAdmission = {
  mission_id: string;
  reason: "admit" | "skip_running" | "skip_terminal" | "skip_leased" | "skip_unknown_status";
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
 * are ordered oldest `created_at` first; missions with a missing or invalid
 * `created_at` sort last, keeping their original relative order. Non-external
 * missions are ignored.
 */
export function listAdmissibleExternalMissions(
  missions: ExternalAdmissionInput[],
  now: Date,
): ExternalMissionAdmission[] {
  const nowMs = now.getTime();

  type Entry = { mission_id: string; reason: ExternalMissionAdmission["reason"]; createdMs: number; index: number };
  const entries: Entry[] = [];

  for (let index = 0; index < missions.length; index++) {
    const mission = missions[index]!;
    if (!mission.mission_id.startsWith(EXT_PREFIX)) continue;

    let createdMs = Number.NaN;
    if (mission.created_at !== undefined && mission.created_at !== null) {
      const parsed = Date.parse(mission.created_at);
      createdMs = Number.isNaN(parsed) ? Number.NaN : parsed;
    }
    if (Number.isNaN(createdMs)) {
      // Missing or invalid created_at sorts last.
      createdMs = Number.POSITIVE_INFINITY;
    }

    const renewBy = mission.lease?.renewBy;
    let leaseLive = false;
    if (renewBy !== undefined && renewBy !== null) {
      const renewByMs = Date.parse(renewBy);
      // Unparseable renewBy is treated as live (fail closed).
      leaseLive = Number.isNaN(renewByMs) || renewByMs >= nowMs;
    }

    let reason: ExternalMissionAdmission["reason"];
    if (leaseLive) {
      reason = "skip_leased";
    } else if (RUNNING_STATUSES.has(mission.status)) {
      reason = "skip_running";
    } else if (TERMINAL_STATUSES.has(mission.status)) {
      reason = "skip_terminal";
    } else if (mission.status === "NEW") {
      reason = "admit";
    } else {
      reason = "skip_unknown_status";
    }
    entries.push({ mission_id: mission.mission_id, reason, createdMs, index });
  }

  entries.sort((a, b) => a.createdMs - b.createdMs || a.index - b.index);

  return entries.map(({ mission_id, reason }) => ({ mission_id, reason }));
}
