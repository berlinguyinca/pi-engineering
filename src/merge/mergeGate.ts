/**
 * Merge gate decision (spec §31, issue #306).
 *
 * A pure, testable decision function that fences a merge on the exact PR head
 * SHA: CI results and an independent review are only accepted when they describe
 * exactly the head being merged, and failed checks are classified as base, flaky
 * or deterministic against a {@link FailureBaseline} (src/verify/failureBaseline.ts).
 *
 * The function performs no I/O and never mutates its input: it returns a
 * {@link MergeDecision} describing whether the PR can merge, should wait, or is
 * rejected. All applicable reasons are collected in a fixed order.
 */
import type { FailureBaseline } from "../verify/failureBaseline.ts";

export type CheckStatus = "pass" | "fail" | "pending" | "skipped";

export interface CheckRun {
  name: string;
  status: CheckStatus;
  sha: string;
}

export interface ReviewVerdict {
  verdict: "PASS" | "FAIL";
  sha: string;
}

export type MergeQueueEntryState = "queued" | "merging" | "merged" | "failed";

export interface MergeQueueItem {
  repo: string;
  prNumber: number;
  state: MergeQueueEntryState;
  enqueuedAt: string;
}

export interface MergeDecisionInput {
  repo: string;
  prNumber: number;
  candidateSha: string;
  prHeadSha: string;
  baseSha: string;
  checks: readonly CheckRun[];
  requiredChecks: readonly string[];
  review: ReviewVerdict | null;
  queue: readonly MergeQueueItem[];
  baseline?: Pick<FailureBaseline, "baseSha" | "failures" | "flaky">;
}

export type FailureClass = "base" | "flaky" | "deterministic";

export interface MergeDecision {
  decision: "merge" | "wait" | "reject";
  reasons: string[];
  failureClasses: Record<string, FailureClass>;
}

/** Classify a failing check name against the baseline (exact base SHA match). */
function classifyFailure(name: string, input: MergeDecisionInput): FailureClass {
  const baseline = input.baseline;
  if (baseline && baseline.baseSha === input.baseSha && baseline.failures.includes(name)) {
    return "base";
  }
  if (baseline?.flaky.includes(name)) {
    return "flaky";
  }
  return "deterministic";
}

/**
 * Decide whether `candidateSha` may merge into `repo`.
 *
 * Rules (all applicable reasons are collected in this fixed order; SHAs are
 * compared exactly and case-sensitively):
 *
 * 1. Any REJECT reason makes the decision `reject`.
 * 2. Otherwise any WAIT reason makes the decision `wait`.
 * 3. Otherwise the decision is `merge` with an empty reason list.
 */
export function decideMerge(input: MergeDecisionInput): MergeDecision {
  const reasons: string[] = [];
  const failureClasses: Record<string, FailureClass> = {};

  // REJECT: the candidate must describe exactly the PR head that was reviewed.
  if (input.candidateSha !== input.prHeadSha) {
    reasons.push(`candidate sha ${input.candidateSha} != PR head ${input.prHeadSha}`);
  }
  if (input.review && input.review.sha !== input.prHeadSha) {
    reasons.push(`review sha ${input.review.sha} != head ${input.prHeadSha}`);
  }
  for (const check of input.checks) {
    if (check.sha !== input.prHeadSha) {
      reasons.push(`check ${check.name} sha ${check.sha} != head ${input.prHeadSha}`);
    }
  }
  if (input.review?.verdict === "FAIL") {
    reasons.push("review FAIL");
  }
  for (const check of input.checks) {
    if (check.status === "fail") {
      const classification = classifyFailure(check.name, input);
      failureClasses[check.name] = classification;
      reasons.push(`check ${check.name} failed (${classification})`);
    }
  }

  if (reasons.length > 0) {
    return { decision: "reject", reasons, failureClasses };
  }

  // WAIT: not rejected, but not ready to merge yet.
  if (input.review === null) {
    reasons.push("no review");
  }
  const required = new Set(input.requiredChecks);
  for (const name of required) {
    const run = input.checks.find((check) => check.name === name);
    if (!run) {
      reasons.push(`required check ${name} missing`);
    }
  }
  for (const run of input.checks) {
    if (!required.has(run.name)) continue;
    if (run.status === "pending") reasons.push(`required check ${run.name} pending`);
    if (run.status === "skipped") reasons.push(`required check ${run.name} skipped`);
  }
  for (const other of input.queue) {
    if (other.repo !== input.repo || other.prNumber === input.prNumber) continue;
    if (other.state === "merging") {
      reasons.push(`repo ${input.repo} merging PR ${other.prNumber}`);
    }
  }
  const self = input.queue.find((item) => item.repo === input.repo && item.prNumber === input.prNumber);
  const selfAt = self?.enqueuedAt ?? "";
  for (const other of input.queue) {
    if (other.repo !== input.repo || other.prNumber === input.prNumber) continue;
    if (other.state !== "queued") continue;
    const earlier = other.enqueuedAt < selfAt || (other.enqueuedAt === selfAt && other.prNumber < input.prNumber);
    if (earlier) {
      reasons.push(`PR ${other.prNumber} queued earlier`);
    }
  }

  if (reasons.length > 0) {
    return { decision: "wait", reasons, failureClasses };
  }

  return { decision: "merge", reasons: [], failureClasses };
}
