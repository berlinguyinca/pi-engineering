/**
 * Mission / Task lifecycle state machines (spec 00 §4, spec 02).
 *
 * The runtime, not the model, owns lifecycle state. These transition tables are
 * deterministic application logic: an invalid transition is rejected rather
 * than silently applied, so no prompt can drift a mission out of its legal
 * lifecycle.
 */

import type { MissionStatus, TaskStatus } from "./types.ts";

/** Canonical mission lifecycle (spec 00 §4) plus exceptional states. */
const MISSION_TRANSITIONS: Record<MissionStatus, ReadonlyArray<MissionStatus>> = {
  NEW: ["CLASSIFYING"],
  CLASSIFYING: ["PLANNING", "READY", "WAITING_FOR_USER", "BLOCKED", "FAILED", "CANCELED"],
  PLANNING: ["READY", "QUEUED", "WAITING_FOR_USER", "BLOCKED", "FAILED", "CANCELED"],
  READY: ["QUEUED", "STARTING", "EXECUTING", "WAITING_FOR_USER", "BLOCKED", "FAILED", "CANCELED"],
  // Resilience states: QUEUED/STARTING precede execution; a mission parks in a
  // WAITING_* state when infrastructure is degraded and returns to QUEUED/STARTING
  // to resume. PAUSED_INFRASTRUCTURE is the terminal-on-exhaustion default and
  // resumes automatically when the gateway returns healthy. NEEDS_ATTENTION is
  // for auth/config/invalid-request errors that must not blind-retry.
  QUEUED: ["STARTING", "EXECUTING", "WAITING_FOR_USER", "BLOCKED", "CANCELING", "FAILED"],
  STARTING: [
    "EXECUTING",
    "WAITING_FOR_LLM",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  WAITING_FOR_LLM: [
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "WAITING_FOR_TOOL",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  WAITING_FOR_CAPACITY: [
    "WAITING_FOR_LLM",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  WAITING_FOR_GATEWAY: [
    "WAITING_FOR_LLM",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  WAITING_FOR_MODEL: [
    "WAITING_FOR_LLM",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_CAPACITY",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  WAITING_FOR_TOOL: [
    "EXECUTING",
    "WAITING_FOR_LLM",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "QUEUED",
    "STARTING",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  RECOVERING_CONTEXT: [
    "WAITING_FOR_LLM",
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  RECOVERING_PROCESS: [
    "EXECUTING",
    "WAITING_FOR_LLM",
    "QUEUED",
    "STARTING",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  PAUSED_INFRASTRUCTURE: ["QUEUED", "STARTING", "EXECUTING", "WAITING_FOR_USER", "BLOCKED", "CANCELING", "FAILED"],
  NEEDS_ATTENTION: [
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "WAITING_FOR_LLM",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  // Forward skips along the canonical order are legal when the skipped stage's
  // gate does not apply: a read-only investigation has no validation/review
  // task, so it finishes EXECUTING -> FINAL_VALIDATION -> COMPLETE. Without the
  // skip such a mission dead-ends (observed: `illegal mission transition
  // EXECUTING -> COMPLETE`).
  EXECUTING: [
    "INTEGRATING",
    "VALIDATING",
    "REVIEWING",
    "REPAIRING",
    "FINAL_VALIDATION",
    "WAITING_FOR_LLM",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "WAITING_FOR_TOOL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  INTEGRATING: [
    "VALIDATING",
    "REVIEWING",
    "REPAIRING",
    "FINAL_VALIDATION",
    "EXECUTING",
    "WAITING_FOR_LLM",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  VALIDATING: [
    "REVIEWING",
    "REPAIRING",
    "FINAL_VALIDATION",
    "EXECUTING",
    "WAITING_FOR_LLM",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  REVIEWING: [
    "REPAIRING",
    "FINAL_VALIDATION",
    "COMPLETE",
    "WAITING_FOR_LLM",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  REPAIRING: [
    "EXECUTING",
    "INTEGRATING",
    "VALIDATING",
    "REVIEWING",
    "FINAL_VALIDATION",
    "WAITING_FOR_LLM",
    "WAITING_FOR_CAPACITY",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_MODEL",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  FINAL_VALIDATION: [
    "COMPLETE",
    "REPAIRING",
    "REVIEWING",
    "WAITING_FOR_LLM",
    "WAITING_FOR_GATEWAY",
    "WAITING_FOR_CAPACITY",
    "RECOVERING_CONTEXT",
    "RECOVERING_PROCESS",
    "PAUSED_INFRASTRUCTURE",
    "NEEDS_ATTENTION",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  COMPLETE: [],
  WAITING_FOR_USER: [
    "CLASSIFYING",
    "PLANNING",
    "READY",
    "QUEUED",
    "STARTING",
    "EXECUTING",
    "REVIEWING",
    "REPAIRING",
    "FINAL_VALIDATION",
    "CANCELING",
    "BLOCKED",
    "FAILED",
  ],
  BLOCKED: ["EXECUTING", "REPAIRING", "QUEUED", "STARTING", "WAITING_FOR_USER", "CANCELED", "FAILED"],
  CANCELING: ["CANCELED", "BLOCKED", "FAILED"],
  CANCELED: [],
  FAILED: [],
};

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlyArray<TaskStatus>> = {
  PENDING: ["READY", "CANCELED", "SKIPPED", "BLOCKED"],
  READY: ["RUNNING", "CANCELED", "SKIPPED", "BLOCKED", "SUCCEEDED"],
  RUNNING: ["SUCCEEDED", "FAILED", "RETRYING", "CANCELED", "BLOCKED"],
  WAITING: ["READY", "RUNNING", "CANCELED", "BLOCKED", "FAILED"],
  SUCCEEDED: [],
  FAILED: ["RETRYING", "READY", "CANCELED", "SKIPPED", "BLOCKED"],
  RETRYING: ["READY", "RUNNING", "CANCELED", "FAILED", "SKIPPED", "BLOCKED"],
  CANCELED: [],
  SKIPPED: [],
  BLOCKED: ["READY", "CANCELED", "SKIPPED"],
};

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws if the transition is illegal. */
export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMission(from, to)) {
    throw new Error(`illegal mission transition ${from} -> ${to}`);
  }
}

/** Throws if the transition is illegal. */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`illegal task transition ${from} -> ${to}`);
  }
}
