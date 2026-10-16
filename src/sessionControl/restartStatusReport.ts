/**
 * Pure adapter that maps LIVE registry {@link SessionRecord}s and mission
 * leases into the `computeRestartStatus` input. Never mutates inputs, never
 * throws on malformed records, and performs no I/O.
 */

import type { SessionRecord } from "../runtime/isolation/RuntimeRegistry.ts";
import {
  type RestartStatusOptions,
  type RestartStatusResult,
  type RestartStatusSession,
  computeRestartStatus,
} from "./restartStatus.ts";

/** A lease reference onto a mission-owned resource. */
export interface MissionLeaseRef {
  resourceId: string;
  sessionId: string;
}

const MISSION_PREFIX = "mission:";

/**
 * Extract the mission id from a lease resource id.
 *
 * A mission lease is recorded as `mission:<id>` or `<ns>#mission:<id>`.
 * The `mission:<id>` form yields `<id>` directly; the `<ns>#mission:<id>`
 * form strips through the first '#' first, then takes the part after
 * 'mission:'. Returns null when the resource id does not carry a mission.
 */
function missionIdFromResourceId(resourceId: string): string | null {
  let stripped = resourceId;
  const hashIndex = stripped.indexOf("#");
  if (hashIndex !== -1) {
    stripped = stripped.slice(hashIndex + 1);
  }
  if (!stripped.startsWith(MISSION_PREFIX)) return null;
  return stripped.slice(MISSION_PREFIX.length);
}

/**
 * Map LIVE registry SessionRecords and mission leases into the
 * computeRestartStatus input. Pure: no I/O, no Date.now, no input mutation.
 * Malformed records (null or lacking a string sessionId) are skipped.
 */
export function buildRestartStatusReport(
  sessions: readonly SessionRecord[],
  missionLeases: readonly MissionLeaseRef[],
  supervisorSessionId: string | null,
  now: Date,
  opts?: RestartStatusOptions,
): RestartStatusResult {
  // Build sessionId -> lexicographically smallest missionId map.
  const missionBySession = new Map<string, string>();
  if (Array.isArray(missionLeases)) {
    for (const lease of missionLeases) {
      if (!lease || typeof lease !== "object") continue;
      const { resourceId, sessionId } = lease as Record<string, unknown>;
      if (typeof resourceId !== "string" || typeof sessionId !== "string") continue;
      const missionId = missionIdFromResourceId(resourceId);
      if (missionId === null) continue;
      const current = missionBySession.get(sessionId);
      if (current === undefined || missionId < current) {
        missionBySession.set(sessionId, missionId);
      }
    }
  }

  const mapped: RestartStatusSession[] = [];
  if (Array.isArray(sessions)) {
    for (const record of sessions) {
      if (!record || typeof record !== "object") continue;
      const sessionId = (record as Record<string, unknown>).sessionId;
      if (typeof sessionId !== "string") continue;
      const state = (record as Record<string, unknown>).state;

      const role = supervisorSessionId !== null && sessionId === supervisorSessionId ? "supervisor" : "worker";

      let mappedState: "idle" | "running" | "paused" | "terminated";
      const missionId = missionBySession.get(sessionId);

      switch (state) {
        case "stopped":
        case "dead":
        case "orphaned":
          mappedState = "terminated";
          break;
        case "stopping":
          mappedState = "paused";
          break;
        case "starting":
        case "healthy":
        case "recovering":
        case "rebinding":
          mappedState = missionId !== undefined ? "running" : "idle";
          break;
        default:
          mappedState = "terminated";
          break;
      }

      const entry: RestartStatusSession = { sessionId, role, state: mappedState };
      if (missionId !== undefined) {
        entry.missionId = missionId;
      }

      const lastHeartbeatMs = (record as Record<string, unknown>).lastHeartbeatMs;
      if (typeof lastHeartbeatMs === "number" && Number.isFinite(lastHeartbeatMs)) {
        entry.lastHeartbeatAt = new Date(lastHeartbeatMs).toISOString();
      }

      mapped.push(entry);
    }
  }

  return computeRestartStatus(mapped, now, opts);
}
