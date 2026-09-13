/**
 * Deterministic milestone evaluation (spec §6, §11, §22).
 *
 * Milestone state is DERIVED from implementation presence, acceptance evidence,
 * dependencies, and evidence freshness. An LLM can never write `VERIFIED`.
 *
 * State derivation:
 *   VERIFIED             every required evidence type has a fresh passing record,
 *                        implementation exists, dependencies are VERIFIED,
 *                        findings are within the allowed budget.
 *   NEEDS_REVERIFICATION had passing evidence but at least one required evidence
 *                        type is now stale (a relevant change occurred).
 *   BLOCKED              a required dependency is BLOCKED.
 *   IMPLEMENTED          implementation exists but evidence is incomplete.
 *   IN_PROGRESS          partial implementation, no complete evidence.
 *   NOT_STARTED          no meaningful implementation or evidence.
 *   DEFERRED             explicitly deferred out of the current release scope.
 */
import type { RoadmapEvidenceStore } from "./evidence.ts";
import type {
  EvidenceType,
  MilestoneDef,
  MilestoneEvaluation,
  MilestoneState,
  RoadmapDef,
  RoadmapEvidence,
} from "./types.ts";

export interface FindingsBudget {
  critical: number;
  high: number;
}

export interface EvidenceFreshness {
  /** Returns changed files under the record's scope; empty array = fresh. */
  isStale(milestone: MilestoneDef, record: RoadmapEvidence): Promise<string[]>;
  implementationExists(milestone: MilestoneDef): Promise<boolean>;
}

/** The distinct evidence types a milestone requires (verification + acceptance). */
export function milestoneRequiredTypes(m: MilestoneDef): EvidenceType[] {
  const set = new Set<EvidenceType>(m.verification.requires);
  for (const c of m.acceptance) for (const r of c.evidence.required) set.add(r.type);
  return [...set];
}

export async function evaluateMilestone(
  m: MilestoneDef,
  store: RoadmapEvidenceStore,
  freshness: EvidenceFreshness,
  depStates: Map<string, MilestoneState>,
  findings: FindingsBudget,
): Promise<MilestoneEvaluation> {
  const blockers: string[] = [];
  if (m.deferredReason) {
    return {
      milestone: m,
      state: "DEFERRED",
      blockers: [`deferred: ${m.deferredReason}`],
      missingEvidence: [],
      staleEvidence: [],
      unresolvedFindings: findings,
    };
  }
  const records = store.byMilestone(m.id);
  const missingEvidence: string[] = [];
  const staleEvidence: string[] = [];

  // Criterion-level evidence (spec §11.2): every acceptance criterion's required
  // evidence must have a passing + fresh record bound to THAT criterion. Type-only
  // presence does not satisfy a criterion.
  const criterionSatisfied = new Map<string, boolean>();
  const coveredTypes = new Set<EvidenceType>();
  for (const c of m.acceptance) {
    let satisfied = true;
    for (const ref of c.evidence.required) {
      coveredTypes.add(ref.type);
      const candidates = records.filter((r) => r.criterionId === c.id && r.type === ref.type);
      const passing = candidates.find((r) => r.status === "pass");
      if (!passing) {
        missingEvidence.push(`${c.id}:${ref.type}`);
        satisfied = false;
        continue;
      }
      const changed = await freshness.isStale(m, passing);
      if (changed.length) {
        staleEvidence.push(`${c.id}:${ref.type}`);
        satisfied = false;
      }
    }
    criterionSatisfied.set(c.id, satisfied);
  }

  // Milestone-level evidence: verification.requires types no criterion covers.
  for (const t of m.verification.requires) {
    if (coveredTypes.has(t)) continue;
    const passing = records.find((r) => r.type === t && !r.criterionId && r.status === "pass");
    if (!passing) {
      missingEvidence.push(t);
      continue;
    }
    const changed = await freshness.isStale(m, passing);
    if (changed.length) staleEvidence.push(t);
  }

  const implementationExists = await freshness.implementationExists(m);

  // Dependencies must be VERIFIED (required deps); BLOCKED deps block this one.
  for (const dep of m.dependsOn) {
    const st = depStates.get(dep);
    if (st === "BLOCKED") {
      blockers.push(`dependency ${dep} is BLOCKED`);
    } else if (st !== "VERIFIED" && st !== "DEFERRED") {
      blockers.push(`dependency ${dep} is not verified (${st})`);
    }
  }
  const depBlocked = m.dependsOn.some((d) => depStates.get(d) === "BLOCKED");
  if (staleEvidence.length > 0) {
    blockers.push(`evidence stale: ${staleEvidence.join(", ")} (relevant change occurred)`);
  }
  if (missingEvidence.length > 0) blockers.push(`missing evidence: ${missingEvidence.join(", ")}`);
  if (!implementationExists) blockers.push("no implementation detected in scope");

  const hasAnyPassing = records.some((r) => r.status === "pass");
  // A FAILING record means verification was attempted and failed; the milestone
  // is BLOCKED, never demoted to IMPLEMENTED (which would lose the fact that
  // verification ran and failed). Any failing record — fresh or stale — is the
  // last known result for its type and must block.
  const anyFail = records.some((r) => r.status === "fail");
  const allPassingFresh = missingEvidence.length === 0 && staleEvidence.length === 0;
  const failBlocker = anyFail ? "verification failed (a required check is failing)" : "";
  const depsOk = !m.dependsOn.some((d) => {
    const s = depStates.get(d);
    return s !== "VERIFIED" && s !== "DEFERRED";
  });
  const findingsOk = findings.critical <= 0 && findings.high <= 0;

  let state: MilestoneState;
  if (anyFail) {
    // Verification ran and failed; never demote to IMPLEMENTED.
    state = "BLOCKED";
  } else if (staleEvidence.length > 0 && hasAnyPassing) {
    // We had passing evidence; a relevant change invalidated it.
    state = "NEEDS_REVERIFICATION";
  } else if (depBlocked) {
    state = "BLOCKED";
  } else if (allPassingFresh && implementationExists && depsOk && findingsOk) {
    state = "VERIFIED";
  } else if (implementationExists && !allPassingFresh && hasAnyPassing) {
    // Partial evidence present (some criteria met) but not complete.
    state = "IN_PROGRESS";
  } else if (implementationExists) {
    state = "IMPLEMENTED";
  } else if (!depsOk) {
    state = "BLOCKED";
  } else {
    state = "NOT_STARTED";
  }

  if (failBlocker) blockers.push(failBlocker);
  if (!findingsOk) blockers.push(`unresolved findings: ${findings.critical} critical, ${findings.high} high`);

  return { milestone: m, state, blockers, missingEvidence, staleEvidence, unresolvedFindings: findings };
}

/**
 * Evaluate all milestones in dependency order. Returns a map of id -> evaluation.
 * Dependencies are evaluated first so downstream milestones can read dep states.
 */
export async function evaluateAll(
  roadmap: RoadmapDef,
  store: RoadmapEvidenceStore,
  freshness: EvidenceFreshness,
  findingsProvider: (milestoneId: string) => Promise<FindingsBudget>,
): Promise<Map<string, MilestoneEvaluation>> {
  const byId = new Map(roadmap.milestones.map((m) => [m.id, m]));
  const result = new Map<string, MilestoneEvaluation>();
  // Topological order (roadmap schema guarantees acyclicity).
  const visited = new Set<string>();
  const order: MilestoneDef[] = [];
  const visit = (m: MilestoneDef): void => {
    if (visited.has(m.id)) return;
    visited.add(m.id);
    for (const d of m.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    order.push(m);
  };
  for (const m of roadmap.milestones) visit(m);
  for (const m of order) {
    const findings = await findingsProvider(m.id);
    const depStates = new Map([...result].map(([k, v]) => [k, v.state]));
    result.set(m.id, await evaluateMilestone(m, store, freshness, depStates, findings));
  }
  return result;
}
