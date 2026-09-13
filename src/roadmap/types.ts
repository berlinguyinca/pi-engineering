/**
 * Roadmap completion model (docs/specs/pi-engineering-verifiable-roadmap-completion-spec.md).
 *
 * Completion is DERIVED from evidence, never declared by an LLM. A milestone's
 * state is computed from its acceptance criteria, verification evidence,
 * dependencies, scope, and evidence freshness. Model output can never set a
 * milestone to VERIFIED directly.
 *
 * Invariants:
 *  - No evidence = no verification.
 *  - Implemented does not mean complete.
 *  - A completed roadmap version is finite and must not silently grow.
 */

export type MilestoneState =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "IMPLEMENTED"
  | "VERIFIED"
  | "NEEDS_REVERIFICATION"
  | "BLOCKED"
  | "DEFERRED";

export type EvidenceType =
  | "unit"
  | "integration"
  | "e2e"
  | "typecheck"
  | "lint"
  | "package_load"
  | "roadmap_test"
  | "dogfood"
  | "fresh_review"
  | "test";

/** A single required evidence reference inside an acceptance criterion. */
export interface EvidenceRef {
  type: EvidenceType;
  id: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  evidence: { required: EvidenceRef[] };
}

export interface MilestoneScope {
  /** Glob-ish path prefixes the milestone owns/affects (for impact invalidation). */
  paths: string[];
  symbols?: string[];
}

export interface MilestoneDef {
  id: string;
  name: string;
  /** Required milestones count toward completion; optional ones do not. */
  required: boolean;
  dependsOn: string[];
  scope: MilestoneScope;
  acceptance: AcceptanceCriterion[];
  verification: { requires: EvidenceType[] };
  /** Present only when the milestone is intentionally deferred out of scope. */
  deferredReason?: string;
}

export interface ReleaseGateRequire {
  allRequiredMilestonesVerified: boolean;
  /** Global deterministic gates. */
  tests: Record<"unit" | "integration", "pass">;
  typecheck: "pass";
  lint: "pass";
  packageLoad: "pass";
  /** Fresh-context review gate. */
  freshReview: { unresolvedCritical: number; unresolvedHigh: number };
}

export interface ReleaseGateDef {
  require: ReleaseGateRequire;
}

export interface BacklogItem {
  id: string;
  title: string;
  discoveredDuring?: string;
}

export interface WaiverDef {
  id: string;
  milestone: string;
  criterion?: string;
  reason: string;
  approvedBy: string;
  expires?: string;
}

export interface RoadmapDef {
  roadmap: { id: string; version: string; codename: string };
  milestones: MilestoneDef[];
  release_gate: ReleaseGateDef;
  backlog: BacklogItem[];
  waivers: WaiverDef[];
}

/** A recorded evidence item for a milestone/acceptance criterion. */
export interface RoadmapEvidence {
  id: string;
  milestone: string;
  criterionId?: string;
  type: EvidenceType;
  status: "pass" | "fail" | "error";
  commit: string;
  generatedAt: string;
  /** Paths this evidence covers (impact-based invalidation scope). */
  paths: string[];
  /** Command that produced it, or an artifact:// reference for manual evidence. */
  proof: string;
  source: "generated" | "manual";
  summary?: string;
}

export interface MilestoneEvaluation {
  milestone: MilestoneDef;
  state: MilestoneState;
  /** Human-readable reasons this milestone is not VERIFIED. */
  blockers: string[];
  missingEvidence: string[];
  staleEvidence: string[];
  unresolvedFindings: { critical: number; high: number };
}

export interface ReleaseGateResult {
  pass: boolean;
  blockers: string[];
  /** Key -> pass/fail for each sub-gate. */
  gates: Record<string, boolean>;
}

export interface RoadmapEvaluation {
  roadmapId: string;
  version: string;
  milestones: MilestoneEvaluation[];
  releaseGate: ReleaseGateResult;
  complete: boolean;
}

export type RoadmapCheckExitCode = 0 | 1 | 2 | 3;

export interface RoadmapCheckResult {
  roadmap: string;
  complete: boolean;
  verified: number;
  required: number;
  blockingMilestones: string[];
  releaseGate: "PASS" | "FAIL";
  exitCode: RoadmapCheckExitCode;
  detail: RoadmapEvaluation;
}
