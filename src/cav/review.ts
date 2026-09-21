/**
 * CAV-10 Independent Review: separate implementer and reviewer contexts.
 *
 * The implementer can produce evidence but cannot promote its own requirement
 * to VERIFIED. An independent reviewer role inspects the evidence chain and may
 * promote it. The reviewer is itself constrained by the same fail-closed rules:
 * no evidence, no VERIFIED; a deterministic failure cannot be waived by prose.
 *
 * Reconciles with the existing review machinery (src/lifecycle, src/platform/
 * review.ts) by providing the CAV-specific promotion path. This is the enabler
 * that makes earlier phases' VERIFIED state legitimate rather than self-declared.
 */
import type { CavEvidenceLedger } from "./evidence.ts";
import type { CavStatus, CavStep } from "./types.ts";

export interface ReviewVerdict {
  requirementId: string;
  reviewRole: string;
  approved: boolean;
  /** Evidence records inspected (by id) that justify the verdict. */
  inspectedEvidence: string[];
  reasons: string[];
}

export interface IndependentReviewOptions {
  ledger: CavEvidenceLedger;
  reviewRole: string;
  workerRunId: string;
  gitSha: string;
  /** Reviewer's human-readable assessment (cannot waive a deterministic failure). */
  assessment?: string;
}

/**
 * Evaluate whether a step is eligible for VERIFIED promotion from an
 * independent reviewer's perspective.
 *
 * Returns a verdict WITHOUT mutating the ledger; the caller applies promotion
 * only if the verdict is approved. This keeps the reviewer's reasoning
 * separated from implementer rationale.
 */
export async function evaluateIndependentReview(step: CavStep, opts: IndependentReviewOptions): Promise<ReviewVerdict> {
  const { ledger, reviewRole } = opts;
  const reasons: string[] = [];
  const evidence = ledger.byRequirement(step.id);
  const inspected = evidence.map((e) => e.id);

  if (evidence.length === 0) {
    return {
      requirementId: step.id,
      reviewRole,
      approved: false,
      inspectedEvidence: [],
      reasons: ["no evidence recorded; no evidence = no verification"],
    };
  }

  const latest = ledger.latestEvidence(step.id)!;
  // The latest evidence must show a passing deterministic gate. A SPECIFIED /
  // failed / UNKNOWN status cannot be approved.
  if (latest.status === "VERIFIED") {
    reasons.push(`already VERIFIED (evidence ${latest.id})`);
    return { requirementId: step.id, reviewRole, approved: true, inspectedEvidence: inspected, reasons };
  }
  if (latest.exit_code !== 0) {
    reasons.push(`latest evidence ${latest.id} has non-zero exit code ${latest.exit_code}`);
    return { requirementId: step.id, reviewRole, approved: false, inspectedEvidence: inspected, reasons };
  }
  // Only TESTED/IMPLEMENTED/RECONCILED etc. with exit 0 are promotable.
  if (latest.status !== "TESTED" && latest.status !== "IMPLEMENTED" && latest.status !== "RECONCILED") {
    reasons.push(`latest evidence ${latest.id} is ${latest.status}, not a passing gate`);
    return { requirementId: step.id, reviewRole, approved: false, inspectedEvidence: inspected, reasons };
  }

  reasons.push(
    `inspected ${inspected.length} evidence record(s); latest ${latest.id} exit 0, gate ${latest.gate_type}`,
  );
  return { requirementId: step.id, reviewRole, approved: true, inspectedEvidence: inspected, reasons };
}

/**
 * Apply a reviewer's approved promotion to VERIFIED. Throws if the verdict was
 * not approved or the role lacks promotion rights (enforced by the ledger).
 */
export async function applyReviewPromotion(
  step: CavStep,
  verdict: ReviewVerdict,
  opts: IndependentReviewOptions,
): Promise<CavStatus> {
  if (!verdict.approved) {
    throw new Error(`reviewer cannot promote ${step.id}: verdict not approved`);
  }
  await opts.ledger.promote(
    step.id,
    "VERIFIED",
    {
      gitSha: opts.gitSha,
      role: opts.reviewRole,
      workerRunId: opts.workerRunId,
      gateType: "independent-review",
      tool: "review",
      command: `independent review of ${step.id}`,
      exitCode: 0,
      environment: "review-context",
      failureReason: null,
    },
    opts.ledger.latestStatus(step.id),
  );
  return "VERIFIED";
}
