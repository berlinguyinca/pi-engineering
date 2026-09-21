/**
 * Lifecycle state machine (spec §6).
 *
 * Transitions are an explicit allow-list. An illegal transition is an error, not
 * a silent write, because the state is the harness's authoritative record of
 * engineering progress — the parent model's prose never moves it.
 */

import type { LifecycleState, LifecycleTrigger } from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";

const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  RECEIVED: ["CLASSIFIED", "PLAN_PENDING", "IMPLEMENTATION_PENDING", "VERIFYING", "COMPLETE", "BLOCKED"],
  CLASSIFIED: [
    "PLAN_PENDING",
    "PLANNED",
    "IMPLEMENTATION_PENDING",
    "VERIFYING",
    "CHANGE_CLASSIFIED",
    "COMPLETE",
    "BLOCKED",
  ],
  PLAN_PENDING: ["PLANNED", "IMPLEMENTATION_PENDING", "BLOCKED", "ESCALATED"],
  PLANNED: ["IMPLEMENTATION_PENDING", "BLOCKED"],
  IMPLEMENTATION_PENDING: ["IMPLEMENTING", "BLOCKED", "ESCALATED"],
  IMPLEMENTING: ["IMPLEMENTED", "CHANGE_CLASSIFIED", "BLOCKED", "ESCALATED"],
  IMPLEMENTED: ["CHANGE_CLASSIFIED", "VERIFYING", "REVIEW_PENDING", "BLOCKED"],
  CHANGE_CLASSIFIED: ["IMPLEMENTING", "VERIFYING", "REVIEW_PENDING", "SPEC_VERIFY_PENDING", "COMPLETE", "BLOCKED"],
  VERIFYING: ["VERIFIED", "VERIFICATION_FAILED", "BLOCKED"],
  VERIFIED: ["REVIEW_PENDING", "SPEC_VERIFY_PENDING", "BLOCKED"],
  VERIFICATION_FAILED: ["REMEDIATION_REQUIRED", "ESCALATED", "BLOCKED"],
  REVIEW_PENDING: ["REVIEWING", "SPECIALIST_REVIEW_PENDING", "BLOCKED"],
  REVIEWING: ["REVIEWED", "REVIEW_FAILED", "BLOCKED"],
  REVIEWED: ["SPECIALIST_REVIEW_PENDING", "SPEC_VERIFY_PENDING", "REMEDIATION_REQUIRED", "BLOCKED"],
  REVIEW_FAILED: ["REMEDIATION_REQUIRED", "ESCALATED", "BLOCKED"],
  SPECIALIST_REVIEW_PENDING: [
    "SPECIALIST_REVIEWED",
    "SPECIALIST_REVIEW_FAILED",
    "SPEC_VERIFY_PENDING",
    "REMEDIATION_REQUIRED",
  ],
  SPECIALIST_REVIEWED: ["SPEC_VERIFY_PENDING", "FINAL_VERIFY_PENDING", "REMEDIATION_REQUIRED"],
  SPECIALIST_REVIEW_FAILED: ["SPEC_VERIFY_PENDING", "FINAL_VERIFY_PENDING", "REMEDIATION_REQUIRED", "ESCALATED"],
  SPEC_VERIFY_PENDING: ["SPEC_VERIFIED", "SPEC_VERIFY_FAILED", "FINAL_VERIFY_PENDING"],
  SPEC_VERIFIED: ["FINAL_VERIFY_PENDING", "REMEDIATION_REQUIRED"],
  SPEC_VERIFY_FAILED: ["REMEDIATION_REQUIRED", "ESCALATED"],
  FINAL_VERIFY_PENDING: ["FINAL_VERIFIED", "VERIFICATION_FAILED"],
  FINAL_VERIFIED: ["COMPLETE", "REMEDIATION_REQUIRED"],
  REMEDIATION_REQUIRED: ["REMEDIATING", "ESCALATED", "BLOCKED"],
  REMEDIATING: ["IMPLEMENTING", "VERIFYING", "CHANGE_CLASSIFIED", "ESCALATED", "BLOCKED"],
  BLOCKED: ["RECEIVED", "REMEDIATING"],
  ESCALATED: ["RECEIVED", "REMEDIATING"],
  COMPLETE: ["RECEIVED"],
};

export interface TransitionResult {
  ok: boolean;
  from: LifecycleState;
  to: LifecycleState;
  reason?: string;
}

export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
  trigger: LifecycleTrigger = "command",
): TransitionResult {
  if (from === to) return { ok: true, from, to };
  const allowed = TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true, from, to };
  // Terminal states only reopen through an explicit operator command.
  if (TERMINAL_STATES.includes(from) && trigger !== "command") {
    return { ok: false, from, to, reason: `${from} is terminal; only an operator command may reopen a run` };
  }
  return { ok: false, from, to, reason: `${from} -> ${to} is not a defined lifecycle transition` };
}

export function allowedNext(from: LifecycleState): LifecycleState[] {
  return TRANSITIONS[from] ?? [];
}

/** Ordered stage labels for human-facing status output. */
export const STAGE_ORDER: { state: LifecycleState; label: string }[] = [
  { state: "RECEIVED", label: "request received" },
  { state: "CLASSIFIED", label: "work + risk classified" },
  { state: "PLAN_PENDING", label: "plan required" },
  { state: "PLANNED", label: "plan approved" },
  { state: "IMPLEMENTING", label: "implementing" },
  { state: "IMPLEMENTED", label: "change detected" },
  { state: "VERIFYING", label: "verifying" },
  { state: "REVIEWING", label: "independent review" },
  { state: "SPECIALIST_REVIEW_PENDING", label: "specialist review" },
  { state: "SPEC_VERIFY_PENDING", label: "spec verification" },
  { state: "FINAL_VERIFY_PENDING", label: "final verification" },
  { state: "REMEDIATION_REQUIRED", label: "remediation required" },
  { state: "COMPLETE", label: "complete" },
  { state: "ESCALATED", label: "escalated to operator" },
  { state: "BLOCKED", label: "blocked" },
];
