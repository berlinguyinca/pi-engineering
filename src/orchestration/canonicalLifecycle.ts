/**
 * Canonical mission lifecycle projection (R-LIFE).
 *
 * pi-engineering is the sole lifecycle authority; AutoSpec and InferWeave read
 * the mission through this vocabulary. The mapping is purely additive: the
 * persisted `MissionStatus` values are never renamed, and the projection is a
 * total function over them. The state names mirror
 * `autospec-protocol-mission.v1` (`state` enum) so a snapshot consumer never
 * has to translate.
 */
import type { MissionStatus } from "./types.ts";

/** Version of this projection. Bump when a status changes its canonical image. */
export const LIFECYCLE_SCHEMA_VERSION = 1;

export type CanonicalLifecycleState =
  | "CREATED"
  | "PLANNED"
  | "READY"
  | "RUNNING"
  | "VALIDATING"
  | "REVIEWING"
  | "REPAIRING"
  | "MERGE_QUEUED"
  | "MERGING"
  | "MERGED"
  | "FINALIZING"
  | "ARCHIVED"
  | "BLOCKED"
  | "PAUSED"
  | "FAILED"
  | "CANCELLED"
  | "RECOVERING"
  | "RETAINED_FOR_DIAGNOSTICS";

// Keyed by MissionStatus so a new status is a compile error until it is mapped.
const PROJECTION: Record<MissionStatus, CanonicalLifecycleState> = {
  NEW: "CREATED",
  CLASSIFYING: "CREATED",
  PLANNING: "PLANNED",
  READY: "READY",
  QUEUED: "READY",
  STARTING: "RUNNING",
  EXECUTING: "RUNNING",
  INTEGRATING: "RUNNING",
  VALIDATING: "VALIDATING",
  REVIEWING: "REVIEWING",
  REPAIRING: "REPAIRING",
  FINAL_VALIDATION: "VALIDATING",
  // Never ARCHIVED: nothing proves the mission's resources were cleaned up yet.
  COMPLETE: "MERGED",
  WAITING_FOR_USER: "PAUSED",
  WAITING_FOR_LLM: "PAUSED",
  WAITING_FOR_CAPACITY: "PAUSED",
  WAITING_FOR_GATEWAY: "PAUSED",
  WAITING_FOR_MODEL: "PAUSED",
  WAITING_FOR_TOOL: "PAUSED",
  RECOVERING_CONTEXT: "RECOVERING",
  RECOVERING_PROCESS: "RECOVERING",
  PAUSED_INFRASTRUCTURE: "PAUSED",
  NEEDS_ATTENTION: "BLOCKED",
  BLOCKED: "BLOCKED",
  CANCELING: "CANCELLED",
  CANCELED: "CANCELLED",
  FAILED: "FAILED",
};

/** Project a persisted mission status onto its canonical lifecycle state. */
export function toCanonical(status: MissionStatus): CanonicalLifecycleState {
  return PROJECTION[status];
}

/**
 * Canonical states no `MissionStatus` projects onto yet. They become reachable
 * only through later work (merge queue, post-merge cleanup, diagnostic
 * retention); listing them keeps the gap explicit instead of implied.
 */
export const CANONICAL_ONLY_STATES: readonly CanonicalLifecycleState[] = [
  "MERGE_QUEUED",
  "MERGING",
  "FINALIZING",
  "ARCHIVED",
  "RETAINED_FOR_DIAGNOSTICS",
];

const CANONICAL_TERMINAL: ReadonlySet<CanonicalLifecycleState> = new Set<CanonicalLifecycleState>([
  "ARCHIVED",
  "FAILED",
  "CANCELLED",
]);

/** MERGED is not terminal: a merged mission still owes finalization and archival. */
export function isCanonicalTerminal(state: CanonicalLifecycleState): boolean {
  return CANONICAL_TERMINAL.has(state);
}
