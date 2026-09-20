/**
 * BAR audit report generation (AUDIT_REPORT contract).
 *
 * Reports counts for every state; never collapses UNKNOWN/PARTIAL/BLOCKED into
 * PASS. Percent verified uses an explicit denominator. Includes source revision,
 * runtime environment, audit coverage, untested surfaces, top root-cause
 * clusters, dependency ordering, generated campaigns, before/after deltas, and
 * exact next action.
 */

import type { RootCauseCluster } from "./cluster.ts";
import { BAR_STATES } from "./types.ts";
import type {
  AuditBaseline,
  AuditReport,
  BarClassification,
  BarState,
  RepairCampaign,
  RequirementRecord,
} from "./types.ts";

export interface ReportInput {
  project: string;
  sourceRevision: string;
  cwd: string;
  requirements: RequirementRecord[];
  baseline: AuditBaseline;
  clusters: RootCauseCluster[];
  dependencyOrder: string[];
  unresolvedDependencies: string[];
  campaigns: RepairCampaign[];
  deltas: AuditReport["beforeAfterDeltas"];
  /** Surfaces actually exercised; the rest are untested. */
  coveredSurfaces?: string[];
  allSurfaces?: string[];
}

/** Build the audit report. */
export function buildAuditReport(input: ReportInput): AuditReport {
  const stateCounts = Object.fromEntries(BAR_STATES.map((s) => [s, 0])) as Record<BarState, number>;
  for (const r of input.requirements) stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1;

  const verifiedDenominator = input.requirements.length;
  const verifiedCount = stateCounts.VERIFIED ?? 0;
  const percentVerified = verifiedDenominator === 0 ? 0 : Math.round((verifiedCount / verifiedDenominator) * 100);

  const covered = input.coveredSurfaces ?? input.baseline.services;
  const all = input.allSurfaces ?? covered;
  const untested = all.filter((s) => !covered.includes(s));

  const nextAction =
    verifiedDenominator === 0
      ? "No requirements atomized; run discovery and atomize requirements before any repair."
      : stateCounts.VERIFIED === verifiedDenominator
        ? "All required non-deferred requirements are VERIFIED and global gates pass."
        : (stateCounts.BLOCKED ?? 0) > 0
          ? "Resolve recorded blockers, then re-run the affected campaign under CAV."
          : "Execute the next dependency-ordered repair campaign and reconcile after it.";

  return {
    auditId: input.baseline.auditId,
    project: input.project,
    sourceRevision: input.sourceRevision,
    environment: { platform: process.platform, node: process.versions?.node ?? "unknown", cwd: input.cwd },
    stateCounts,
    verifiedCount,
    verifiedDenominator,
    percentVerified,
    coverage: { surfaces: covered, untested },
    rootCauseClusters: input.clusters.map((c) => c),
    dependencyOrder: input.dependencyOrder,
    campaigns: input.campaigns.map((c) => c.id),
    beforeAfterDeltas: input.deltas,
    nextAction,
    createdAt: new Date().toISOString(),
  };
}

/** Render a compact human-readable report for the CLI. */
export function renderReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`BAR Audit ${report.auditId} — ${report.project}`);
  lines.push(`  source: ${report.sourceRevision}`);
  lines.push(`  environment: ${report.environment.platform} node ${report.environment.node}`);
  const counts = Object.entries(report.stateCounts)
    .filter(([, n]) => (n as number) > 0)
    .map(([s, n]) => `${s}=${n}`)
    .join(", ");
  lines.push(`  states: ${counts}`);
  lines.push(`  verified: ${report.verifiedCount}/${report.verifiedDenominator} (${report.percentVerified}%)`);
  lines.push(`  untested surfaces: ${report.coverage.untested.join(", ") || "(none)"}`);
  lines.push(`  root-cause clusters: ${report.rootCauseClusters.length}`);
  lines.push(`  campaigns: ${report.campaigns.join(", ") || "(none)"}`);
  lines.push(`  next action: ${report.nextAction}`);
  return lines.join("\n");
}

/** Convenience for explicit classifications used by the CLI. */
export function parseClassification(raw: string): BarClassification {
  const v = raw.trim().toUpperCase();
  const allowed: BarClassification[] = [
    "VERIFIED",
    "FAILED",
    "PARTIAL",
    "MISSING",
    "UNKNOWN",
    "BLOCKED",
    "ORPHAN",
    "OBSOLETE",
  ];
  if (!allowed.includes(v as BarClassification)) throw new Error(`invalid classification: ${raw}`);
  return v as BarClassification;
}
