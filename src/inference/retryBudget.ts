/**
 * Per-incident retry budget (R03): one pure stop/retry decision for one failure. The incident key is
 * `RetryTrace.failure_id` (retryTrace.ts) and the wait comes from `exponentialBackoffMs` (retryDelay.ts),
 * so nothing is reinvented here and every RETRY_OWNERS.md ceiling arrives as `maxAttempts` data. Ordering:
 * bootstrap_mode (before any arithmetic), invalid_budget, attempts_exhausted, deadline_exceeded,
 * backoff_exceeds_deadline, else retry. No clock, RNG, environment, timer or I/O: one input, one decision.
 */

import { exponentialBackoffMs } from "./retryDelay.ts";

/** Why no further attempt is allowed for this incident. */
export type RetryBudgetStopReason =
  | "attempts_exhausted" | "deadline_exceeded" | "backoff_exceeds_deadline" | "bootstrap_mode" | "invalid_budget";

/** One budget check: every bound and every time arrives as an argument. Both counts are 1-based — `maxAttempts` is the total attempts allowed (1 means "no retry"), `attempt` the attempts already made. */
export interface RetryBudgetInput {
  maxAttempts: number;
  elapsedMs: number;
  /** Total budget for the incident, when one exists. */
  deadlineMs?: number;
  attempt: number;
  /** Local backoff base; `maxBackoffMs` caps it, and it is uncapped when that is absent. */
  baseBackoffMs: number;
  maxBackoffMs?: number;
  /** Server-advertised wait, honoured whenever it is the larger of the two. */
  retryAfterMs?: number;
  /** Absent means "normal"; bootstrap mode allows zero automatic retries. */
  mode?: "bootstrap" | "normal";
}

export type RetryBudgetDecision = { action: "retry"; waitMs: number; attempt: number }
  | { action: "stop"; reason: RetryBudgetStopReason };

/** A supplied bound that is not a finite non-negative number is a broken budget, not a default. */
const unusable = (ms: number | undefined): boolean => ms !== undefined && (!Number.isFinite(ms) || ms < 0);

/** Decide whether this incident may retry, and how long it must wait before doing so. */
export function evaluateRetryBudget(input: RetryBudgetInput): RetryBudgetDecision {
  if (input.mode === "bootstrap") return { action: "stop", reason: "bootstrap_mode" };
  const { maxAttempts, attempt, elapsedMs, baseBackoffMs, deadlineMs, maxBackoffMs, retryAfterMs } = input;
  if (
    !Number.isFinite(maxAttempts) || maxAttempts < 1 || !Number.isFinite(attempt) || attempt < 1 || !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
    !Number.isFinite(baseBackoffMs) || unusable(deadlineMs) || unusable(maxBackoffMs) || unusable(retryAfterMs)
  ) return { action: "stop", reason: "invalid_budget" };
  if (attempt >= maxAttempts) return { action: "stop", reason: "attempts_exhausted" };
  if (deadlineMs !== undefined && elapsedMs >= deadlineMs) return { action: "stop", reason: "deadline_exceeded" };
  const waitMs = Math.max(exponentialBackoffMs(attempt, baseBackoffMs, maxBackoffMs ?? Number.POSITIVE_INFINITY), retryAfterMs ?? 0);
  if (deadlineMs !== undefined && waitMs > deadlineMs - elapsedMs) return { action: "stop", reason: "backoff_exceeds_deadline" };
  return { action: "retry", waitMs, attempt };
}
