/**
 * Pure lease reconciliation (spec §9, AGENT-002/AGENT-003).
 *
 * A post-crash operator preview: given the current lease table plus the known
 * live sessions, live process incarnations and mission statuses, decide for
 * each lease whether it is live (`keep`), may be reclaimed (`reclaim`) or
 * needs operator attention (`quarantine`). This module is pure — no sqlite,
 * fs, /proc, or wall clock — so it is trivially testable and safe to run off
 * the hot path.
 */

import type { MissionStatus } from "../../orchestration/types.ts";
import type { LeaseRecord } from "./LeaseManager.ts";

/** Mission statuses after which a mission never needs its leases again. */
export const TERMINAL_MISSION_STATUSES: ReadonlySet<string> = new Set<string>(["COMPLETE", "FAILED", "CANCELED"]);

export type LeaseDecision = "keep" | "reclaim" | "quarantine";

export type LeaseReconcileReason =
  | "live"
  | "session_unregistered"
  | "holder_incarnation_superseded"
  | "lease_expired"
  | "lease_expired_terminal"
  | "lease_expired_unknown_mission"
  | "lease_expired_live_mission"
  | "duplicate_holder";

export interface LeaseVerdict {
  resourceId: string;
  sessionId: string;
  generationId: string;
  decision: LeaseDecision;
  reason: LeaseReconcileReason;
}

/** Stable identity of a specific process incarnation holding a lease. */
export function incarnationKey(l: Pick<LeaseRecord, "sessionId" | "pid" | "processStartTime">): string {
  return `${l.sessionId}|${l.pid}|${l.processStartTime ?? ""}`;
}

/**
 * Map a lease resource id to a mission id, or null when the resource is not
 * mission-owned (e.g. `repository:leases`). Accepts both the namespaced form
 * (`ns#mission:<id>`) and the bare form (`mission:<id>`).
 */
export function missionIdOf(resourceId: string): string | null {
  const match = /^(?:.*#)?mission:(.+)$/.exec(resourceId);
  return match ? match[1]! : null;
}

export interface ReconcileInput {
  leases: readonly LeaseRecord[];
  liveSessions: ReadonlySet<string>;
  liveIncarnations: ReadonlySet<string>;
  missionStatuses: Readonly<Record<string, MissionStatus | string>>;
  nowMs: number;
}

/**
 * Decide the fate of every lease. Returns one verdict per lease sorted by
 * resourceId then sessionId. Rules apply in order, first match wins:
 *   1. two+ leases share a resourceId           → quarantine `duplicate_holder`
 *   2. session not registered                    → reclaim  `session_unregistered`
 *   3. incarnation not live                      → reclaim  `holder_incarnation_superseded`
 *   4. still inside its TTL                      → keep     `live`
 *   5. expired, non-mission resource             → reclaim  `lease_expired`
 *   6. expired, mission terminal                 → reclaim  `lease_expired_terminal`
 *   7. expired, mission unknown                  → quarantine `lease_expired_unknown_mission`
 *   8. expired, mission present but not terminal → quarantine `lease_expired_live_mission`
 */
export function reconcileLeases(input: ReconcileInput): LeaseVerdict[] {
  const { leases, liveSessions, liveIncarnations, missionStatuses, nowMs } = input;

  const verdicts: LeaseVerdict[] = [];
  for (const lease of leases) {
    const duplicates = leases.filter((l) => l.resourceId === lease.resourceId);
    let decision: LeaseDecision;
    let reason: LeaseReconcileReason;

    if (duplicates.length >= 2) {
      decision = "quarantine";
      reason = "duplicate_holder";
    } else if (!liveSessions.has(lease.sessionId)) {
      decision = "reclaim";
      reason = "session_unregistered";
    } else if (!liveIncarnations.has(incarnationKey(lease))) {
      decision = "reclaim";
      reason = "holder_incarnation_superseded";
    } else if (nowMs <= lease.expiresAtMs) {
      decision = "keep";
      reason = "live";
    } else {
      // Expired.
      const missionId = missionIdOf(lease.resourceId);
      if (missionId === null) {
        decision = "reclaim";
        reason = "lease_expired";
      } else if (TERMINAL_MISSION_STATUSES.has(missionStatuses[missionId] ?? "")) {
        decision = "reclaim";
        reason = "lease_expired_terminal";
      } else if (missionStatuses[missionId] === undefined) {
        decision = "quarantine";
        reason = "lease_expired_unknown_mission";
      } else {
        decision = "quarantine";
        reason = "lease_expired_live_mission";
      }
    }

    verdicts.push({
      resourceId: lease.resourceId,
      sessionId: lease.sessionId,
      generationId: lease.generationId,
      decision,
      reason,
    });
  }

  verdicts.sort((a, b) => {
    if (a.resourceId !== b.resourceId) return a.resourceId < b.resourceId ? -1 : 1;
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    return 0;
  });

  return verdicts;
}
