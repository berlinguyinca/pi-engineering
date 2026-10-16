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

/** True when a value is a non-null object (records, leases, side-effect entries). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Decide whether a handoff may be resumed. Collects EVERY applicable reason in a
 * fixed order and picks the strongest outcome (refuse > restart_fresh > resume).
 * Never throws on malformed input: missing fields simply fail the relevant check
 * and fail closed.
 */
export function decideHandoffResume(input: HandoffResumeInput): { decision: HandoffResumeDecision; reasons: string[] } {
  const reasons: string[] = [];
  let refuse = false;
  let restartFresh = false;

  // Defensively treat the top-level inputs as possibly missing/non-object.
  const record = isObject(input.record) ? input.record : null;
  const currentLease = isObject(input.currentLease) ? input.currentLease : null;
  const observedCheckpointSha = input.observedCheckpointSha;
  const expectedSourceSha = input.expectedSourceSha;
  const observedSourceSha = input.observedSourceSha;
  const nowMs = input.nowMs;
  const maxAgeMs = input.maxAgeMs;

  // --- REFUSE reasons (in order) ---

  if (record === null) {
    refuse = true;
    reasons.push("handoff record missing");
  }

  const leaseGeneration = currentLease === null ? Number.NaN : Number(currentLease.generation);
  if (!Number.isFinite(leaseGeneration)) {
    refuse = true;
    reasons.push("lease generation unknown");
  }

  if (record !== null && record.state === "aborted") {
    refuse = true;
    reasons.push("handoff aborted");
  }

  if (
    record !== null &&
    record.state !== "aborted" &&
    record.state !== "acknowledged" &&
    record.state !== "committed"
  ) {
    refuse = true;
    reasons.push(`handoff not acknowledged (state ${record.state})`);
  }

  if (record !== null) {
    const successor = isObject(record.successor) ? record.successor : null;
    const predecessor = isObject(record.predecessor) ? record.predecessor : null;
    const endpoint = successor ?? predecessor;
    const g = endpoint === null ? Number.NaN : Number(endpoint.generation);
    if (!Number.isInteger(g)) {
      if (Number.isFinite(leaseGeneration)) {
        refuse = true;
        reasons.push(`stale generation unknown < ${leaseGeneration}`);
      }
    } else if (g < leaseGeneration) {
      refuse = true;
      reasons.push(`stale generation ${g} < ${leaseGeneration}`);
    }
  }

  if (
    record !== null &&
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

  // Treat sideEffects defensively: non-arrays are treated as empty, but any
  // null/non-object entry is itself a refusal, and any entry whose `committed`
  // is not exactly true counts as uncommitted.
  const sideEffects = Array.isArray(input.sideEffects) ? input.sideEffects : [];
  for (const effect of sideEffects) {
    if (!isObject(effect)) {
      refuse = true;
      reasons.push("malformed side effect");
      continue;
    }
    if (effect.committed !== true) {
      refuse = true;
      const id = typeof effect.id === "string" ? effect.id : "?";
      reasons.push(`uncommitted side effect ${id}`);
    }
  }

  // --- RESTART_FRESH reasons (in order) ---

  if (record !== null && (record.checkpointSha === undefined || observedCheckpointSha === null)) {
    restartFresh = true;
    reasons.push("no checkpoint");
  }

  // nowMs / maxAgeMs must be finite for the age check to be meaningful.
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs)) {
    restartFresh = true;
    reasons.push("handoff age unknown");
  } else if (record !== null) {
    const created = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
    if (!Number.isFinite(created) || nowMs - created > maxAgeMs) {
      restartFresh = true;
      reasons.push("handoff older than maxAgeMs");
    }
  }

  // --- outcome ---

  const decision: HandoffResumeDecision = refuse ? "refuse" : restartFresh ? "restart_fresh" : "resume";
  return { decision, reasons };
}
