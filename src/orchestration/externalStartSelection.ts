/**
 * Selection of which admitted external missions the runtime should start next.
 *
 * Externally submitted missions (created by `src/orchestration/externalEntry.ts`
 * with ids `MSN-ext-*` in status NEW, admitted fail-closed by
 * `src/orchestration/externalAdmission.ts`) are never dispatched by the normal
 * scheduler. This module picks, from a set of candidates, which of them a
 * supervisor may start now, subject to a concurrency budget. Pure function: no
 * I/O, no clock, no store access.
 *
 * Rules mirror the external-admission contract:
 *  - only ids starting with `MSN-ext-` are candidates;
 *  - a mission may start only while it is still in NEW (fail closed: QUEUED and
 *    everything else is skipped);
 *  - a lease held by another owner is never started while it is live
 *    (`renewBy` present, parseable and `>= now`; an unparseable `renewBy` is
 *    treated as live — we cannot prove it has lapsed);
 *  - a lease that is absent, expired, or owned by `selfOwnerId` is eligible;
 *  - eligible ids are returned oldest `created_at` first, invalid/missing
 *    dates last, ties broken by `mission_id` ascending;
 *  - at most `max(0, maxConcurrent - runningExternalCount)` ids are returned.
 */

import type { Mission, MissionLease } from "./types.ts";

const EXT_PREFIX = "MSN-ext-";

/** Shape accepted for start selection; a superset of the store's Mission. */
export interface ExternalStartInput {
  mission: Pick<Mission, "mission_id" | "status" | "created_at">;
  lease?: Pick<MissionLease, "ownerId" | "renewBy">;
}

/**
 * Deterministically select which external missions may be started now. Pure:
 * never mutates inputs and always returns the same result for the same inputs.
 */
export function selectExternalMissionsToStart(
  candidates: readonly ExternalStartInput[],
  selfOwnerId: string,
  now: Date,
  maxConcurrent: number,
  runningExternalCount: number,
): string[] {
  if (!Number.isInteger(maxConcurrent) || !Number.isInteger(runningExternalCount)) return [];
  if (maxConcurrent <= 0) return [];

  const nowMs = now.getTime();
  const capacity = Math.max(0, maxConcurrent - runningExternalCount);
  if (capacity === 0) return [];

  type Entry = { mission_id: string; createdMs: number };
  const eligible: Entry[] = [];

  for (const candidate of candidates) {
    const { mission, lease } = candidate;
    if (!mission.mission_id.startsWith(EXT_PREFIX)) continue;
    // Fail closed: only an explicit NEW status is startable.
    if (mission.status !== "NEW") continue;

    // A lease held by another owner is never started while it is live.
    if (lease !== undefined) {
      const renewByMs = Date.parse(lease.renewBy);
      const live = Number.isNaN(renewByMs) || renewByMs >= nowMs;
      if (live && lease.ownerId !== selfOwnerId) continue;
    }

    let createdMs = Number.NaN;
    if (mission.created_at !== undefined && mission.created_at !== null) {
      const parsed = Date.parse(mission.created_at);
      createdMs = Number.isNaN(parsed) ? Number.NaN : parsed;
    }
    if (Number.isNaN(createdMs)) createdMs = Number.POSITIVE_INFINITY;

    eligible.push({ mission_id: mission.mission_id, createdMs });
  }

  eligible.sort((a, b) => a.createdMs - b.createdMs || a.mission_id.localeCompare(b.mission_id));

  return eligible.slice(0, capacity).map((entry) => entry.mission_id);
}
