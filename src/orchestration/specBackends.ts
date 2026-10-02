/**
 * Author/reviewer/refiner worker backends for autonomous spec approval.
 *
 * Each stage runs in a fresh context (new session, no author transcript for the
 * reviewer). When no distinct reviewer model is available, the current model
 * runs in a NEW session WITHOUT the author transcript and records
 * `same_model_reduced` so the evidence/status projection can warn.
 */

import type {
  MissionSpecRevision,
  ProtectedUserCriteria,
  SpecReviewEvidence,
  SpecReviewVerdict,
  SpecStageAttempt,
  SpecWorkflowState,
} from "./specApproval.ts";

export interface SpecWorkerModel {
  /** Stable model identity; `null` means no usable model identity exists. */
  id: string | null;
  provider: string;
}

export interface SpecWorkerRunResult {
  ok: boolean;
  /** Raw structured output (already parsed from the worker payload). */
  value?: unknown;
  error?: string;
  sessionId: string;
  modelId: string | null;
  provider: string;
}

/** Minimal worker-invocation seam; injected by the runtime. */
export interface SpecWorkerRunner {
  run(request: {
    role: "spec-author" | "spec-reviewer" | "spec-refiner";
    missionId: string;
    prompt: string;
    model: SpecWorkerModel | null;
    sessionId: string;
    deadlineAt: string;
  }): Promise<SpecWorkerRunResult>;
}

/** Durable author output: structured spec + proposed planned tasks. */
export interface SpecDraftOutput {
  derivedAcceptance: string[];
  designSummary: string;
  testObligations: string[];
  assumptions: string[];
  risks: string[];
  nonGoals: string[];
  proposedTasks: Array<Record<string, unknown>>;
}

export interface SpecAuthorBackend {
  draft(input: {
    missionId: string;
    protectedInputs: ProtectedUserCriteria;
    model: SpecWorkerModel;
    sessionId: string;
    deadlineAt: string;
  }): Promise<{ ok: boolean; draft?: SpecDraftOutput; error?: string; sessionId: string; modelId: string | null }>;
}

export interface SpecReviewerBackend {
  review(input: {
    missionId: string;
    revision: MissionSpecRevision;
    acceptanceIds: string[];
    model: SpecWorkerModel | null;
    independenceMode: "fresh_context" | "same_model_reduced";
    sessionId: string;
    deadlineAt: string;
  }): Promise<{
    ok: boolean;
    verdict?: SpecReviewVerdict;
    findings?: Array<Record<string, unknown>>;
    proposedAdjustments?: string[];
    uncoveredRisks?: string[];
    scopeViolations?: string[];
    acceptanceResults?: Array<{ acceptanceId: string; result: "covered" | "uncovered" | "not_applicable" }>;
    summary?: string;
    confidence?: number;
    error?: string;
    sessionId: string;
    modelId: string | null;
  }>;
}

export interface SpecRefinerBackend {
  refine(input: {
    missionId: string;
    revision: MissionSpecRevision;
    review: SpecReviewEvidence;
    protectedInputs: ProtectedUserCriteria;
    model: SpecWorkerModel;
    sessionId: string;
    deadlineAt: string;
  }): Promise<{ ok: boolean; draft?: SpecDraftOutput; error?: string; sessionId: string; modelId: string | null }>;
}

export interface SpecBackendSet {
  author: SpecAuthorBackend;
  reviewer: SpecReviewerBackend;
  refiner: SpecRefinerBackend;
}

/* ------------------------------------------------------------------ */
/* Prompt builders                                                     */
/* ------------------------------------------------------------------ */

export function authorPrompt(protectedInputs: ProtectedUserCriteria): string {
  return [
    "You are a specification author. Produce a durable, testable spec and a normalized task plan.",
    "PROTECTED USER REQUEST (must be preserved exactly):",
    protectedInputs.userRequest,
    "PROTECTED CONSTRAINTS:",
    protectedInputs.constraints.join("; ") || "(none)",
    "PROTECTED ACCEPTANCE CRITERIA:",
    protectedInputs.acceptance.map((entry) => `- [${entry.id}] ${entry.text}`).join("\n"),
    "REQUIRED GATES:",
    protectedInputs.requiredGates.join(", "),
    "AUTHORIZED WORKSPACE:",
    JSON.stringify(protectedInputs.workspace),
    "You MUST NOT add repositories, writable paths, credentials, destructive operations, or external side effects.",
    "Return JSON with keys: derivedAcceptance, designSummary, testObligations, assumptions, risks, nonGoals, proposedTasks.",
  ].join("\n");
}

export function reviewerPrompt(revision: MissionSpecRevision, acceptanceIds: string[]): string {
  return [
    "You are an independent spec reviewer evaluating the EXACT revision below.",
    "REVISION ID (do not trust; verify content):",
    revision.revisionId,
    "SEMANTIC SPEC HASH:",
    revision.semanticSpecHash,
    "PLAN HASH:",
    revision.planHash,
    "DESIGN SUMMARY:",
    revision.designSummary,
    "TEST OBLIGATIONS:",
    revision.testObligations.join("; "),
    "PLANNED TASKS:",
    JSON.stringify(revision.plan, null, 2),
    "ACCEPTANCE IDS TO COVER:",
    acceptanceIds.join(", "),
    "Return JSON with keys: verdict (approve|request_changes), findings, proposedAdjustments, uncoveredRisks, scopeViolations, acceptanceResults (one per acceptance ID: covered|uncovered|not_applicable), summary, confidence.",
  ].join("\n");
}

export function refinerPrompt(revision: MissionSpecRevision, review: SpecReviewEvidence): string {
  return [
    "You are a spec refiner. Revise the revision to address the review WITHOUT weakening protected requirements.",
    "REVISION:",
    JSON.stringify(revision, null, 2),
    "REVIEW FINDINGS:",
    JSON.stringify(review.findings, null, 2),
    "REVIEW PROPOSED ADJUSTMENTS:",
    review.proposedAdjustments.join("; "),
    "SCOPE VIOLATIONS RAISED:",
    review.scopeViolations.join("; "),
    "Keep protected inputs identical. Return the same JSON shape as an author: derivedAcceptance, designSummary, testObligations, assumptions, risks, nonGoals, proposedTasks.",
  ].join("\n");
}

export interface SpecSessionAllocator {
  nextSessionId(missionId: string, role: "spec-author" | "spec-reviewer" | "spec-refiner"): string;
}

/** Resolve reviewer model + independence mode. */
export function resolveReviewerModel(
  currentModel: SpecWorkerModel | null,
  distinctReviewerModel: SpecWorkerModel | null,
): { model: SpecWorkerModel | null; independenceMode: "fresh_context" | "same_model_reduced" } {
  if (!currentModel || !currentModel.id) {
    return { model: null, independenceMode: "fresh_context" };
  }
  if (distinctReviewerModel?.id && distinctReviewerModel.id !== currentModel.id) {
    return { model: distinctReviewerModel, independenceMode: "fresh_context" };
  }
  // Same model in a NEW session without the author transcript.
  return { model: currentModel, independenceMode: "same_model_reduced" };
}

export function specWarningFor(independenceMode: "fresh_context" | "same_model_reduced"): string | null {
  return independenceMode === "same_model_reduced" ? "same-model review has reduced independence" : null;
}

export function nextSpecWorkflowState(
  missionId: string,
  current: SpecWorkflowState | null,
  stage: SpecStageAttempt,
): SpecWorkflowState {
  const base = current ?? {
    missionId,
    phase: "idle" as const,
    revisionNumber: 0,
    semanticSpecHash: null,
    planHash: null,
    semanticRoundsUsed: 0,
    semanticRoundsLimit: 2,
    activeStage: null,
    overallDeadlineAt: null,
    approval: null,
    invalidatedApprovalId: null,
    warning: null,
    nextAction: "draft",
    nextActionAt: stage.deadlineAt,
    stopReason: null,
    resumeCondition: null,
  };
  return {
    ...base,
    phase: stage.stage,
    activeStage: stage,
    nextAction: stage.stage === "review" ? "review" : stage.stage,
    nextActionAt: stage.deadlineAt,
  };
}
