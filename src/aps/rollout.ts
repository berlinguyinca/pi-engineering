/**
 * APS Phase 6 — rollout.
 *
 * Progressive-enablement gate: each phase's enforcement is exposed as a boolean
 * so operators can roll APS out incrementally (detection → prevention →
 * recovery → escalation → full observability) rather than all-at-once.
 *
 *   Phase 1-2: detection only (loop_candidate events)
 *   Phase 3:   loop prevention (abort a sustained loop)
 *   Phase 4:   recovery (replan / conservative compaction)
 *   Phase 5:   escalation (model / human)
 *   Phase 6:   full enforcement + observability aggregation
 */

export type ApsRolloutPhase = 1 | 2 | 3 | 4 | 5 | 6;

export interface ApsRollout {
  phase: ApsRolloutPhase;
  /** loop_candidate detection (Phases 1-2). Always on for phase >= 1. */
  detection: boolean;
  /** loop prevention enforcement (Phase 3). */
  prevention: boolean;
  /** recovery (Phase 4). */
  recovery: boolean;
  /** escalation (Phase 5). */
  escalation: boolean;
  /** observability aggregation (Phase 6). */
  observability: boolean;
}

/** Resolve the set of enabled APS features for a given rollout phase. */
export function resolveRollout(phase: ApsRolloutPhase): ApsRollout {
  return {
    phase,
    detection: phase >= 1,
    prevention: phase >= 3,
    recovery: phase >= 4,
    escalation: phase >= 5,
    observability: phase >= 6,
  };
}

/** The default rollout phase — full enforcement + observability. */
export const DEFAULT_ROLLOUT_PHASE: ApsRolloutPhase = 6;
