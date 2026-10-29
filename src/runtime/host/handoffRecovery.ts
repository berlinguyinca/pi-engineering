/**
 * Pure, deterministic handoff recovery: reconcile observed external side effects
 * after a failed handoff and decide how to fall back. This module is pure data —
 * no I/O, no Date.now, no classes, never mutates its inputs, and never throws.
 * It complements handoffResume.ts: resume decides whether a handoff may resume;
 * recovery decides what to do when it cannot.
 */

import { DEFAULT_CONTEXT_THRESHOLDS } from "../../context/thresholds.ts";
import type { HandoffResumeDecision, HandoffSideEffect } from "./handoffResume.ts";

/** Whether an external side effect was observed after the failed handoff. */
export type EffectObservation = "present" | "absent" | "unknown";

/** What the reconciler concludes a side effect requires. */
export type EffectVerdict = "skip_replay" | "replay" | "manual";

/** Per-effect reconciliation result. */
export interface EffectReconciliation {
  id: string;
  verdict: EffectVerdict;
  reason: string;
}

/**
 * Reconcile the side effects a handoff may have performed against what was
 * actually observed. Verdicts preserve input order. Rules, in order:
 *
 *   1. committed === true                      -> skip_replay "already committed"
 *   2. uncommitted + "present"                 -> skip_replay "observed present externally"
 *   3. uncommitted + "absent" + kind in
 *      push | pr_create | comment | other      -> replay "observed absent"
 *   4. uncommitted + "absent" + kind "merge"   -> manual "merge never auto-replayed"
 *   5. uncommitted + "unknown"/missing         -> manual "observation unavailable"
 *
 * A missing observation key is treated as "unknown". `replaySafe` is false if
 * any verdict is "manual".
 */
export function reconcileSideEffects(
  effects: readonly HandoffSideEffect[],
  observed: Readonly<Record<string, EffectObservation>>,
): { verdicts: EffectReconciliation[]; replaySafe: boolean } {
  let replaySafe = true;
  const verdicts: EffectReconciliation[] = [];

  for (const effect of effects) {
    const id = effect.id;
    if (effect.committed === true) {
      verdicts.push({ id, verdict: "skip_replay", reason: "already committed" });
      continue;
    }

    const obs = observed[id] === undefined ? "unknown" : observed[id];

    if (obs === "present") {
      verdicts.push({ id, verdict: "skip_replay", reason: "observed present externally" });
      continue;
    }

    if (obs === "absent") {
      if (effect.kind === "merge") {
        verdicts.push({ id, verdict: "manual", reason: "merge never auto-replayed" });
        replaySafe = false;
      } else {
        verdicts.push({ id, verdict: "replay", reason: "observed absent" });
      }
      continue;
    }

    // unknown / missing observation
    verdicts.push({ id, verdict: "manual", reason: "observation unavailable" });
    replaySafe = false;
  }

  return { verdicts, replaySafe };
}

/** Fallback strategy after a handoff cannot be resumed. */
export type HandoffFallback = "none" | "selective_compaction" | "fresh_restart";

/** Inputs to the fallback decision. */
export interface HandoffFallbackInput {
  resumeDecision: HandoffResumeDecision;
  resumeReasons: readonly string[];
  contextUtilization: number | null;
  /**
   * Utilization at/above which a failed handoff counts as "under context pressure". Defaults to the `soft` level of the
   * one configured threshold triple (context/thresholds.ts); callers with per-model configuration pass theirs.
   */
  pressureThreshold?: number;
}

/** Decide the fallback strategy. First match wins. */
export function decideHandoffFallback(input: HandoffFallbackInput): { fallback: HandoffFallback; reason: string } {
  if (input.resumeDecision === "resume") {
    return { fallback: "none", reason: "resume allowed" };
  }

  for (const reason of input.resumeReasons) {
    if (reason.startsWith("uncommitted side effect")) {
      return { fallback: "fresh_restart", reason: "unreconciled side effects" };
    }
  }

  if (
    (input.resumeDecision === "restart_fresh" || input.resumeDecision === "refuse") &&
    input.contextUtilization !== null &&
    input.contextUtilization >= (input.pressureThreshold ?? DEFAULT_CONTEXT_THRESHOLDS.soft)
  ) {
    return { fallback: "selective_compaction", reason: "context pressure after failed handoff" };
  }

  return { fallback: "fresh_restart", reason: "handoff failed without context pressure" };
}
