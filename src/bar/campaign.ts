/**
 * BAR repair campaign generation (steps .../repair-engine).
 *
 * Generates bounded, dependency-ordered repair campaigns from root-cause
 * clusters. Every campaign carries the REPAIR_CAMPAIGN contract fields and the
 * hard prohibition on acceptance weakening. A campaign may not be promoted to
 * DONE until all its required affected requirements are VERIFIED (or it is
 * explicitly SPLIT with rationale).
 */

import type { RootCauseCluster } from "./cluster.ts";
import type { RepairCampaign, RequirementRecord } from "./types.ts";

export interface CampaignOptions {
  auditId: string;
  /** Global regression gate command run after every campaign. */
  globalRegressionGate?: string;
  targetedTests?: string[];
  visualGateWhenRelevant?: boolean;
}

/** Generate one bounded repair campaign per root-cause cluster. */
export function generateCampaigns(
  clusters: RootCauseCluster[],
  requirements: RequirementRecord[],
  opts: CampaignOptions,
): RepairCampaign[] {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const now = new Date().toISOString();
  return clusters.map((c, i) => {
    const deps = new Set<string>();
    for (const reqId of c.requirements) {
      for (const d of byId.get(reqId)?.dependencies ?? []) deps.add(d);
    }
    const campaignId = `BAR-CAMP-${opts.auditId.slice(-6)}-${String(i + 1).padStart(2, "0")}`;
    return {
      id: campaignId,
      auditId: opts.auditId,
      rootCause: {
        hypothesis: c.cluster,
        evidence: c.evidence,
      },
      affectedRequirements: c.requirements,
      dependencies: [...deps].filter((d) => !c.requirements.includes(d)),
      knownFailures: c.requirements
        .map((rid) => byId.get(rid))
        .filter(
          (r): r is RequirementRecord => r?.state === "FAILED" || r?.state === "PARTIAL" || r?.state === "MISSING",
        )
        .map((r) => r.id),
      scope: `Repair the ${c.requirements.length} requirements sharing root cause "${c.cluster}".`,
      prohibitedAcceptanceWeakening: true,
      targetedTests: opts.targetedTests ?? [],
      globalRegressionGate: opts.globalRegressionGate ?? "npm test",
      visualGateWhenRelevant: opts.visualGateWhenRelevant ?? false,
      independentReviewRequired: true,
      completionCriteria: [
        `all affected requirements VERIFIED (or campaign explicitly SPLIT with rationale)`,
        `targeted tests pass`,
        `global regression gate (${opts.globalRegressionGate ?? "npm test"}) passes`,
      ],
      status: "PLANNED",
      beforeEvidence: null,
      afterEvidence: null,
      createdAt: now,
    };
  });
}

/**
 * Can a campaign be marked DONE? Only when every required affected requirement
 * is VERIFIED (or the campaign is SPLIT). Otherwise REQUIRES_REVIEW at best.
 */
export function campaignSettlementStatus(
  campaign: RepairCampaign,
  requirements: RequirementRecord[],
): RepairCampaign["status"] {
  if (campaign.status === "SPLIT") return "SPLIT";
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const affected = campaign.affectedRequirements.map((id) => byId.get(id)).filter(Boolean);
  if (affected.length === 0) return "REQUIRES_REVIEW";
  const allVerified = affected.every((r) => r?.state === "VERIFIED");
  return allVerified ? "DONE" : "REQUIRES_REVIEW";
}
