/**
 * APS Phase 5 — escalation.
 *
 * When an agent loops again AFTER recovery (Phase 4) has already been applied —
 * i.e. a sustained no-progress run survives a replan/compact attempt — the run
 * is escalated to a stronger capability tier instead of silently failing:
 *
 *   - model escalation: the next attempt runs on a distinct model (optionally a
 *     pinned escalation model), via a fresh session with an escalation prompt;
 *   - human escalation: if no distinct model is available, the run is surfaced
 *     with `escalated_to_human: true` so an operator can intervene.
 *
 * Escalation is bounded (default once per run, configurable) and deterministic.
 * Selecting a more capable model by capability is InferWeave's domain; here we
 * resolve a distinct model (optionally the pinned escalation model) and leave
 * tiering to the runtime's model catalog.
 */

export interface EscalationOptions {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Max model escalations per run. Default 1. */
  maxEscalationsPerRun?: number;
  /** Loop preventions (this run) after which to escalate. Default 1. */
  escalateAfterPreventions?: number;
  /** Optional pinned escalation model id. When set, prefer this distinct model. */
  preferredEscalationModelId?: string;
}

export const DEFAULT_ESCALATION: Required<Omit<EscalationOptions, "preferredEscalationModelId">> & {
  preferredEscalationModelId?: string;
} = {
  enabled: true,
  maxEscalationsPerRun: 1,
  escalateAfterPreventions: 1,
  preferredEscalationModelId: undefined,
};

/** Structured escalation telemetry (spec §21-style observability event). */
export interface EscalationEvent {
  type: "agent.escalation";
  event_id: string;
  timestamp: string;
  sessionId: string;
  runId: string;
  workItemId: string | null;
  role: string;
  tier: number;
  fromModel: string;
  toModel: string | null;
  reason: string;
  attempt: number;
  escalatedToHuman: boolean;
  humanReviewRequested: boolean;
}

let escalationEventSeq = 0;

/** Decide whether a run should escalate given its loop/recovery history. */
export function shouldEscalate(
  preventionCount: number,
  escalatedCount: number,
  options: EscalationOptions = {},
): boolean {
  const opts = { ...DEFAULT_ESCALATION, ...options };
  if (!opts.enabled) return false;
  if (preventionCount < opts.escalateAfterPreventions) return false;
  return escalatedCount < opts.maxEscalationsPerRun;
}

/**
 * Resolve a distinct escalation model.
 *
 * @param currentModelId The model the run is currently on.
 * @param candidates Available models (with an `id`).
 * @param preferred Preferred escalation model id (may be undefined).
 * @returns A distinct model, preferring the pinned escalation model when
 *          present and not identical to the current one; else null.
 */
export function selectEscalationModel(
  currentModelId: string | undefined,
  candidates: readonly { id?: string }[],
  preferred?: string,
): { id: string } | null {
  const distinct = candidates.filter((c) => c.id !== undefined && c.id !== currentModelId);
  if (distinct.length === 0) return null;
  if (preferred !== undefined) {
    const pinned = distinct.find((c) => c.id === preferred);
    if (pinned) return { id: pinned.id! };
  }
  const first = distinct[0];
  return first === undefined ? null : { id: first.id! };
}

/** Build the escalation prompt for the escalated model's fresh attempt. */
export function buildEscalationPrompt(reason: string): string {
  return `[APS escalation] The prior model looped repeatedly and its recovery attempt did not help.
You are a more capable escalation model. Re-examine the task from scratch,
reconsider the target, and take a genuinely different, decisive approach. Reason: ${reason}`;
}

/** Build an EscalationEvent. */
export function buildEscalationEvent(input: {
  sessionId: string;
  runId: string;
  workItemId: string | null;
  role: string;
  fromModel: string;
  toModel: string | null;
  reason: string;
  attempt: number;
}): EscalationEvent {
  escalationEventSeq += 1;
  return {
    type: "agent.escalation",
    event_id: `aps-escalation-${escalationEventSeq}`,
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    runId: input.runId,
    workItemId: input.workItemId,
    role: input.role,
    tier: 1,
    fromModel: input.fromModel,
    toModel: input.toModel,
    reason: input.reason,
    attempt: input.attempt,
    escalatedToHuman: input.toModel === null,
    humanReviewRequested: input.toModel === null,
  };
}
