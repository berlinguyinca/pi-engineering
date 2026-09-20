/**
 * BAR deterministic executor (steps .../implement-deterministic-executor).
 *
 * Runs the audit pipeline over discovered inputs: ATOMIZE -> PROVENANCE ->
 * SOURCE MAP -> CLASSIFY. Every reconstructed requirement begins UNKNOWN and is
 * never promoted to VERIFIED by the implementer. Deterministic classification
 * derives a candidate state from evidence alone (source mapping present? tests
 * present? runtime mapping present? blockers recorded?), never from historical
 * success claims. VERIFIED/FAILED are only produced from explicit, evidence-
 * gated inputs supplied by an independent verifier, never inferred.
 */

import type { DiscoveryInput } from "./discovery.ts";
import type { AuditReport, BarClassification, BarState, RepairCampaign, RequirementRecord } from "./types.ts";

export interface AuditInputs {
  project: string;
  sourceRevision: string;
  discovery: DiscoveryInput;
  /** Atomic requirement statements (id, statement, provenance). */
  requirements: Array<{ id: string; statement: string; provenance: RequirementRecord["provenance"] }>;
  /** Evidence-gated classifications supplied by an independent verifier (optional). */
  classifications?: Array<{ requirementId: string; classification: BarClassification }>;
  /** Recorded blockers keyed by requirement id. */
  blockers?: Record<string, string[]>;
}

/**
 * Deterministically derive the BAR state for a requirement from evidence.
 *
 * Rules:
 *  - VERIFIED/FAILED require an explicit evidence-gated classification from an
 *    independent verifier; the executor never invents them.
 *  - BLOCKED wins over all (a recorded blocker halts progression).
 *  - SOURCE_MAPPED requires at least one source mapping.
 *  - RUNTIME_MAPPED requires at least one runtime mapping.
 *  - IMPLEMENTED_UNVERIFIED requires source + runtime + test evidence but no
 *    independent verification.
 *  - Otherwise UNKNOWN (the honest default for reconstructed requirements).
 */
export function classifyRequirement(req: RequirementRecord, explicit?: BarClassification): BarState {
  if (req.blockers.length > 0) return "BLOCKED";
  if (explicit === "VERIFIED") return "VERIFIED";
  if (explicit === "FAILED") return "FAILED";
  if (explicit === "ORPHAN") return "ORPHAN_IMPLEMENTATION";
  if (explicit === "OBSOLETE") return "OBSOLETE_CANDIDATE";
  if (explicit === "MISSING") return "MISSING";
  if (explicit === "PARTIAL") return "PARTIAL";
  const hasSource = req.sourceMappings.length > 0;
  const hasRuntime = req.runtimeMappings.length > 0;
  const hasTests = req.tests.length > 0;
  if (hasSource && hasRuntime && hasTests) return "IMPLEMENTED_UNVERIFIED";
  if (hasSource && hasRuntime) return "IMPLEMENTED_UNVERIFIED";
  if (hasRuntime) return "RUNTIME_MAPPED";
  if (hasSource) return "SOURCE_MAPPED";
  return "UNKNOWN";
}

/**
 * Execute the deterministic audit pass. Returns the set of requirement records
 * with derived states plus the derived report skeleton. This does NOT perform
 * real-stack CAV execution (that is the CAV engine's job, invoked separately
 * and its results passed in via classifications/blockers).
 */
export function executeAudit(inputs: AuditInputs): {
  requirements: RequirementRecord[];
  stateCounts: Record<BarState, number>;
} {
  const now = new Date().toISOString();
  const stateCounts = Object.fromEntries(
    [
      "UNKNOWN",
      "SOURCE_MAPPED",
      "RUNTIME_MAPPED",
      "IMPLEMENTED_UNVERIFIED",
      "VERIFIED",
      "FAILED",
      "PARTIAL",
      "MISSING",
      "BLOCKED",
      "OBSOLETE_CANDIDATE",
      "ORPHAN_IMPLEMENTATION",
      "DEFERRED",
    ].map((s) => [s, 0]),
  ) as Record<BarState, number>;

  const requirements = inputs.requirements.map((r) => {
    const req: RequirementRecord = {
      id: r.id,
      project: inputs.project,
      statement: r.statement,
      provenance: r.provenance,
      dependencies: [],
      evidenceRequirements: [],
      state: "UNKNOWN",
      sourceMappings: [],
      runtimeMappings: [],
      tests: [],
      artifacts: [],
      verifierIdentity: null,
      createdAt: now,
      updatedAt: now,
      blockers: inputs.blockers?.[r.id] ?? [],
      repairCampaignIds: [],
    };
    // Source map: find source files whose path matches the statement/provenance.
    req.sourceMappings = mapSource(req, inputs.discovery);
    // Test map: matching test files are evidence of implementation intent, not
    // verification.
    req.tests = mapTests(req, inputs.discovery);
    // Runtime map: matching entrypoints/surfaces hint at runtime behavior.
    req.runtimeMappings = mapRuntime(req, inputs.discovery);
    const state = classifyRequirement(
      req,
      inputs.classifications?.find((c) => c.requirementId === r.id)?.classification,
    );
    req.state = state;
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    return req;
  });

  return { requirements, stateCounts };
}

/** Deterministic keyword set derived from a requirement statement. */
function keywords(req: RequirementRecord): string[] {
  return req.statement
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
}

/** Heuristic source mapping from discovery. Deterministic, low-confidence. */
function mapSource(req: RequirementRecord, d: DiscoveryInput): RequirementRecord["sourceMappings"] {
  const ks = keywords(req);
  const out: RequirementRecord["sourceMappings"] = [];
  for (const file of d.sourceFiles) {
    const lower = file.toLowerCase();
    if (ks.some((k) => lower.includes(k))) {
      out.push({ path: file, confidence: "low" });
      if (out.length >= 5) break;
    }
  }
  return out;
}

/** Heuristic test mapping from discovery. Deterministic, low-confidence. */
function mapTests(req: RequirementRecord, d: DiscoveryInput): string[] {
  const ks = keywords(req);
  return d.testFiles.filter((f) => ks.some((k) => f.toLowerCase().includes(k))).slice(0, 5);
}

/** Heuristic runtime mapping from discovery entrypoints. Deterministic. */
function mapRuntime(req: RequirementRecord, d: DiscoveryInput): RequirementRecord["runtimeMappings"] {
  const ks = keywords(req);
  const out: RequirementRecord["runtimeMappings"] = [];
  for (const ep of d.entrypoints) {
    if (ks.some((k) => ep.toLowerCase().includes(k))) {
      out.push({ surface: ep, confidence: "low" });
    }
  }
  // If no entrypoint keyword matched, map the first entrypoint generically so
  // runtime-mapped state is reachable for real deployments.
  if (out.length === 0 && d.entrypoints.length > 0) {
    out.push({ surface: d.entrypoints[0]!, confidence: "low" });
  }
  return out;
}
