/**
 * Pure handoff resume decision (HAND-003/HAND-004/HAND-006).
 *
 * Decides whether the current generation may resume from a durable handoff
 * record, and if not, why. This module is pure: no I/O, no wall clock, no
 * mutation of its input. It inspects a `HandoffResumeInput` snapshot and
 * returns a `HandoffResumeDecision` with every applicable reason collected in
 * a fixed, mandated order and the strongest outcome (refuse > restart_fresh >
 * resume).
 *
 * Refuse reasons are collected in this order:
 *   1. aborted handoff                                   → "handoff aborted"
 *   2. prepared handoff (never validated)                 → "handoff not prepared for resume"
 *   3. stale generation (lease generation > successor)    → "stale generation (lease N, successor M)"
 *   4. checkpoint mismatch (lease sha != record sha)      → "checkpoint mismatch"
 *   5. source mismatch (resuming session != source)       → "source session mismatch"
 *   6. uncommitted push-1 side effect                     → "uncommitted side effect push-1"
 *
 * Then restart_fresh reasons (only meaningful once no refuse reason blocks):
 *   7. no recorded checkpoint                            → "no checkpoint"
 *   8. handoff older than maxAgeMs (or createdAt missing / unparseable)
 *                                                         → "handoff older than maxAgeMs"
 *
 * Committed side effects never block. Malformed or missing fields fail the
 * relevant check rather than throwing, and the input is never mutated.
 */

/** The kinds of side effects a handoff may record as having performed. */
export const SIDE_EFFECT_KINDS = ["push-1", "checkpoint", "merge", "deploy"] as const;
export type SideEffectKind = (typeof SIDE_EFFECT_KINDS)[number];

/** One recorded side effect of a handoff. */
export interface HandoffSideEffect {
  kind: SideEffectKind;
  committed: boolean;
}

/** The outcome of a handoff resume decision. */
export type HandoffResumeDecision = "refuse" | "restart_fresh" | "resume";

/** The pure decision output. */
export interface HandoffResumeOutput {
  decision: HandoffResumeDecision;
  reasons: string[];
}

/** The immutable snapshot the decision is computed from. */
export interface HandoffResumeInput {
  /** Handoff record state, if present. */
  state?: string;
  /** Generation that holds the lease for this handoff. */
  leaseGeneration?: number;
  /** Generation that succeeds the handoff (the generation resuming). */
  successorGeneration?: number;
  /** Checkpoint SHA on the lease, if present. */
  leaseCheckpointSha?: string;
  /** Checkpoint SHA recorded on the handoff, if present. */
  recordCheckpointSha?: string;
  /** Session that recorded the handoff (the source session). */
  sourceSessionId?: string;
  /** Session resuming from the handoff. */
  resumingSessionId?: string;
  /** Side effects recorded on the handoff. */
  sideEffects?: readonly HandoffSideEffect[];
  /** ISO-8601 creation timestamp of the handoff, if present. */
  createdAt?: string;
  /** Maximum allowed handoff age in milliseconds; when unset, age is not checked. */
  maxAgeMs?: number;
  /** Wall-clock reference for the age check, in milliseconds since epoch. */
  nowMs: number;
}

/** Parse an ISO-8601 timestamp to epoch ms; NaN when unparseable. */
function parseIsoMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Decide whether the current generation may resume from a handoff. Collects
 * every applicable reason in mandated order (refuse reasons first, then
 * restart_fresh reasons) and returns the strongest outcome (refuse >
 * restart_fresh > resume). Pure and defensive: it never mutates the input and
 * never throws on malformed or missing fields.
 */
export function decideHandoffResume(input: HandoffResumeInput): HandoffResumeOutput {
  const refuseReasons: string[] = [];
  const restartReasons: string[] = [];

  const state = input.state;
  if (state !== undefined) {
    if (state === "aborted") {
      refuseReasons.push("handoff aborted");
    } else if (state === "prepared") {
      refuseReasons.push("handoff not prepared for resume");
    }
  }

  const leaseGeneration = input.leaseGeneration;
  const successorGeneration = input.successorGeneration;
  if (leaseGeneration !== undefined && successorGeneration !== undefined) {
    const leaseGen = Number(leaseGeneration);
    const successorGen = Number(successorGeneration);
    if (Number.isInteger(leaseGen) && Number.isInteger(successorGen) && leaseGen > successorGen) {
      refuseReasons.push(`stale generation (lease ${leaseGen}, successor ${successorGen})`);
    }
  }

  const leaseCheckpointSha = input.leaseCheckpointSha;
  const recordCheckpointSha = input.recordCheckpointSha;
  if (
    leaseCheckpointSha !== undefined &&
    recordCheckpointSha !== undefined &&
    leaseCheckpointSha.length > 0 &&
    recordCheckpointSha.length > 0 &&
    leaseCheckpointSha !== recordCheckpointSha
  ) {
    refuseReasons.push("checkpoint mismatch");
  }

  const sourceSessionId = input.sourceSessionId;
  const resumingSessionId = input.resumingSessionId;
  if (sourceSessionId !== undefined && resumingSessionId !== undefined && sourceSessionId !== resumingSessionId) {
    refuseReasons.push("source session mismatch");
  }

  const sideEffects = input.sideEffects;
  if (sideEffects !== undefined && Array.isArray(sideEffects)) {
    const hasUncommittedPush1 = sideEffects.some((se) => se && se.kind === "push-1" && se.committed === false);
    if (hasUncommittedPush1) {
      refuseReasons.push("uncommitted side effect push-1");
    }
  }

  // restart_fresh reasons.
  const recordSha = input.recordCheckpointSha;
  if (recordSha === undefined || recordSha.length === 0) {
    restartReasons.push("no checkpoint");
  } else {
    const createdMs = input.createdAt === undefined ? Number.NaN : parseIsoMs(input.createdAt);
    const maxAgeMs = input.maxAgeMs;
    const tooOld =
      Number.isNaN(createdMs) ||
      (maxAgeMs !== undefined && Number(maxAgeMs) >= 0 && input.nowMs - createdMs > Number(maxAgeMs));
    if (tooOld) {
      restartReasons.push("handoff older than maxAgeMs");
    }
  }

  const decision: HandoffResumeDecision =
    refuseReasons.length > 0 ? "refuse" : restartReasons.length > 0 ? "restart_fresh" : "resume";

  return { decision, reasons: [...refuseReasons, ...restartReasons] };
}
