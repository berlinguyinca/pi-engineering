/**
 * Pure, deterministic quota/availability resume decision (spec: quota resume).
 *
 * After an inference request fails, nothing durable decides whether the mission
 * should pause with a recovery handoff, switch to an eligible alternate model,
 * wait, or fail outright — and nothing prevents a model switch from replaying
 * uncommitted external side effects (HAND-007). This module closes that gap. It
 * is pure data — no I/O, no Date.now, no classes — and never mutates its input.
 */

import type { InferenceFailureClass } from "../../inference/failureClassifier.ts";
import type { HandoffKind } from "./handoffKinds.ts";
import type { HandoffSideEffect } from "./handoffResume.ts";

/** What a quota/availability failure should trigger next. */
export type QuotaResumeAction = "pause" | "switch_model" | "wait" | "fail";

/** A model from the current catalogue that may be switchable-to. */
export interface QuotaResumeModel {
  id: string;
  family?: string;
  eligible: boolean;
}

/** The inputs to a quota/availability resume decision. */
export interface QuotaResumeInput {
  failureClass: InferenceFailureClass;
  currentModelId: string;
  catalogue: readonly QuotaResumeModel[];
  retryAfterMs?: number;
  nowMs: number;
  pausedAtMs: number | null;
  maxPauseMs: number;
  sideEffects: readonly HandoffSideEffect[];
  hasCheckpoint: boolean;
}

/** The decision a caller may act on. */
export interface QuotaResumeDecision {
  action: QuotaResumeAction;
  handoffKind: HandoffKind | null;
  alternateModelId: string | null;
  reasons: string[];
}

/** Capacity/throughput failures that may be waited out on the same model. */
const CAPACITY = new Set<InferenceFailureClass>([
  "capacity_unavailable",
  "rate_limited",
  "queue_saturated",
  "no_workers",
]);

/** The model has vanished from the serving fleet. */
const GONE = new Set<InferenceFailureClass>(["model_not_found", "model_unavailable"]);

/** First catalogue entry that is eligible and not the current model, else null. */
function firstAlternate(catalogue: readonly QuotaResumeModel[], currentModelId: string): QuotaResumeModel | null {
  for (const model of catalogue) {
    if (model.eligible === true && model.id !== currentModelId) return model;
  }
  return null;
}

/** True when the current model is absent from the catalogue. */
function currentAbsent(catalogue: readonly QuotaResumeModel[], currentModelId: string): boolean {
  return !catalogue.some((model) => model.id === currentModelId);
}

/** True when at least one recorded side effect was never committed. */
function hasUncommitted(sideEffects: readonly HandoffSideEffect[]): boolean {
  return sideEffects.some((effect) => effect.committed === false);
}

/**
 * Decide what a quota/availability failure should trigger. The first matching
 * rule wins; `reasons` is exactly the single reason string for that rule.
 * Never throws on malformed input and never mutates its input.
 */
export function decideQuotaResume(input: QuotaResumeInput): QuotaResumeDecision {
  const failureClass = input.failureClass;
  const currentModelId = input.currentModelId;
  const catalogue = input.catalogue;
  const alt = firstAlternate(catalogue, currentModelId);
  const isCurrentAbsent = GONE.has(failureClass) || currentAbsent(catalogue, currentModelId);
  const uncommitted = hasUncommitted(input.sideEffects);

  const fail = (reason: string): QuotaResumeDecision => ({
    action: "fail",
    handoffKind: null,
    alternateModelId: null,
    reasons: [reason],
  });
  const pause = (reason: string): QuotaResumeDecision => ({
    action: "pause",
    handoffKind: "recovery",
    alternateModelId: null,
    reasons: [reason],
  });
  const wait = (reason: string): QuotaResumeDecision => ({
    action: "wait",
    handoffKind: null,
    alternateModelId: null,
    reasons: [reason],
  });
  const switchModel = (reason: string): QuotaResumeDecision => ({
    action: "switch_model",
    handoffKind: "recovery",
    alternateModelId: alt === null ? null : alt.id,
    reasons: [reason],
  });

  // (1) not a quota or availability failure
  if (
    !CAPACITY.has(failureClass) &&
    failureClass !== "quota" &&
    failureClass !== "billing" &&
    !GONE.has(failureClass)
  ) {
    return fail("not a quota or availability failure");
  }
  // (2) billing refusal is not resumable
  if (failureClass === "billing") return fail("billing refusal is not resumable");
  // (3) pause window exceeded
  if (input.pausedAtMs !== null && input.nowMs - input.pausedAtMs > input.maxPauseMs) {
    return fail("pause window exceeded");
  }
  // (4) no checkpoint to resume from
  if (input.hasCheckpoint === false) return fail("no checkpoint to resume from");
  // (5) model absent from catalogue; switching to alternate
  if (isCurrentAbsent && alt !== null) {
    return switchModel("model absent from catalogue; switching to alternate");
  }
  // (6) model absent and no eligible alternate
  if (isCurrentAbsent) return pause("model absent and no eligible alternate");
  // (7) quota exhausted; switching to eligible alternate
  if (failureClass === "quota" && alt !== null && !uncommitted) {
    return switchModel("quota exhausted; switching to eligible alternate");
  }
  // (8) uncommitted side effects block model switch
  if (failureClass === "quota" && alt !== null && uncommitted) {
    return pause("uncommitted side effects block model switch");
  }
  // (9) quota exhausted and no eligible alternate
  if (failureClass === "quota") return pause("quota exhausted and no eligible alternate");
  // (10) short capacity wait on same model
  if (CAPACITY.has(failureClass) && typeof input.retryAfterMs === "number" && input.retryAfterMs < 60_000) {
    return wait("short capacity wait on same model");
  }
  // (11) capacity unavailable; pausing for later resume
  return pause("capacity unavailable; pausing for later resume");
}
