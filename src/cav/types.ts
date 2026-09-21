/**
 * CAV (Continuous Acceptance & Verification) core types.
 *
 * Root of Trust (MASTER.md): deterministic workflow state, role-gated evidence
 * ledger, protected artifacts, hard COMPLETE semantics. This reconciles with
 * the existing Engineering Ledger (src/ledger) and RoadmapEngine
 * (src/roadmap) rather than replacing them: the CAV ledger is a focused,
 * append-only evidence record bound to stable CAV requirement IDs and role
 * gates, while the roadmap engine remains the roadmap-1.0 completion model.
 */

/** Completion states from MASTER.md, in promotion order. */
export type CavStatus =
  | "SPECIFIED"
  | "IMPLEMENTED"
  | "TESTED"
  | "INTEGRATION_VERIFIED"
  | "E2E_VERIFIED"
  | "VISUALLY_VERIFIED"
  | "INDEPENDENTLY_REVIEWED"
  | "RECONCILED"
  | "VERIFIED";

/** A step may be WAIVED only by an authorized human with recorded rationale. */
export type CavStepState = CavStatus | "WAIVED" | "UNKNOWN";

/** Deterministic gate verdict for a step/phase. UNKNOWN is never PASS. */
export type CavGateStatus = "PASS" | "FAIL" | "BLOCKED" | "UNKNOWN";

export interface CavStep {
  /** e.g. "CAV-00-01". */
  id: string;
  /** e.g. "00". */
  phase: string;
  /** e.g. "Root of Trust". */
  phaseName: string;
  /** e.g. "01". */
  step: string;
  /** Short objective title (from ROADMAP.md). */
  objective: string;
  /** Relative path to the step spec under docs/specs/cav/steps/. */
  spec: string;
  /** The atomic step type within the phase (define/implement/test/sabotage/gate). */
  kind: "define" | "implement" | "test" | "sabotage" | "gate";
}

export interface CavPhase {
  /** e.g. "00". */
  id: string;
  name: string;
  /** Ordered steps within the phase. */
  steps: CavStep[];
  /** Phase-level exit gate verdict, derived from step evidence. */
  state: CavGateStatus;
  /** Human-readable reasons the phase is not PASS. */
  blockers: string[];
}

/**
 * A single CAV evidence record (EVIDENCE_LEDGER contract).
 *
 * Status promotion is role-gated: the implementer cannot write VERIFIED.
 * UNKNOWN/SKIPPED never satisfy a required gate. Fields cover the mandatory
 * evidence schema from MASTER.md.
 */
export interface CavEvidence {
  id: string;
  requirement_id: string;
  status: CavStepState;
  git_sha: string;
  /** Role that produced this record. */
  role: string;
  worker_run_id: string;
  started_at: string;
  finished_at: string;
  /** gate type, e.g. "exit-gate" | "unit" | "sabotage" | "typecheck". */
  gate_type: string;
  tool: string;
  command: string;
  exit_code: number;
  /** artifact:// or relative artifact URIs/hashes. */
  artifacts: string[];
  /** environment/stack identity. */
  environment: string;
  failure_reason: string | null;
}

/** Default protected artifact paths (PROTECTED_ARTIFACTS contract). */
export const DEFAULT_PROTECTED_PATHS: string[] = [
  "docs/specs/**",
  "tests/acceptance/contracts/**",
  "tests/cav/golden/**",
  "tests/cav/fixtures/**",
  "design/reference/**",
  "docs/specs/cav/**",
];

/**
 * Roles allowed to promote evidence to VERIFIED. The implementer is NOT among
 * them; the implementer may not mark its own requirement VERIFIED.
 */
export const VERIFIED_PROMOTER_ROLES = new Set([
  "reviewer",
  "architecture-reviewer",
  "security-review",
  "test-designer",
  "clean-room-challenger",
  "verifier",
]);

/** Roles allowed to promote to INDEPENDENTLY_REVIEWED (subset of promoters). */
export const REVIEWER_ROLES = new Set(["reviewer", "architecture-reviewer", "security-review"]);
