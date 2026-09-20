/**
 * BAR (Brownfield Audit & Remediation) core types.
 *
 * Root of Trust (docs/specs/bar/MASTER.md): reconstructed requirements begin
 * UNKNOWN until current evidence verifies them; the implementer cannot mark its
 * own requirement VERIFIED; deterministic failures cannot be overridden by model
 * judgment. This reconciles with the existing CAV architecture (src/cav) and
 * Engineering Ledger (src/ledger) rather than replacing them: BAR adds the
 * brownfield requirement/provenance/source-map/baseline/campaign model on top
 * of the same append-only, role-gated evidence discipline.
 */

/**
 * Requirement states from MASTER.md. All reconstructed requirements begin
 * UNKNOWN; source presence alone never infers VERIFIED.
 */
export const BAR_STATES = [
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
] as const;

export type BarState = (typeof BAR_STATES)[number];

/** Candidate classification vocabulary required by the BAR capability. */
export type BarClassification =
  | "VERIFIED"
  | "FAILED"
  | "PARTIAL"
  | "MISSING"
  | "UNKNOWN"
  | "BLOCKED"
  | "ORPHAN"
  | "OBSOLETE";

/** Deterministic gate verdict. UNKNOWN is never PASS. */
export type BarGateStatus = "PASS" | "FAIL" | "BLOCKED" | "UNKNOWN";

/**
 * REQUIREMENT_RECORD contract.
 *
 * Required fields: id, project, statement, source provenance (file/section/hash
 * when available), dependencies, evidence requirements, current state, source
 * mappings, runtime mappings, tests, artifacts, verifier identity, timestamps,
 * blockers, repair campaign IDs. Requirements start UNKNOWN. Never infer
 * VERIFIED from source presence.
 */
export interface RequirementRecord {
  id: string;
  project: string;
  statement: string;
  /** Provenance: file, section, and content hash when available. */
  provenance: { file: string; section?: string; hash?: string } | null;
  /** Other requirement ids this one depends on. */
  dependencies: string[];
  /** What evidence is required to mark this requirement VERIFIED. */
  evidenceRequirements: string[];
  state: BarState;
  /** Source locations mapped to this requirement. */
  sourceMappings: SourceMapping[];
  /** Runtime locations mapped to this requirement. */
  runtimeMappings: RuntimeMapping[];
  /** Test references. */
  tests: string[];
  /** Artifact references (artifact:// URIs). */
  artifacts: string[];
  /** Identity that recorded the last evidence (implementer can record TESTED, never VERIFIED). */
  verifierIdentity: string | null;
  createdAt: string;
  updatedAt: string;
  /** Non-empty when state is BLOCKED. */
  blockers: string[];
  /** Repair campaign ids that reference this requirement. */
  repairCampaignIds: string[];
}

export interface SourceMapping {
  path: string;
  symbol?: string;
  /** How confident the mapping is. */
  confidence: "high" | "medium" | "low";
}

export interface RuntimeMapping {
  /** e.g. "service/route", "console/panel", "gateway/endpoint". */
  surface: string;
  detail?: string;
  confidence: "high" | "medium" | "low";
}

/**
 * BASELINE contract.
 *
 * Before repair, persist an immutable audit baseline containing requirement
 * matrix, source revision, environment fingerprint, service/topology inventory,
 * CAV results, screenshots, traces, console/network errors, logs,
 * performance/soak observations, visual findings and generated defect ledger.
 * Baselines are append-only and addressable by audit ID.
 */
export interface AuditBaseline {
  auditId: string;
  project: string;
  sourceRevision: string;
  environment: { platform: string; node: string; cwd: string; fingerprint: string };
  createdAt: string;
  immutable: true;
  requirements: Array<{ id: string; state: BarState; statement: string }>;
  services: string[];
  cavResults: Array<{ gate: string; status: BarGateStatus }>;
  findings: string[];
  defectLedgerRef: string | null;
}

/**
 * REPAIR_CAMPAIGN contract.
 *
 * A campaign is a bounded root-cause remediation unit. Required: campaign ID,
 * root-cause hypothesis/evidence, affected requirements, dependencies, known
 * failures, implementation scope, prohibited acceptance weakening, targeted
 * tests, global regression gate, visual gate when relevant, independent review,
 * completion criteria and before/after evidence. One campaign cannot be VERIFIED
 * until all required affected requirements are VERIFIED or explicitly split.
 */
export interface RepairCampaign {
  id: string;
  auditId: string;
  /** Root-cause hypothesis and the evidence that supports it. */
  rootCause: { hypothesis: string; evidence: string[] };
  affectedRequirements: string[];
  dependencies: string[];
  knownFailures: string[];
  scope: string;
  /** Explicit prohibition: never weaken protected acceptance/golden/sabotage/policy. */
  prohibitedAcceptanceWeakening: true;
  targetedTests: string[];
  globalRegressionGate: string;
  visualGateWhenRelevant: boolean;
  independentReviewRequired: true;
  completionCriteria: string[];
  status: "PLANNED" | "RUNNING" | "REQUIRES_REVIEW" | "DONE" | "SPLIT";
  beforeEvidence: string[] | null;
  afterEvidence: string[] | null;
  createdAt: string;
}

/**
 * AUDIT_REPORT contract.
 *
 * Report counts for every state; never collapse UNKNOWN/PARTIAL/BLOCKED into
 * PASS. Include source revision, runtime environment, audit coverage, untested
 * surfaces, top root-cause clusters, dependency ordering, generated campaigns,
 * before/after deltas, and exact next action. Percent verified denominator must
 * be explicit.
 */
export interface AuditReport {
  auditId: string;
  project: string;
  sourceRevision: string;
  environment: { platform: string; node: string; cwd: string };
  stateCounts: Record<BarState, number>;
  verifiedCount: number;
  /** Explicit denominator for percent verified. */
  verifiedDenominator: number;
  percentVerified: number;
  coverage: { surfaces: string[]; untested: string[] };
  rootCauseClusters: Array<{ cluster: string; requirements: string[]; evidence: string[] }>;
  dependencyOrder: string[];
  campaigns: string[];
  beforeAfterDeltas: Array<{ requirementId: string; before: BarState; after: BarState }>;
  nextAction: string;
  createdAt: string;
}
