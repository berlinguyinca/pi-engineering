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
  PLANNING: ["READY", "WAITING_FOR_USER", "BLOCKED", "FAILED", "CANCELED"],
  READY: ["EXECUTING", "WAITING_FOR_USER", "BLOCKED", "FAILED", "CANCELED"],
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
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  REVIEWING: ["REPAIRING", "FINAL_VALIDATION", "COMPLETE", "WAITING_FOR_USER", "BLOCKED", "CANCELING", "FAILED"],
  REPAIRING: [
    "EXECUTING",
    "INTEGRATING",
    "VALIDATING",
    "REVIEWING",
    "FINAL_VALIDATION",
    "WAITING_FOR_USER",
    "BLOCKED",
    "CANCELING",
    "FAILED",
  ],
  FINAL_VALIDATION: ["COMPLETE", "REPAIRING", "REVIEWING", "BLOCKED", "CANCELING", "FAILED"],
  COMPLETE: [],
  WAITING_FOR_USER: [
    "CLASSIFYING",
    "PLANNING",
    "READY",
    "EXECUTING",
    "REVIEWING",
    "REPAIRING",
    "FINAL_VALIDATION",
    "CANCELING",
    "BLOCKED",
    "FAILED",
  ],
  BLOCKED: ["EXECUTING", "REPAIRING", "WAITING_FOR_USER", "CANCELED", "FAILED"],
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
