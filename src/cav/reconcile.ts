/**
 * CAV-14 Spec Reconciliation: compare every original requirement to
 * implementation and evidence.
 *
 * A requirement is reconciled when: (1) an implementation exists (a source
 * symbol or file covers it), (2) deterministic evidence exists for it, and (3)
 * the evidence passes. A requirement with no implementation or no passing
 * evidence is a reconciliation gap. This is the completeness check that closes
 * the loop between spec and implementation.
 */
import type { CavEvidenceLedger } from "./evidence.ts";
import type { CavStep } from "./types.ts";

export interface ReconciledRequirement {
  requirementId: string;
  implementationExists: boolean;
  evidenceExists: boolean;
  evidencePassing: boolean;
  verified: boolean;
  blockers: string[];
}

export interface ReconciliationResult {
  requirements: ReconciledRequirement[];
  reconciled: number;
  total: number;
  gaps: string[];
  complete: boolean;
}

/**
 * Reconcile every CAV step against (a) whether its implementation symbol/file
 * exists and (b) whether passing evidence is recorded.
 */
export function reconcileSpec(
  steps: CavStep[],
  ledger: CavEvidenceLedger,
  implementationExists: (step: CavStep) => boolean,
): ReconciliationResult {
  const requirements: ReconciledRequirement[] = [];
  const gaps: string[] = [];
  for (const step of steps) {
    const impl = implementationExists(step);
    const latest = ledger.latestEvidence(step.id);
    const evidenceExists = !!latest;
    const evidencePassing = !!latest && latest.exit_code === 0;
    const verified = ledger.latestStatus(step.id) === "VERIFIED";
    const blockers: string[] = [];
    if (!impl) blockers.push("no implementation");
    if (!evidenceExists) blockers.push("no evidence");
    else if (!evidencePassing) blockers.push(`evidence not passing (exit ${latest!.exit_code})`);
    if (!verified) blockers.push("not VERIFIED");
    requirements.push({
      requirementId: step.id,
      implementationExists: impl,
      evidenceExists,
      evidencePassing,
      verified,
      blockers,
    });
    if (blockers.length) gaps.push(`${step.id}: ${blockers.join(", ")}`);
  }
  const reconciled = requirements.filter((r) => r.verified).length;
  return {
    requirements,
    reconciled,
    total: requirements.length,
    gaps,
    complete: gaps.length === 0,
  };
}
