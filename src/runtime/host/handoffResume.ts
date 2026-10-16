/**
 * Pure, deterministic resume decision for a handoff (spec: handoff resume).
 *
 * After a supervisor or child rollover, nothing durable decides whether a handoff
 * may be resumed. This module closes that gap: it fences the handoff against the
 * current mission generation lease, verifies the observed checkpoint/source shas,
 * and refuses to replay external side effects that were never committed. It is
 * pure data — no I/O, no storage — and never mutates its input.
 */

import type { MissionLease } from "../../orchestration/types.ts";
import type { HandoffRecord } from "./handoffKinds.ts";

/** The kinds of external side effect a handoff may have performed. */
export type SideEffectKind = "push" | "pr_create" | "merge" | "comment" | "other";

/** One external side effect observed during the handoff, with its commit state. */
export interface HandoffSideEffect {
  id: string;
  kind: SideEffectKind;
  committed: boolean;
}

/** The decision a caller may act on. */
export type HandoffResumeDecision = "resume" | "restart_fresh" | "refuse";

/** The inputs to a resume decision. */
export interface HandoffResumeInput {
  record: HandoffRecord;
  currentLease: Pick<MissionLease, "generation">;
  observedCheckpointSha: string | null;
  expectedSourceSha: string | null;
  observedSourceSha: string | null;
  sideEffects: readonly HandoffSideEffect[];
  nowMs: number;
  maxAgeMs: number;
}

/**
 * Decide whether a handoff may be resumed. Collects EVERY applicable reason in a
 * fixed order and picks the strongest outcome (refuse > restart_fresh > resume).
 * Never throws on malformed input: missing fields simply fail the relevant check.
 */
export function decideHandoffResume(input: HandoffResumeInput): { decision: HandoffResumeDecision; reasons: string[] } {
  const reasons: string[] = [];
  let refuse = false;
  let restartFresh = false;

  const { record, currentLease, observedCheckpointSha, expectedSourceSha, observedSourceSha } = input;

  // --- REFUSE reasons (in order) ---

  if (record.state === "aborted") {
    refuse = true;
    reasons.push("handoff aborted");
  }

  if (record.state !== "acknowledged" && record.state !== "committed") {
    refuse = true;
    reasons.push(`handoff not acknowledged (state ${record.state})`);
  }

  const generation = (record.successor ?? record.predecessor).generation;
  if (generation < currentLease.generation) {
    refuse = true;
    reasons.push(`stale generation ${generation} < ${currentLease.generation}`);
  }

  if (
    record.checkpointSha !== undefined &&
    observedCheckpointSha !== null &&
    record.checkpointSha !== observedCheckpointSha
  ) {
    refuse = true;
    reasons.push("checkpoint sha mismatch");
  }

  if (expectedSourceSha !== null && observedSourceSha !== null && expectedSourceSha !== observedSourceSha) {
    refuse = true;
    reasons.push("source sha mismatch");
  }

  for (const effect of input.sideEffects) {
    if (effect.committed === false) {
      refuse = true;
      reasons.push(`uncommitted side effect ${effect.id}`);
    }
  }

  // --- RESTART_FRESH reasons (in order) ---

  if (record.checkpointSha === undefined || observedCheckpointSha === null) {
    restartFresh = true;
    reasons.push("no checkpoint");
  }

  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created) || input.nowMs - created > input.maxAgeMs) {
    restartFresh = true;
    reasons.push("handoff older than maxAgeMs");
  }

  // --- outcome ---

  const decision: HandoffResumeDecision = refuse ? "refuse" : restartFresh ? "restart_fresh" : "resume";
  return { decision, reasons };
}
