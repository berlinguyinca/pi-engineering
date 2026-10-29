/**
 * Phase-boundary handoff decision logic (spec Unit B1, issue #349).
 *
 * When a mission crosses a phase boundary under context pressure, a
 * `phase_transition` HandoffRecord is emitted so a fresh session can resume
 * from the artifact instead of letting context balloon to native compaction.
 * Native compaction is demoted to fallback only: it is selected (via the
 * standard handoff-fallback rules) when the handoff cannot be emitted.
 *
 * This module is pure: no I/O, no top-level Date.now (the clock is injectable
 * for deterministic ids), no classes, never mutates its inputs.
 */

import { DEFAULT_CONTEXT_THRESHOLDS } from "../context/thresholds.ts";
import type { HandoffEndpoint } from "../runtime/host/handoffKinds.ts";
import { type HandoffFallback, decideHandoffFallback } from "../runtime/host/handoffRecovery.ts";

/**
 * Context-utilization ratio at/above which a boundary triggers a handoff: the `soft` level of the one threshold triple
 * (context/thresholds.ts). A phase boundary is a free safe point, so it hands off at `soft` rather than waiting for
 * `preferred`. (Was a separate 0.75.)
 */
export const PHASE_HANDOFF_THRESHOLD = DEFAULT_CONTEXT_THRESHOLDS.soft;

/** The execution fields the utilization computation needs. */
export interface PhaseHandoffExecution {
  model: string | null;
  usage: Record<string, unknown>;
}

/** Resolves a model id to its context window (tokens), or null/undefined when unknown. */
export type ContextWindowResolver = (model: string) => number | null | undefined;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Latest context-utilization ratio across the mission's executions, in [0, 1].
 *
 * For each execution whose model resolves to a positive context window, the
 * context actually sent to the model (`usage.contextTokens`, falling back to
 * cumulative `usage.input`) is divided by the window. The maximum across
 * executions wins (the hottest session is the pressure signal). Returns null
 * when no execution carries usable usage data — no guess, no control effect.
 */
export function missionContextUtilization(
  executions: readonly PhaseHandoffExecution[],
  contextWindow: ContextWindowResolver,
): number | null {
  let best: number | null = null;
  for (const execution of executions) {
    if (!execution.model) continue;
    const window = contextWindow(execution.model);
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    const usage = execution.usage ?? {};
    const contextTokens = typeof usage.contextTokens === "number" ? usage.contextTokens : null;
    const input = typeof usage.input === "number" ? usage.input : null;
    const tokens = contextTokens ?? input;
    if (tokens === null || tokens <= 0) continue;
    const ratio = clamp01(tokens / window);
    best = best === null ? ratio : Math.max(best, ratio);
  }
  return best;
}

export interface PhaseHandoffDecisionInput {
  /** The phase the mission was in before the transition (null = mission start). */
  fromPhase: string | null;
  /** The phase the mission is moving to. */
  toPhase: string;
  /** Current context utilization, or null when no data is available. */
  contextUtilization: number | null;
  /** Utilization at/above which the boundary hands off. Default 0.70 (the soft level). */
  threshold?: number;
}

export interface PhaseHandoffDecision {
  emit: boolean;
  reason: string;
}

/**
 * Decide whether a phase transition should emit a `phase_transition` handoff.
 *
 * A handoff is emitted only when ALL hold: the transition actually crosses a
 * boundary between two phases (a mission start, fromPhase null, has no
 * predecessor session to hand off), utilization data exists, and the
 * utilization is at or above the threshold. Without a signal the boundary
 * passes silently and the existing compaction behaviour remains in force.
 */
export function shouldEmitPhaseHandoff(input: PhaseHandoffDecisionInput): PhaseHandoffDecision {
  const threshold = input.threshold ?? PHASE_HANDOFF_THRESHOLD;
  if (input.fromPhase === null) {
    return { emit: false, reason: "mission start, no predecessor phase" };
  }
  if (input.toPhase === input.fromPhase) {
    return { emit: false, reason: "not a phase boundary" };
  }
  if (input.contextUtilization === null) {
    return { emit: false, reason: "no context utilization data" };
  }
  if (input.contextUtilization >= threshold) {
    return { emit: true, reason: `context utilization ${input.contextUtilization.toFixed(2)} >= ${threshold}` };
  }
  return { emit: false, reason: `context utilization ${input.contextUtilization.toFixed(2)} below ${threshold}` };
}

export interface PhaseTransitionRecordInput {
  missionId: string;
  fromPhase: string | null;
  toPhase: string;
  /** The session handing off (predecessor endpoint of the record). */
  endpoint: HandoffEndpoint;
  /** Checkpoint SHA the successor resumes from, when one exists. */
  checkpointSha?: string;
  /** Injectable clock (deterministic ids in tests). */
  now?: () => Date;
}

/**
 * Build a `phase_transition` HandoffRecord in the `prepared` state. The phase
 * pair and predecessor generation are encoded in the id for traceability (the
 * fixed record shape has no free-text fields); the successor endpoint and
 * `ackAt` are filled in when the fresh session acknowledges the handoff.
 * The returned object passes `validateHandoffRecord` unmodified.
 */
export function buildPhaseTransitionRecord(input: PhaseTransitionRecordInput): Record<string, unknown> {
  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const id = [
    "ho",
    input.missionId,
    input.fromPhase ?? "start",
    input.toPhase,
    `gen${input.endpoint.generation}`,
    timestamp.replace(/[:.]/g, ""),
  ].join("-");
  const record: Record<string, unknown> = {
    id,
    kind: "phase_transition",
    state: "prepared",
    missionId: input.missionId,
    predecessor: { sessionId: input.endpoint.sessionId, generation: input.endpoint.generation },
    createdAt: timestamp,
  };
  if (input.checkpointSha !== undefined) {
    record.checkpointSha = input.checkpointSha;
  }
  return record;
}

/**
 * Fallback decision when a boundary handoff cannot be emitted: the failed
 * record is treated as a refused resume, so the standard handoff-fallback
 * rules apply — `selective_compaction` under context pressure (>= 0.75),
 * `fresh_restart` otherwise. This keeps native compaction as fallback only.
 */
export function phaseHandoffFallback(
  errors: readonly string[],
  contextUtilization: number | null,
): { fallback: HandoffFallback; reason: string } {
  return decideHandoffFallback({
    resumeDecision: "refuse",
    resumeReasons: errors,
    contextUtilization,
  });
}
