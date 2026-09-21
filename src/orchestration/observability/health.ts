/**
 * Mission health derivation (spec 03).
 *
 * Health is derived deterministically from mission state, waiting reason, and
 * the independent heartbeat vs meaningful-progress timestamps. A live heartbeat
 * without meaningful progress can become SLOW or STALLED. A legitimate waiting
 * state (queue, tests, scheduler, external resource) is WAITING, never STALLED.
 */

import type { MissionStatus } from "../types.ts";
import type { MissionHealth, WaitingReason } from "./types.ts";

export interface HealthInput {
  missionStatus: MissionStatus;
  waitingReason?: WaitingReason;
  blocked: boolean;
  failed: boolean;
  complete: boolean;
  verifiedComplete: boolean;
  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;
  slowAfterMs: number;
  stallAfterMs: number;
  now?: string;
  /** True when a worker is actually alive/running (has a recent heartbeat). */
  alive: boolean;
}

export interface HealthResult {
  health: MissionHealth;
  waitingReason?: WaitingReason;
}

/** Age in ms of an ISO timestamp relative to now (undefined when absent). */
function ageMs(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, now - t);
}

export function deriveHealth(input: HealthInput): HealthResult {
  const now = input.now ? Date.parse(input.now) : Date.now();

  if (input.complete || input.verifiedComplete) return { health: "complete" };
  if (input.failed) return { health: "failed" };
  if (input.blocked) return { health: "blocked" };

  // A named waiting reason is authoritative: a genuine wait is not a stall.
  if (input.waitingReason) return { health: "waiting", waitingReason: input.waitingReason };

  // Mission is terminal-ish without explicit flags: treat COMPLETE/FAILED.
  if (input.missionStatus === "COMPLETE") return { health: "complete" };
  if (input.missionStatus === "FAILED") return { health: "failed" };
  if (input.missionStatus === "BLOCKED" || input.missionStatus === "CANCELED") {
    return { health: input.missionStatus === "BLOCKED" ? "blocked" : "complete" };
  }
  if (input.missionStatus === "WAITING_FOR_USER") {
    return { health: "waiting", waitingReason: "human_approval" };
  }

  // Meaningful-progress age drives SLOW/STALLED. Heartbeat alone is not progress.
  const progressAge = ageMs(input.lastMeaningfulProgressAt, now);
  if (progressAge !== undefined) {
    if (progressAge > input.stallAfterMs && input.alive) return { health: "stalled" };
    if (progressAge > input.slowAfterMs) return { health: "slow" };
  } else if (input.alive) {
    // No meaningful progress ever recorded but worker alive: watch it.
    const heartbeatAge = ageMs(input.lastHeartbeatAt, now);
    if (heartbeatAge !== undefined && heartbeatAge > input.stallAfterMs) return { health: "stalled" };
    return { health: "slow" };
  }

  return { health: "active" };
}
