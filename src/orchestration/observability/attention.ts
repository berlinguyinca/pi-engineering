/**
 * Why a mission deserves attention, as evidence rather than as a label.
 *
 * Health answers "is this mission moving". It does not answer "why should the
 * operator look now", and the two were being conflated: surfaces ranked by
 * health, then appended a free-text reason that was often the mission's own
 * narration. A mission can be healthy and still be the one you must act on —
 * waiting on your approval, parked by you, repeating a tool call — and a mission
 * can be stalled with nothing for you to do about it.
 *
 * Attention is derived from the same facts every time, in this order, and the
 * strongest fact is carried with it. Nothing here is inferred from model text:
 * every reason is a state, a timestamp, a counter, or a deadline, so two
 * operators reading the same mission see the same reason.
 */

import { PARKING_WAIT_ACTIONS } from "../recovery.ts";
import type { RecoveryAction } from "../types.ts";
import type { LoopSignal, MissionHealth, MissionObservabilitySummary, WaitingReason } from "./types.ts";

/** How strongly this mission should interrupt the operator. */
export type AttentionSeverity = "critical" | "high" | "medium" | "low" | "info";

/** The rank order of severities; `critical` is the one to act on first. */
export const ATTENTION_SEVERITY_ORDER: readonly AttentionSeverity[] = ["critical", "high", "medium", "low", "info"];

/** A fact that justifies the severity, in the order it was found. */
export interface AttentionEvidence {
  kind:
    | "operator_action_required"
    | "operator_paused"
    | "failure"
    | "blocked"
    | "parked"
    | "loop"
    | "stalled"
    | "waiting_deadline"
    | "waiting"
    | "progress_age"
    | "no_proof_of_life"
    | "recovery_exhausted"
    | "capacity_wait"
    | "review_blocked"
    | "tests_failing";
  /** When the fact became true, if it has a time. */
  at?: string;
  /** The specific fact: a count, an age, a deadline, a reason. */
  detail: string;
}

export interface MissionAttention {
  severity: AttentionSeverity;
  /** One clause, already human-readable: what the operator should know. */
  reason: string;
  /** Strongest first. Never empty when attention exists. */
  evidence: AttentionEvidence[];
}

export interface AttentionInput {
  state: string;
  health: MissionHealth;
  reason?: string;
  waitingReason?: WaitingReason;
  waitingSince?: string;
  lastMeaningfulProgressAt: string | null;
  lastHeartbeatAt?: string;
  nextActionAt?: string | null;
  recovery: { attempt: number; maxAttempts: number };
  /** The recovery action behind `recovery`; a wait action is a park, not an exhausted budget. */
  recoveryAction?: string;
  /** Failure category behind the latest classification; selects what the wait claims to be waiting for. */
  failureCategory?: string;
  operatorPausedAt?: string | null;
  /** Loop signals flagged for this mission's live workers. */
  loopSignals?: LoopSignal[];
  review?: { blockingOpen: number };
  tests?: { failed: number };
  /** A waiting mission past this deadline is worth interrupting for. */
  waitingDeadlineMs?: number;
  now: number;
}

/** States where the operator, not the runtime, is the next actor. */
const OPERATOR_STATES = new Set(["NEEDS_ATTENTION", "WAITING_FOR_USER", "REVIEW_BLOCKED", "AWAITING_APPROVAL"]);
/** States where the mission stopped on its own and kept its work. */
const PARKED_STATES = new Set(["PARKED", "PARKED_UNPROVEN", "PARKED_UNKNOWN", "BLOCKED"]);
/** A named wait is informational; the runtime is doing something about it. */
const SELF_SERVING_WAITS = new Set<WaitingReason>([
  "inferweave_admission",
  "worker_dependency",
  "integration_tests",
  "slurm_scheduler",
  "external_resource",
  "repository_lease",
  "model_request",
  "rate_limit",
]);

/** Wording for a parking wait; "capacity" is claimed only for provider failures. */
function parkingWaitWording(action: string, category: string | undefined): { lead: string; resumes: string } {
  if (action === "PAUSE_FOR_PERSISTENCE") {
    return { lead: "durable writes failing: probe", resumes: "resumes once storage recovers" };
  }
  if (category === "PROVIDER_TRANSIENT" || category === "PROVIDER_PERMANENT") {
    return { lead: "waiting for capacity: probe", resumes: "will resume automatically when capacity returns" };
  }
  if (category === "DISK_SUSPENDED") {
    return { lead: "waiting for disk space: probe", resumes: "resumes once disk space is freed" };
  }
  return { lead: "waiting: probe", resumes: "resumes once the blocking condition clears" };
}

function ageMs(at: string | null | undefined, now: number): number | undefined {
  const parsed = Date.parse(at ?? "");
  return Number.isNaN(parsed) ? undefined : Math.max(0, now - parsed);
}

function humanAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Derive attention from observability facts. Returns `null` when there is
 * nothing to say, so a surface can fall back to plain state ordering instead of
 * inventing a reason.
 */
export function deriveAttention(input: AttentionInput): MissionAttention | null {
  const evidence: AttentionEvidence[] = [];
  const state = input.state.toUpperCase();
  const progressAge = ageMs(input.lastMeaningfulProgressAt, input.now);
  const heartbeatAge = ageMs(input.lastHeartbeatAt, input.now);
  const loops = input.loopSignals ?? [];
  const strongestLoop = loops.reduce<LoopSignal | undefined>(
    (best, signal) => (best === undefined || signal.count > best.count ? signal : best),
    undefined,
  );

  // The operator is the next actor: nothing else ranks above this, because every
  // other fact describes work the runtime is still doing on its own.
  if (OPERATOR_STATES.has(state)) {
    evidence.push({
      kind: "operator_action_required",
      detail: input.reason?.trim() || `mission is ${state.toLowerCase().replace(/_/g, " ")}`,
    });
    return { severity: "critical", reason: evidence[0]!.detail, evidence };
  }

  if (input.recovery.attempt >= input.recovery.maxAttempts && input.recovery.maxAttempts > 0) {
    if (input.recoveryAction !== undefined && PARKING_WAIT_ACTIONS.has(input.recoveryAction as RecoveryAction)) {
      // A parking wait is unbounded by design: the counter past its budget is
      // wait progress. What the wait is for, and who ends it, depends on the
      // failure category, so the wording names only what is true for it.
      const waited = ageMs(input.waitingSince, input.now);
      const nextAt = Date.parse(input.nextActionAt ?? "");
      const nextProbe = Number.isNaN(nextAt)
        ? []
        : [nextAt <= input.now ? "next probe due now" : `next probe in ${humanAge(nextAt - input.now)}`];
      const wait = parkingWaitWording(input.recoveryAction, input.failureCategory);
      const parts = [
        `${wait.lead} ${input.recovery.attempt}`,
        ...(waited !== undefined ? [`parked ${humanAge(waited)}`] : []),
        ...nextProbe,
      ];
      evidence.push({
        kind: "capacity_wait",
        ...(input.waitingSince ? { at: input.waitingSince } : {}),
        detail: `${parts.join(", ")}; ${wait.resumes}`,
      });
    } else {
      evidence.push({
        kind: "recovery_exhausted",
        detail: `recovery attempt ${input.recovery.attempt} of ${input.recovery.maxAttempts} did not restore progress`,
      });
    }
  }
  if (state === "FAILED") {
    evidence.push({ kind: "failure", detail: input.reason?.trim() || "the mission failed" });
  }
  if (input.review && input.review.blockingOpen > 0) {
    evidence.push({ kind: "review_blocked", detail: `${input.review.blockingOpen} blocking review finding(s) open` });
  }
  if (input.tests && input.tests.failed > 0) {
    evidence.push({ kind: "tests_failing", detail: `${input.tests.failed} test(s) failing` });
  }
  if (evidence.length > 0) return { severity: "high", reason: evidence[0]!.detail, evidence };

  // A loop is the one case where a healthy-looking mission is worth interrupting
  // for: the counters say it is spending effort without changing anything.
  if (strongestLoop) {
    evidence.push({
      kind: "loop",
      detail: `${strongestLoop.kind.replace(/_/g, " ")} ×${strongestLoop.count}${strongestLoop.detail ? ` — ${strongestLoop.detail}` : ""}`,
    });
    return { severity: "high", reason: evidence[0]!.detail, evidence };
  }

  if (input.operatorPausedAt) {
    const pausedFor = ageMs(input.operatorPausedAt, input.now);
    evidence.push({
      kind: "operator_paused",
      at: input.operatorPausedAt,
      detail: pausedFor !== undefined ? `paused by you ${humanAge(pausedFor)} ago` : "paused by you",
    });
    return { severity: "medium", reason: evidence[0]!.detail, evidence };
  }

  if (PARKED_STATES.has(state)) {
    evidence.push({
      kind: "parked",
      detail: input.reason?.trim() || `mission is ${state.toLowerCase().replace(/_/g, " ")}`,
    });
    return { severity: "high", reason: evidence[0]!.detail, evidence };
  }

  if (input.health === "stalled") {
    evidence.push({
      kind: "stalled",
      detail:
        progressAge !== undefined ? `no meaningful progress for ${humanAge(progressAge)}` : "no meaningful progress",
    });
    return { severity: "high", reason: evidence[0]!.detail, evidence };
  }

  if (input.waitingReason) {
    const waited = ageMs(input.waitingSince, input.now);
    const overdue = waited !== undefined && input.waitingDeadlineMs !== undefined && waited >= input.waitingDeadlineMs;
    if (overdue) {
      evidence.push({
        kind: "waiting_deadline",
        at: input.waitingSince,
        detail: `waiting on ${input.waitingReason.replace(/_/g, " ")} for ${humanAge(waited!)}, past its deadline`,
      });
      return { severity: "medium", reason: evidence[0]!.detail, evidence };
    }
    if (!SELF_SERVING_WAITS.has(input.waitingReason)) {
      evidence.push({
        kind: "waiting",
        at: input.waitingSince,
        detail: `waiting on ${input.waitingReason.replace(/_/g, " ")}`,
      });
      return { severity: "low", reason: evidence[0]!.detail, evidence };
    }
    // A named, self-serving wait is worth a line but not an interruption.
    evidence.push({
      kind: "waiting",
      at: input.waitingSince,
      detail: `waiting on ${input.waitingReason.replace(/_/g, " ")}`,
    });
    return { severity: "info", reason: evidence[0]!.detail, evidence };
  }

  if (input.health === "slow") {
    evidence.push({
      kind: "progress_age",
      detail: progressAge !== undefined ? `slow: no meaningful progress for ${humanAge(progressAge)}` : "slow progress",
    });
    return { severity: "low", reason: evidence[0]!.detail, evidence };
  }

  // A running mission with neither heartbeat nor progress is the one state where
  // we cannot tell whether the work is alive. Say so rather than look healthy.
  const terminal = ["COMPLETE", "COMPLETED", "FAILED", "CANCELED", "CANCELLED"].includes(state);
  if (!terminal && heartbeatAge === undefined && progressAge === undefined) {
    evidence.push({ kind: "no_proof_of_life", detail: "no heartbeat and no recorded progress" });
    return { severity: "medium", reason: evidence[0]!.detail, evidence };
  }

  return null;
}

/** Attention from the canonical summary plus the facts the summary does not carry. */
export function attentionFromSummary(
  summary: MissionObservabilitySummary,
  options: {
    now: number;
    loopSignals?: LoopSignal[];
    operatorPausedAt?: string | null;
    review?: { blockingOpen: number };
    tests?: { failed: number };
    waitingDeadlineMs?: number;
  },
): MissionAttention | null {
  return deriveAttention({
    state: summary.state,
    health: summary.health,
    reason: summary.reason,
    waitingReason: summary.waitingReason,
    waitingSince: summary.waitingSince,
    lastMeaningfulProgressAt: summary.lastMeaningfulProgressAt,
    lastHeartbeatAt: summary.lastHeartbeatAt,
    nextActionAt: summary.nextActionAt,
    recovery: summary.recovery,
    recoveryAction: summary.action,
    failureCategory: summary.failureCategory,
    operatorPausedAt: options.operatorPausedAt,
    loopSignals: options.loopSignals,
    review: options.review,
    tests: options.tests,
    waitingDeadlineMs: options.waitingDeadlineMs,
    now: options.now,
  });
}
