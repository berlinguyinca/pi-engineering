/**
 * Release gate evaluation (spec §9, §28).
 *
 * The roadmap is COMPLETE only when the release gate passes: every required
 * milestone is VERIFIED, all deterministic gates pass, and the fresh-context
 * review gate reports no unresolved critical/high findings.
 */
import type { MilestoneEvaluation, ReleaseGateDef, ReleaseGateResult, RoadmapDef } from "./types.ts";

export interface GateStatusProvider {
  /** Deterministic gate (tests/typecheck/lint/package_load) pass/fail. */
  deterministic(type: "unit" | "integration" | "typecheck" | "lint" | "package_load"): Promise<boolean>;
  /** Unresolved critical/high findings from the fresh-context review gate. */
  freshReview(): Promise<{ critical: number; high: number }>;
  /** A recorded + fresh manual dogfood evidence record exists. */
  dogfood(): Promise<boolean>;
}

export async function evaluateReleaseGate(
  roadmap: RoadmapDef,
  evaluations: Map<string, MilestoneEvaluation>,
  gate: GateStatusProvider,
): Promise<ReleaseGateResult> {
  const req: ReleaseGateDef["require"] = roadmap.release_gate.require;
  const gates: Record<string, boolean> = {};
  const blockers: string[] = [];

  const requiredMilestones = roadmap.milestones.filter((m) => m.required);
  const allVerified = requiredMilestones.every((m) => evaluations.get(m.id)?.state === "VERIFIED");
  gates.all_required_milestones_verified = allVerified;
  if (!allVerified) {
    const notVerified = requiredMilestones
      .filter((m) => evaluations.get(m.id)?.state !== "VERIFIED")
      .map((m) => `${m.id} (${evaluations.get(m.id)?.state})`);
    blockers.push(`required milestones not verified: ${notVerified.join(", ")}`);
  }

  const dg = async (
    type: "unit" | "integration" | "typecheck" | "lint" | "package_load",
    key: string,
  ): Promise<void> => {
    const ok = await gate.deterministic(type);
    gates[key] = ok;
    if (!ok) blockers.push(`${key} gate failed`);
  };
  await dg("unit", "tests.unit");
  await dg("integration", "tests.integration");
  await dg("typecheck", "typecheck");
  await dg("lint", "lint");
  await dg("package_load", "package_load");

  const fr = await gate.freshReview();
  const frOk = fr.critical <= req.freshReview.unresolvedCritical && fr.high <= req.freshReview.unresolvedHigh;
  gates.fresh_review = frOk;
  if (!frOk) blockers.push(`fresh-review gate failed: ${fr.critical} critical, ${fr.high} high`);

  const dogOk = await gate.dogfood();
  gates.dogfood = dogOk;
  if (!dogOk) blockers.push("dogfood gate failed: no fresh recorded dogfood evidence");

  const pass = blockers.length === 0;
  return { pass, blockers, gates };
}
