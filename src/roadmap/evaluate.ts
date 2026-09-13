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

/** Whether a milestone has a passing evidence record for a type (any of them). */
function hasPassing(records: RoadmapEvidence[], type: EvidenceType): boolean {
  return records.some((r) => r.type === type && r.status === "pass");
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
  const required = milestoneRequiredTypes(m);
  const missingEvidence = required.filter((t) => !hasPassing(records, t));

  // Staleness: for each required type, a passing record may be stale.
  const staleEvidence: string[] = [];
  for (const t of required) {
    const passing = records.filter((r) => r.type === t && r.status === "pass");
    for (const rec of passing) {
      const changed = await freshness.isStale(m, rec);
      if (changed?.length) {
        staleEvidence.push(t);
        break;
      }
    }
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

  const hasAnyPassing = required.some((t) => hasPassing(records, t));
  const allPassingFresh = missingEvidence.length === 0 && staleEvidence.length === 0;
  const depsOk = !m.dependsOn.some((d) => {
    const s = depStates.get(d);
    return s !== "VERIFIED" && s !== "DEFERRED";
  });
  const findingsOk = findings.critical <= 0 && findings.high <= 0;

  let state: MilestoneState;
  if (staleEvidence.length > 0 && hasAnyPassing) {
    // We had passing evidence; a relevant change invalidated it.
    state = "NEEDS_REVERIFICATION";
  } else if (depBlocked) {
    state = "BLOCKED";
  } else if (allPassingFresh && implementationExists && depsOk && findingsOk) {
    state = "VERIFIED";
  } else if (implementationExists) {
    state = "IMPLEMENTED";
  } else if (!depsOk) {
    state = "BLOCKED";
  } else {
    state = "NOT_STARTED";
  }

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
  const stateOf = (id: string): MilestoneState => result.get(id)?.state ?? "NOT_STARTED";
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
    void stateOf;
  }
  return result;
}
