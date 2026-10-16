import type { ResourceKind, ResourceRecord } from "./ResourceRegistry.ts";

/**
 * Pure eligibility decision for garbage collection of registered resources
 * (autospec R-RES, RESOURCE-002/RESOURCE-004/RESOURCE-005, issue #277).
 *
 * This module is deliberately free of I/O, git, clocks and environment access:
 * it takes a snapshot of entries and sets and returns a deterministic decision
 * for every entry. Callers (the pressure GC, the worktree janitor, future
 * housekeeping) supply the current host id, mission states, live leases and the
 * pressure level; nothing here observes the outside world.
 *
 * Decisions are evaluated in a fixed rule order per entry (first match wins).
 * A retained/failed-owner diagnostic is protected for `failureRetentionMs` no
 * matter the pressure (hard pressure never overrides that). An owner that is in
 * none of the known sets fails closed (`owner_unknown`), mirroring how the
 * worktree janitor keeps unknown owners until they idle out.
 */

export type GcPressure = "none" | "soft" | "hard";

export interface GcEntry {
  record: ResourceRecord;
  /** Milliseconds since the resource was last used (caller measures it). */
  lastUsedMs: number;
}

export interface GcEligibilityInput {
  entries: readonly GcEntry[];
  hostId: string;
  activeMissionIds: ReadonlySet<string>;
  failedMissionIds: ReadonlySet<string>;
  terminalMissionIds: ReadonlySet<string>;
  liveLeases: ReadonlySet<string>;
  nowMs: number;
  minIdleMs: number;
  failureRetentionMs: number;
  pressure: GcPressure;
  kinds?: ReadonlySet<ResourceKind>;
}

export interface GcDecision {
  id: string;
  reason: string;
}

/** Kinds the GC may consider collectable when `kinds` is not supplied. */
export const DEFAULT_GC_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>(["build_dir", "cache", "worktree"]);

/**
 * Classifies every entry into exactly one of `delete` or `retain`, applying the
 * rule order described in the module doc. The input is never mutated. `delete`
 * is deterministically ordered by pressure; `retain` is sorted by id.
 */
export function selectGcCandidates(input: GcEligibilityInput): {
  delete: GcDecision[];
  retain: GcDecision[];
} {
  const kinds = input.kinds ?? DEFAULT_GC_KINDS;
  const retain: GcDecision[] = [];
  const deleteList: GcDecision[] = [];

  for (const { record, lastUsedMs } of input.entries) {
    const decision: GcDecision = { id: record.id, reason: "" };

    if (!kinds.has(record.kind)) {
      decision.reason = "kind_not_collectable";
    } else if (record.state === "released" || record.state === "releasing") {
      decision.reason = "not_releasable_state";
    } else if (record.hostId !== input.hostId) {
      decision.reason = "foreign_host";
    } else if (input.activeMissionIds.has(record.ownerMissionId)) {
      decision.reason = "mission_active";
    } else if (input.liveLeases.has(record.lease)) {
      decision.reason = "lease_live";
    } else if (
      (record.state === "retained" || input.failedMissionIds.has(record.ownerMissionId)) &&
      input.nowMs - lastUsedMs < input.failureRetentionMs
    ) {
      decision.reason = "diagnostics_retained";
    } else if (
      !input.activeMissionIds.has(record.ownerMissionId) &&
      !input.failedMissionIds.has(record.ownerMissionId) &&
      !input.terminalMissionIds.has(record.ownerMissionId)
    ) {
      decision.reason = "owner_unknown";
    } else if (input.nowMs - lastUsedMs < input.minIdleMs) {
      decision.reason = "recently_used";
    } else if (input.pressure === "none") {
      decision.reason = "no_pressure";
    } else {
      decision.reason = "idle_unreferenced";
    }

    if (decision.reason === "idle_unreferenced") {
      deleteList.push(decision);
    } else {
      retain.push(decision);
    }
  }

  if (input.pressure === "hard") {
    deleteList.sort((a, b) => {
      const aBytes = bytesOf(a.id, input.entries);
      const bBytes = bytesOf(b.id, input.entries);
      return (
        bBytes - aBytes || lastUsedOf(a.id, input.entries) - lastUsedOf(b.id, input.entries) || a.id.localeCompare(b.id)
      );
    });
  } else {
    deleteList.sort((a, b) => {
      const aUsed = lastUsedOf(a.id, input.entries);
      const bUsed = lastUsedOf(b.id, input.entries);
      return aUsed - bUsed || a.id.localeCompare(b.id);
    });
  }
  retain.sort((a, b) => a.id.localeCompare(b.id));

  return { delete: deleteList, retain };
}

function bytesOf(id: string, entries: readonly GcEntry[]): number {
  const entry = entries.find((e) => e.record.id === id);
  return entry?.record.bytes ?? 0;
}

function lastUsedOf(id: string, entries: readonly GcEntry[]): number {
  const entry = entries.find((e) => e.record.id === id);
  return entry?.lastUsedMs ?? 0;
}
