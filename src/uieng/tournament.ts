/**
 * Candidate tournaments + Pareto acceptance gates
 * (docs/specs/autonomous-ui-engineering/pi-engineering/07-tournaments-gates.md).
 *
 * For uncertain/high-impact UI changes we run a small tournament: multiple
 * isolated candidate worktrees (materialized through `src/git/GitRepo.ts`
 * `createWorktree`) each solve the task independently, then a Pareto gate
 * accepts a candidate only if it is not dominated on the 60 individually-
 * retained rubric metrics from `src/uieng/rubric.ts`, and never on a single
 * aesthetic/aggregate score. Integration/promotion is handed to
 * `src/merge/MergeQueue.ts` (candidate -> integration -> main); git is
 * referenced, never reimplemented here.
 *
 * All decision logic in this module is pure and deterministic.
 */

import { id as newId } from "../core/ids.ts";
import type { GitRepo, WorktreeInfo } from "../git/GitRepo.ts";
import type { PromotionLevel } from "../merge/MergeQueue.ts";
import {
  type BrowserTestKind,
  METRIC_GROUPS,
  type UiImpactLevel,
  VIEWPORT_TARGETS,
  type ViewportTarget,
  derivedEvaluation,
} from "./policy.ts";
import { METRICS, type MetricSeverity } from "./rubric.ts";
import {
  type AcceptanceDecision,
  type Candidate,
  type EvaluationRun,
  type ExecutionProvenance,
  type Finding,
  SCHEMA_VERSION,
  type TaskRequest,
} from "./schemas.ts";
import {
  ROBUSTNESS_SCENARIOS,
  type RobustnessScenario,
  type RobustnessScenarioKind,
  VIEWPORT_MATRIX,
  type ViewportMatrixEntry,
} from "./usability.ts";

// ---------------------------------------------------------------------------
// Tournament plan
// ---------------------------------------------------------------------------

/** How many competing candidates to run per UI-impact level. */
const CANDIDATE_COUNTS: Record<UiImpactLevel, number> = {
  L0_none: 1,
  L1_micro: 2,
  L2_feature_workflow: 3,
  L3_system_design_system: 5,
};

/** Robustness scenario kinds exercised per UI-impact level. */
const SCENARIO_KINDS_BY_LEVEL: Record<UiImpactLevel, readonly RobustnessScenarioKind[]> = {
  L0_none: [],
  L1_micro: ["empty_data", "loading", "refresh"],
  L2_feature_workflow: [
    "empty_data",
    "huge_dataset",
    "loading",
    "backend_error",
    "slow_network",
    "rapid_clicks",
    "double_submit",
    "refresh",
    "deep_link",
    "back_forward",
    "modal_drawer_stacking",
  ],
  L3_system_design_system: ROBUSTNESS_SCENARIOS.map((s) => s.kind),
};

/** Viewport-matrix entry ids selected by each plan viewport target. */
const VIEWPORT_ENTRY_IDS: Record<ViewportTarget, readonly string[]> = {
  mobile: ["phone-320", "phone-360", "phone-390", "phone-430"],
  tablet: ["tablet-portrait", "tablet-landscape"],
  desktop: ["laptop", "desktop"],
  ultrawide: ["ultrawide"],
};

/** Promotion path a winning candidate follows through MergeQueue. */
export const PROMOTION_LEVELS: readonly PromotionLevel[] = ["candidate", "integration", "main"];

/** Per-candidate worktree isolation slot (materialized via GitRepo.createWorktree). */
export interface CandidateWorktree {
  candidateId: string;
  /** Branch name the isolated worktree runs on. */
  branch: string;
  /** Base commit/ref the worktree forks from (the baseline). */
  base: string;
  /** 1-based slot in the tournament. */
  slot: number;
}

/** The evaluation battery a winning candidate must pass. */
export interface EvaluationBattery {
  /** The individually-retained rubric metric ids that apply (subset of the 60). */
  rubricMetricIds: string[];
  /** Usability robustness scenarios exercised. */
  scenarios: RobustnessScenario[];
  /** Viewport matrix entries evaluated against. */
  viewports: ViewportMatrixEntry[];
  /** Browser test kinds to run. */
  browserTests: BrowserTestKind[];
  reason: string;
}

/** A complete tournament plan for one task + UI-impact level. */
export interface TournamentPlan {
  schema_version: number;
  taskRequest: TaskRequest;
  impactLevel: UiImpactLevel;
  /** Number of competing candidates. */
  candidateCount: number;
  /** Candidate records (src/uieng/schemas.ts) to be executed. */
  candidates: Candidate[];
  /** Which rubric metrics + usability scenarios + viewports apply. */
  evaluationBattery: EvaluationBattery;
  /** The ref (commit/branch) every candidate forks from. */
  baselineRef: string;
  /** Isolated worktrees to materialize via GitRepo.createWorktree. */
  worktrees: CandidateWorktree[];
  /** Promotion path through MergeQueue (candidate -> integration -> main). */
  promotionLevels: readonly PromotionLevel[];
  /** L2/L3 (and higher-candidate) changes require human approval to land. */
  requiresApproval: boolean;
  reason: string;
}

export interface TournamentPlanOptions {
  /** Baseline ref every candidate forks from. Default "main". */
  baselineRef?: string;
  /** Branch prefix for candidate worktrees. Default "cand". */
  branchPrefix?: string;
}

function slugify(input: string): string {
  const slug = input
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "task";
}

/** Diversity (0..1) per candidate slot: higher-impact levels spread more. */
function diversityFor(level: UiImpactLevel, index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(((index / (count - 1)) * 0.8 + rankBonus(level)) * 100) / 100;
}

function rankBonus(level: UiImpactLevel): number {
  switch (level) {
    case "L3_system_design_system":
      return 0.2;
    case "L2_feature_workflow":
      return 0.1;
    default:
      return 0;
  }
}

/**
 * Build a tournament plan for a task at a UI-impact level. Pure/deterministic:
 * chooses candidate count, isolated worktree branches, and the evaluation
 * battery (rubric metric ids + usability robustness scenarios + viewport
 * matrix) by reusing `derivedEvaluation` from `src/uieng/policy.ts` and the
 * scenario/viewport catalogs from `src/uieng/usability.ts`. Worktrees are
 * referenced as branch slots to be materialized with `GitRepo.createWorktree`;
 * promotion follows `MergeQueue` levels — git is not reimplemented here.
 */
export function tournamentPlan(
  taskRequest: TaskRequest,
  impactLevel: UiImpactLevel,
  options: TournamentPlanOptions = {},
): TournamentPlan {
  const policyPlan = derivedEvaluation({ level: impactLevel });
  const baselineRef = options.baselineRef ?? "main";
  const branchPrefix = options.branchPrefix ?? "cand";
  const count = CANDIDATE_COUNTS[impactLevel];
  const baseSlug = slugify(taskRequest.id);

  const candidates: Candidate[] = [];
  const worktrees: CandidateWorktree[] = [];
  for (let slot = 1; slot <= count; slot++) {
    const branch = `${branchPrefix}-${baseSlug}-${slot}`;
    const provenance: ExecutionProvenance = {
      schema_version: SCHEMA_VERSION,
      kind: "execution_provenance",
      id: newId("PRV"),
      selected_model: `tournament-${slot}`,
      runtime: "tournament-plan",
    };
    const candidate: Candidate = {
      schema_version: SCHEMA_VERSION,
      kind: "candidate",
      id: newId("CAND"),
      task_request: taskRequest,
      artifacts: [],
      provenance,
      diversity: diversityFor(impactLevel, slot - 1, count),
      status: "pending",
    };
    candidates.push(candidate);
    worktrees.push({ candidateId: candidate.id, branch, base: baselineRef, slot });
  }

  const scenarios = ROBUSTNESS_SCENARIOS.filter((s) => SCENARIO_KINDS_BY_LEVEL[impactLevel].includes(s.kind));
  const viewports = policyPlan.viewports.flatMap((target) =>
    (VIEWPORT_ENTRY_IDS[target] ?? [])
      .map((id) => VIEWPORT_MATRIX.find((v) => v.id === id))
      .filter((v): v is ViewportMatrixEntry => v !== undefined),
  );

  const battery: EvaluationBattery = {
    rubricMetricIds: [...policyPlan.metric_ids],
    scenarios,
    viewports,
    browserTests: [...policyPlan.browser_tests],
    reason: policyPlan.reason,
  };

  const requiresApproval = impactLevel === "L2_feature_workflow" || impactLevel === "L3_system_design_system";

  return {
    schema_version: SCHEMA_VERSION,
    taskRequest,
    impactLevel,
    candidateCount: count,
    candidates,
    evaluationBattery: battery,
    baselineRef,
    worktrees,
    promotionLevels: [...PROMOTION_LEVELS],
    requiresApproval,
    reason: `Tournament of ${count} candidate(s) for ${impactLevel}; each candidate evaluated on ${battery.rubricMetricIds.length} individual rubric metrics across ${battery.viewports.length} viewport(s).`,
  };
}

/**
 * Materialize the isolated candidate worktrees for a plan by delegating to
 * `GitRepo.createWorktree` (src/git/GitRepo.ts). This is the reuse seam that
 * keeps git in GitRepo — the tournament only supplies branch names.
 */
export async function materializeCandidateWorktrees(
  git: GitRepo,
  plan: TournamentPlan,
  baseCommit: string,
): Promise<WorktreeInfo[]> {
  const created: WorktreeInfo[] = [];
  for (const worktree of plan.worktrees) {
    created.push(await git.createWorktree(baseCommit, worktree.branch));
  }
  return created;
}

// ---------------------------------------------------------------------------
// Pareto acceptance gate
// ---------------------------------------------------------------------------

/** Performance/complexity budget floors enforced by the gate. */
export interface GateBudgets {
  /** Minimum candidate score on every performance-group metric. Default 0. */
  performanceFloor?: number;
  /** Minimum candidate score on every complexity-group metric. Default 0. */
  complexityFloor?: number;
  /** Max allowed drop on a protected contract metric vs baseline. Default 0. */
  maxProtectedRegression?: number;
}

/** Risk flags that force a human-approval gate (never auto-merge). */
export type RiskFlag =
  | "ia_restructuring"
  | "product_semantic_change"
  | "destructive"
  | "security_sensitive"
  | "data_loss"
  | "breaking_api";

/** Default max reviewer-disagreement before a verdict is untrusted. */
export const DEFAULT_DISAGREEMENT_THRESHOLD = 0.35;

/** Metrics treated as critical when the caller does not supply its own set. */
export const DEFAULT_CRITICAL_METRIC_IDS: readonly string[] = METRICS.filter(
  (m) => m.severity === "high" || m.severity === "critical",
).map((m) => m.id);

/** Complexity-group metric ids used by the budget check. */
export const COMPLEXITY_METRIC_IDS: readonly string[] = [
  "component_complexity",
  "dependency_complexity",
  "code_duplication",
  "design_entropy",
];

export interface EvaluateCandidateOptions {
  /** The candidate under evaluation (its provenance must differ from the evaluator). */
  candidate: Candidate;
  /** Evaluator provenance; self-approval is forbidden when it matches the candidate's. */
  evaluatorProvenance: ExecutionProvenance;
  /** Metric ids treated as critical (task/accessibility/behavior). */
  criticalMetricIds?: readonly string[];
  /** Absolute floor per critical metric; defaults to the baseline score. */
  criticalMetricFloors?: Readonly<Record<string, number>>;
  /** Performance/complexity budget floors. */
  budgets?: GateBudgets;
  /** Metric ids whose protected semantics/contracts must stay intact. */
  protectedContracts?: readonly string[];
  /** metricId -> minimum required candidate-baseline delta (0..100). */
  targetDeltas?: Readonly<Record<string, number>>;
  /** Deterministic test gate result (e.g. npx tsc --noEmit + node --test). */
  deterministicTests?: { passed: boolean; failures?: readonly string[] };
  /** Reviewer-disagreement index from src/uieng/review.ts (0..1). */
  disagreementIndex?: number;
  /** Max acceptable disagreement. Default {@link DEFAULT_DISAGREEMENT_THRESHOLD}. */
  disagreementThreshold?: number;
  /** Risk flags that force human approval. */
  riskFlags?: readonly RiskFlag[];
  /** UI-impact level; L2/L3 changes require approval. */
  impactLevel?: UiImpactLevel;
}

/**
 * A Pareto acceptance decision. Extends the shared `AcceptanceDecision` schema
 * record with the `requiresApproval` flag the tournament gate requires.
 */
export interface TournamentAcceptanceDecision extends AcceptanceDecision {
  /** True when human/model approval is required before the change may land. */
  requiresApproval: boolean;
}

const clampScore = (n: number): number => {
  if (!Number.isFinite(n)) throw new Error(`Invalid score ${String(n)}; expected 0..100`);
  return Math.min(100, Math.max(0, n));
};

function normalizeScores(scores: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [metricId, value] of Object.entries(scores)) out[metricId] = clampScore(value);
  return out;
}

/** Self-approval check: same model + provider means the model judged its own work. */
function sameProvenance(a: ExecutionProvenance, b: ExecutionProvenance): boolean {
  return a.selected_model === b.selected_model && a.provider === b.provider;
}

function gateFinding(metricId: string, severity: MetricSeverity, impact: string): Finding {
  return {
    schema_version: SCHEMA_VERSION,
    kind: "finding",
    id: newId("FIND"),
    rubric: metricId,
    score: 0,
    confidence: 0.9,
    severity,
    evidence: [],
    impact,
  };
}

/**
 * Evaluate one candidate against the baseline via the Pareto acceptance gate.
 *
 * Acceptance requires ALL of:
 *   1. target improvement (expected metric deltas met),
 *   2. no critical task/accessibility/behavior regression (critical metrics at/above floor),
 *   3. deterministic tests pass,
 *   4. performance/complexity within budget floors,
 *   5. protected semantics/contracts intact (no regression beyond budget),
 *   6. reviewer disagreement resolved/below threshold,
 *   7. the evaluator is NOT the same model that produced the candidate.
 *
 * The decision is made on the 60 individually-retained rubric metrics; a single
 * aggregate/aesthetic score is never used to accept or reject. Low-risk proven
 * fixes may auto-accept; major IA / product-semantic / destructive /
 * security-sensitive changes (and L2/L3 impact) set `requiresApproval`.
 */
export function evaluateCandidate(
  baselineScores: Readonly<Record<string, number>>,
  candidateScores: Readonly<Record<string, number>>,
  options: EvaluateCandidateOptions,
): TournamentAcceptanceDecision {
  const baseline = normalizeScores(baselineScores);
  const candidate = normalizeScores(candidateScores);
  const findings: Finding[] = [];
  const reasons: string[] = [];
  let accepted = true;

  // 1. No self-approval: the evaluator must not share provenance with the candidate.
  if (sameProvenance(options.evaluatorProvenance, options.candidate.provenance)) {
    accepted = false;
    reasons.push("Self-approval: evaluator and candidate share the same provenance.");
    findings.push(gateFinding("self_approval", "critical", "Evaluator must differ from the candidate's provenance."));
  }

  // 2. Target improvement: each target metric must meet its required delta.
  for (const [metricId, delta] of Object.entries(options.targetDeltas ?? {})) {
    const b = baseline[metricId] ?? 0;
    const c = candidate[metricId] ?? 0;
    if (c - b < delta) {
      accepted = false;
      reasons.push(`Target improvement on ${metricId} not met: expected +${delta}, got ${Math.round(c - b)}.`);
      findings.push(gateFinding(metricId, "high", `Target improvement on ${metricId} not met.`));
    }
  }

  // 3. Critical metric floors: any regression below floor fails the gate.
  const criticalIds =
    options.criticalMetricIds !== undefined && options.criticalMetricIds.length > 0
      ? options.criticalMetricIds
      : DEFAULT_CRITICAL_METRIC_IDS;
  for (const metricId of criticalIds) {
    const floor = options.criticalMetricFloors?.[metricId] ?? baseline[metricId] ?? 0;
    const c = candidate[metricId];
    if (c === undefined || c < floor) {
      accepted = false;
      reasons.push(`Critical regression on ${metricId}: score ${c ?? "n/a"} below floor ${floor}.`);
      findings.push(
        gateFinding(metricId, "critical", `Critical task/accessibility/behavior regression on ${metricId}.`),
      );
    }
  }

  // 4. Deterministic tests must pass.
  if (options.deterministicTests && !options.deterministicTests.passed) {
    accepted = false;
    reasons.push("Deterministic tests did not pass.");
    findings.push(gateFinding("deterministic_tests", "critical", "Deterministic tests failed."));
  }

  // 5. Performance/complexity within budget floors.
  const perfFloor = options.budgets?.performanceFloor ?? 0;
  for (const metricId of METRIC_GROUPS.performance) {
    const c = candidate[metricId];
    if (c !== undefined && c < perfFloor) {
      accepted = false;
      reasons.push(`Performance metric ${metricId} at ${c} below floor ${perfFloor}.`);
      findings.push(gateFinding(metricId, "high", `Performance/complexity budget exceeded on ${metricId}.`));
    }
  }
  const complexityFloor = options.budgets?.complexityFloor ?? 0;
  for (const metricId of COMPLEXITY_METRIC_IDS) {
    const c = candidate[metricId];
    if (c !== undefined && c < complexityFloor) {
      accepted = false;
      reasons.push(`Complexity metric ${metricId} at ${c} below floor ${complexityFloor}.`);
      findings.push(gateFinding(metricId, "high", `Performance/complexity budget exceeded on ${metricId}.`));
    }
  }

  // 6. Protected semantics/contracts must stay intact.
  const maxProtectedRegression = options.budgets?.maxProtectedRegression ?? 0;
  for (const contractId of options.protectedContracts ?? []) {
    const b = baseline[contractId] ?? 0;
    const c = candidate[contractId] ?? 0;
    if (c < b - maxProtectedRegression) {
      accepted = false;
      reasons.push(`Protected contract ${contractId} regressed from ${b} to ${c}.`);
      findings.push(gateFinding(contractId, "critical", `Protected semantics/contract ${contractId} broken.`));
    }
  }

  // 7. Reviewer disagreement must be resolved/below threshold.
  const threshold = options.disagreementThreshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  if (options.disagreementIndex !== undefined && options.disagreementIndex > threshold) {
    accepted = false;
    reasons.push(`Reviewer disagreement ${options.disagreementIndex} above threshold ${threshold}.`);
    findings.push(gateFinding("disagreement", "medium", "Reviewer disagreement exceeds the acceptable threshold."));
  }

  // Approval requirement: L2/L3 impact or explicit risk flags.
  const requiresApproval =
    (options.riskFlags?.length ?? 0) > 0 ||
    options.impactLevel === "L2_feature_workflow" ||
    options.impactLevel === "L3_system_design_system";

  const run: EvaluationRun = {
    schema_version: SCHEMA_VERSION,
    kind: "evaluation_run",
    id: newId("EVAL"),
    task_request: options.candidate.task_request,
    provenance: options.evaluatorProvenance,
    findings,
    started_at: new Date().toISOString(),
    verdict: accepted ? "pass" : "fail",
  };

  const decision: TournamentAcceptanceDecision = {
    schema_version: SCHEMA_VERSION,
    kind: "acceptance_decision",
    id: newId("DEC"),
    candidate: options.candidate,
    accepted,
    rationale:
      reasons.length > 0 ? reasons.join("; ") : "Pareto gate passed on all individually-retained rubric metrics.",
    findings,
    evaluation: run,
    provenance: options.evaluatorProvenance,
    decided_at: new Date().toISOString(),
    requiresApproval,
  };

  return decision;
}
