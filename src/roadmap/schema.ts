/**
 * Roadmap YAML parsing + structural validation (spec §21).
 *
 * An invalid roadmap definition MUST make roadmap checking fail with exit code 2.
 * Validation is deterministic and model-free.
 */
import { parse } from "yaml";
import type { MilestoneDef, RoadmapDef } from "./types.ts";

export interface SchemaIssue {
  path: string;
  message: string;
}

function assertUnique<T>(items: T[], getter: (t: T) => string, what: string, issues: SchemaIssue[]): void {
  const seen = new Set<string>();
  for (const it of items) {
    const k = getter(it);
    if (seen.has(k)) issues.push({ path: what, message: `duplicate ${what} id: ${k}` });
    seen.add(k);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown, path: string, issues: SchemaIssue[]): string[] {
  if (!Array.isArray(v)) {
    issues.push({ path, message: `expected an array, got ${typeof v}` });
    return [];
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") issues.push({ path, message: `expected a string element, got ${typeof x}` });
    else out.push(x);
  }
  return out;
}

/**
 * Parse a roadmap YAML document into a RoadmapDef, collecting structural issues.
 * Returns null (with issues) when the document is not a valid roadmap shape.
 */
export function parseRoadmap(
  yamlText: string,
  allowedEvidenceTypes?: Set<string>,
): { roadmap: RoadmapDef | null; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = [];
  const validateType = (type: string, path: string): void => {
    if (allowedEvidenceTypes && !allowedEvidenceTypes.has(type)) {
      issues.push({ path, message: `unknown evidence type "${type}"` });
    }
  };
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (err) {
    issues.push({ path: "$", message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` });
    return { roadmap: null, issues };
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.roadmap)) {
    issues.push({ path: "$", message: "top-level 'roadmap' object is required" });
    return { roadmap: null, issues };
  }
  const header = doc.roadmap;
  const id = typeof header.id === "string" ? header.id : "";
  const version = typeof header.version === "string" ? header.version : "";
  const codename = typeof header.codename === "string" ? header.codename : "";
  if (!id) issues.push({ path: "roadmap.id", message: "roadmap.id is required" });
  if (!version) issues.push({ path: "roadmap.version", message: "roadmap.version is required" });

  // Milestones.
  const milestones: MilestoneDef[] = [];
  const rawMs = Array.isArray(doc.milestones) ? doc.milestones : [];
  for (let i = 0; i < rawMs.length; i++) {
    const m = rawMs[i];
    const p = `milestones[${i}]`;
    if (!isPlainObject(m)) {
      issues.push({ path: p, message: "milestone must be an object" });
      continue;
    }
    const mid = typeof m.id === "string" ? m.id : "";
    if (!mid) issues.push({ path: `${p}.id`, message: "milestone id is required" });
    const name = typeof m.name === "string" ? m.name : "";
    const required = m.required === true;
    const deferredReason = typeof m.deferred_reason === "string" ? m.deferred_reason : undefined;
    if (required && deferredReason) {
      issues.push({
        path: `${p}`,
        message: `required milestone ${mid} cannot be silently deferred (remove deferred_reason or make it non-required)`,
      });
    }
    const dependsOn = asStringArray(m.depends_on, `${p}.depends_on`, issues);
    const scopeRaw = isPlainObject(m.scope) ? m.scope : {};
    const scopePaths = asStringArray(scopeRaw.paths, `${p}.scope.paths`, issues);
    const symbols = Array.isArray(scopeRaw.symbols) ? (scopeRaw.symbols as string[]) : [];

    const acceptance: MilestoneDef["acceptance"] = [];
    const rawAcc = Array.isArray(m.acceptance) ? m.acceptance : [];
    for (let j = 0; j < rawAcc.length; j++) {
      const a = rawAcc[j];
      const ap = `${p}.acceptance[${j}]`;
      if (!isPlainObject(a)) {
        issues.push({ path: ap, message: "acceptance criterion must be an object" });
        continue;
      }
      const aid = typeof a.id === "string" ? a.id : "";
      if (!aid) issues.push({ path: `${ap}.id`, message: "criterion id is required" });
      const desc = typeof a.description === "string" ? a.description : "";
      const evRaw = isPlainObject(a.evidence) ? a.evidence : {};
      const reqRaw = Array.isArray(evRaw.required) ? evRaw.required : [];
      const required: EvidenceRefLoose[] = [];
      for (let k = 0; k < reqRaw.length; k++) {
        const r = reqRaw[k];
        if (!isPlainObject(r)) {
          issues.push({ path: `${ap}.evidence.required[${k}]`, message: "evidence ref must be an object" });
          continue;
        }
        if (typeof r.type !== "string")
          issues.push({ path: `${ap}.evidence.required[${k}].type`, message: "evidence type is required" });
        if (typeof r.id !== "string")
          issues.push({ path: `${ap}.evidence.required[${k}].id`, message: "evidence id is required" });
        if (typeof r.type === "string") validateType(r.type, `${ap}.evidence.required[${k}].type`);
        required.push({ type: r.type as never, id: r.id as string });
      }
      acceptance.push({ id: aid, description: desc, evidence: { required: required as never } });
    }
    assertUnique(acceptance, (a) => a.id, `${p} acceptance`, issues);

    const requires: EvidenceRefLoose[] = [];
    const verRaw = isPlainObject(m.verification) ? m.verification : {};
    const reqVerRaw = Array.isArray(verRaw.requires) ? verRaw.requires : [];
    for (const t of reqVerRaw) {
      if (typeof t === "string") {
        validateType(t, `${p}.verification.requires`);
        requires.push(t as never);
      } else issues.push({ path: `${p}.verification.requires`, message: "requires must be strings" });
    }

    milestones.push({
      id: mid,
      name,
      required,
      dependsOn,
      scope: { paths: scopePaths, symbols },
      acceptance,
      verification: { requires: requires as never },
      deferredReason,
    });
  }
  assertUnique(milestones, (m) => m.id, "milestone", issues);
  const byId = new Map(milestones.map((m) => [m.id, m]));

  // Dependency references must be valid and acyclic.
  for (const m of milestones) {
    for (const dep of m.dependsOn) {
      if (!byId.has(dep)) issues.push({ path: `${m.id}.depends_on`, message: `unknown dependency ${dep}` });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle: string[] = [];
  const visit = (m: MilestoneDef): boolean => {
    if (visited.has(m.id)) return false;
    if (visiting.has(m.id)) {
      cycle.push(m.id);
      return true;
    }
    visiting.add(m.id);
    for (const dep of m.dependsOn) {
      const d = byId.get(dep);
      if (d && visit(d)) {
        cycle.push(m.id);
        return true;
      }
    }
    visiting.delete(m.id);
    visited.add(m.id);
    return false;
  };
  for (const m of milestones) {
    if (visit(m)) {
      issues.push({ path: "depends_on", message: `dependency cycle detected: ${cycle.join(" -> ")}` });
      break;
    }
  }

  // Release gate.
  const rgRaw = isPlainObject(doc.release_gate) ? doc.release_gate : {};
  const requireRaw = isPlainObject(rgRaw.require) ? rgRaw.require : {};
  const testsRaw = isPlainObject(requireRaw.tests) ? requireRaw.tests : {};
  const frRaw = isPlainObject(requireRaw.fresh_review) ? requireRaw.fresh_review : {};
  const releaseGate: RoadmapDef["release_gate"] = {
    require: {
      allRequiredMilestonesVerified: requireRaw.all_required_milestones_verified !== false,
      tests: {
        unit: (testsRaw.unit ?? "pass") as "pass",
        integration: (testsRaw.integration ?? "pass") as "pass",
      },
      typecheck: (requireRaw.typecheck ?? "pass") as "pass",
      lint: (requireRaw.lint ?? "pass") as "pass",
      packageLoad: (requireRaw.package_load ?? "pass") as "pass",
      freshReview: {
        unresolvedCritical: Number(frRaw.unresolved_critical ?? 0),
        unresolvedHigh: Number(frRaw.unresolved_high ?? 0),
      },
    },
  };
  for (const k of ["unit", "integration"] as const) {
    if (releaseGate.require.tests[k] !== "pass")
      issues.push({ path: `release_gate.require.tests.${k}`, message: "must be 'pass'" });
  }

  // Backlog.
  const backlog: RoadmapDef["backlog"] = [];
  const rawBg = Array.isArray(doc.backlog) ? doc.backlog : [];
  for (let i = 0; i < rawBg.length; i++) {
    const b = rawBg[i];
    if (!isPlainObject(b) || typeof b.id !== "string") {
      issues.push({ path: `backlog[${i}]`, message: "backlog item needs an id" });
      continue;
    }
    backlog.push({
      id: b.id,
      title: typeof b.title === "string" ? b.title : "",
      discoveredDuring: typeof b.discovered_during === "string" ? b.discovered_during : undefined,
    });
  }
  assertUnique(backlog, (b) => b.id, "backlog item", issues);

  // Waivers.
  const waivers: RoadmapDef["waivers"] = [];
  const rawWv = Array.isArray(doc.waivers) ? doc.waivers : [];
  for (let i = 0; i < rawWv.length; i++) {
    const w = rawWv[i];
    if (!isPlainObject(w) || typeof w.id !== "string") {
      issues.push({ path: `waivers[${i}]`, message: "waiver needs an id" });
      continue;
    }
    waivers.push({
      id: w.id,
      milestone: typeof w.milestone === "string" ? w.milestone : "",
      criterion: typeof w.criterion === "string" ? w.criterion : undefined,
      reason: typeof w.reason === "string" ? w.reason : "",
      approvedBy: typeof w.approved_by === "string" ? w.approved_by : "operator",
      expires: typeof w.expires === "string" ? w.expires : undefined,
    });
  }

  if (issues.length > 0) return { roadmap: null, issues };
  return {
    roadmap: {
      roadmap: { id, version, codename },
      milestones,
      release_gate: releaseGate,
      backlog,
      waivers,
    },
    issues,
  };
}

interface EvidenceRefLoose {
  type: string;
  id: string;
}
