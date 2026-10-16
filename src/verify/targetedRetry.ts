/**
 * Bounded, targeted retry policy (issue #307, CI-005).
 *
 * A pure, side-effect-free decision function that tells the verifier whether a
 * failed stage may be retried and, when it can, exactly which failing tests to
 * re-run. It is deliberately free of imports, I/O and classes: callers own the
 * quarantine set, the attempt counter and the failure classification.
 *
 * Rules are evaluated in order and the first match wins. Every decision carries
 * exactly one reason string. `required` never changes the decision (a required
 * stage is retried exactly like an optional one; the caller decides what a
 * retry means for the gate). Inputs are never mutated and the function never
 * throws.
 */

/** Why a stage failed, so the policy can decide whether a retry would help. */
export type RetryFailureClass = "assertion" | "stall" | "infra" | "unknown";

/** What the verifier should do with the failed stage. */
export type RetryAction = "retry" | "fail" | "escalate_full";

/** Input to the targeted-retry decision. */
export interface TargetedRetryInput {
  stage: string;
  required: boolean;
  /** The 1-based attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  failureClass: RetryFailureClass;
  failingTests: readonly string[];
  quarantined: readonly string[];
}

/** The verifier's decision for a failed stage. */
export interface TargetedRetryDecision {
  action: RetryAction;
  /** De-duplicated, sorted failing tests to re-run when `action === "retry"`; empty otherwise. */
  retryTests: readonly string[];
  /** Exactly one reason string, always. */
  reasons: readonly string[];
}

/** Default upper bound on attempts when the caller does not set one. */
export const DEFAULT_MAX_ATTEMPTS = 2;

/** Upper bound on how many tests a targeted retry will re-run. */
export const MAX_TARGETED_TESTS = 20;

const FAIL_REASON = "fail";
const RETRY_REASON = "retry";
const ESCALATE_REASON = "escalate_full";

/**
 * Decides whether a failed stage may be retried and, if so, which tests.
 * First matching rule wins; `reasons` always has exactly one element. Pure:
 * never mutates `input` and never throws.
 */
export function decideTargetedRetry(input: TargetedRetryInput): TargetedRetryDecision {
  // (1) Invalid attempt bounds.
  if (
    !Number.isInteger(input.maxAttempts) ||
    !Number.isInteger(input.attempt) ||
    input.maxAttempts < 1 ||
    input.attempt < 1
  ) {
    return { action: FAIL_REASON, retryTests: [], reasons: ["invalid attempt bounds"] };
  }

  // (2) Any failing test is quarantined.
  const quarantined = new Set(input.quarantined);
  if (input.failingTests.some((t) => quarantined.has(t))) {
    return { action: FAIL_REASON, retryTests: [], reasons: ["quarantined test blocks retry"] };
  }

  // (3) A stalled stage is not retried.
  if (input.failureClass === "stall") {
    return { action: FAIL_REASON, retryTests: [], reasons: ["stalled stage is not retried"] };
  }

  // (4) Retry budget exhausted.
  if (input.attempt >= input.maxAttempts) {
    return { action: FAIL_REASON, retryTests: [], reasons: ["retry budget exhausted"] };
  }

  // (5) No failing test names to target.
  if (input.failingTests.length === 0) {
    return { action: ESCALATE_REASON, retryTests: [], reasons: ["no failing test names; escalate to full stage"] };
  }

  // (6) Too many failures for a targeted retry.
  if (input.failingTests.length > MAX_TARGETED_TESTS) {
    return { action: ESCALATE_REASON, retryTests: [], reasons: ["too many failing tests for targeted retry"] };
  }

  // (7) Infrastructure failure: retry.
  if (input.failureClass === "infra") {
    return {
      action: RETRY_REASON,
      retryTests: sortedDedupe(input.failingTests),
      reasons: ["infra failure; retry failing tests"],
    };
  }

  // (8) Assertion failure: retry once to confirm.
  if (input.failureClass === "assertion") {
    return {
      action: RETRY_REASON,
      retryTests: sortedDedupe(input.failingTests),
      reasons: ["assertion failure; retry failing tests once to confirm"],
    };
  }

  // (9) Unknown failure class: escalate.
  return { action: ESCALATE_REASON, retryTests: [], reasons: ["unknown failure class; escalate to full stage"] };
}

function sortedDedupe(tests: readonly string[]): string[] {
  return [...new Set(tests)].sort();
}
