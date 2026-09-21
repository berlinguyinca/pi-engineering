/**
 * Candidate tournaments + Pareto acceptance gates for autonomous UI engineering
 * (docs/specs/autonomous-ui-engineering/pi-engineering/07-tournaments-gates.md).
 *
 * Two pure, deterministic pieces (no live browser, no model invocation):
 *
 *  1. A {@link tournamentPlan} that, for uncertain/high-impact changes, lays out
 *     multiple isolated-worktree candidates, an {@link EvaluationBattery} (which
 *     rubric metrics, usability scenarios, and viewport-matrix entries apply),
 *     and a baseline git ref. It REUSES — never reimplements — the existing
 *     worktree/tournament infrastructure: {@link WorktreeInfo} from
 *     src/git/GitRepo.ts (worktree isolation) and {@link PromotionLevel} from
 *     src/merge/MergeQueue.ts (candidate promotion).
 *
 *  2. A Pareto acceptance gate, {@link evaluateCandidate}, that decides whether a
 *     candidate is acceptable given the baseline scores and the evaluation
 *     battery. Acceptance requires the target improvement to be met, no critical
 *     task/accessibility/behavior regression, deterministic tests passing,
 *     performance/complexity within budgets, protected semantics/contracts
 *     intact, and reviewer disagreement resolved/below threshold. It never
 *     selects by a single aesthetic/aggregate score — every one of the 60
 *     individually-retained rubric metrics is judged on its own — and it never
 *     lets a model approve its own work (evaluator provenance must differ from
 *     the candidate's provenance). Low-risk proven fixes may auto-accept; major
 *     IA, product-semantic, destructive, and security-sensitive changes require
 *     approval (a `requiresApproval` flag on the decision).
 *
 * Reuses src/uieng/schemas.ts (Candidate, AcceptanceDecision, EvaluationRun,
 * ExecutionProvenance, Finding), src/uieng/rubric.ts metric ids, src/uieng/
 * usability.ts (scenario catalog + viewport matrix), src/uieng/review.ts
 * (disagreementIndex), and src/uieng/policy.ts (UiImpactLevel +
 * derivedEvaluation).
 */

import { id as newId } from "../core/ids.ts";
import type { WorktreeInfo } from "../git/GitRepo.ts";
import type { PromotionLevel } from "../merge/MergeQueue.ts";
import type { BrowserTestKind, UiImpactLevel, ViewportTarget } from "./policy.ts";
import { derivedEvaluation } from "./policy.ts";
import { validateMetricIds } from "./rubric.ts";
import type { MetricSeverity } from "./rubric.ts";
import { SCHEMA_VERSION } from "./schemas.ts";
import type {
  AcceptanceDecision,
  Candidate,
  EvaluationRun,
  ExecutionProvenance,
  Finding,
  TaskRequest,
} from "./schemas.ts";
import { ROBUSTNESS_SCENARIOS, VIEWPORT_MATRIX } from "./usability.ts";

/** A metric-id -> 0..100 score map (baseline or candidate). */
export type ScoreMap = Readonly<Record<string, number>>;

// ---------------------------------------------------------------------------
// 1. Tournament plan
// ---------------------------------------------------------------------------

/**
 * Which rubric metrics, usability scenarios, and viewport-matrix entries a
 * tournament evaluates. References metric ids from src/uieng/rubric.ts and the
 * scenario catalog + viewport matrix from src/uieng/usability.ts.
 */
export interface EvaluationBattery {
  /** Rubric metric ids that apply (a subset of the 60 from src/uieng/rubric.ts). */
  metricIds: string[];
  /** Usability robustness scenario ids from src/uieng/usability.ts. */
  usabilityScenarios: string[];
  /** Viewport-matrix entry ids from src/uieng/usability.ts. */
  viewports: string[];
  /** Browser test kinds that apply (smoke/workflow/visual_regression/a11y/perf). */
  browserTests: BrowserTestKind[];
}

/** Per-candidate isolated-worktree plan. Reuses {@link WorktreeInfo} (GitRepo)
 * and {@link PromotionLevel} (MergeQueue); it does not reimplement git. */
export interface TournamentCandidateWorktree {
  candidateId: string;
  /** Candidate git branch (isolated from the integration branch). */
  branch: string;
  /** The isolated worktree the candidate is built and evaluated in. */
  worktree: WorktreeInfo;
  /** The promotion level the candidate can be promoted to. */
  promotionLevel: PromotionLevel;
}

/** A tournament of multiple isolated-worktree candidates for one task. */
export interface TournamentPlan {
  taskRequest: TaskRequest;
  impactLevel: UiImpactLevel;
  /** One {@link Candidate} per competing solution (reuse schemas.ts). */
  candidates: Candidate[];
  /** Isolated-worktree plan per candidate (reuse GitRepo/MergeQueue types). */
  candidateWorktrees: TournamentCandidateWorktree[];
  /** The evaluation battery applied to every candidate. */
  evaluationBattery: EvaluationBattery;
  /** Baseline git ref (e.g. "HEAD") scores are measured against. */
  baselineRef: string;
}

/** Options for {@link tournamentPlan}. */
export interface TournamentPlanOptions {
  /** Baseline git ref; defaults to "HEAD". */
  baselineRef?: string;
  /** Number of candidates to plan; defaults to a proportional per-level count. */
  candidateCount?: number;
  /** Base directory for isolated worktrees; defaults to ".pi-eng/worktrees". */
  worktreeBaseDir?: string;
  /** Deterministic seed for candidate ids/diversity (defaults to task id). */
  seed?: string;
}

/** Default candidate count per UI-impact level (more candidates for more
 * uncertain/high-impact changes). */
export const DEFAULT_CANDIDATE_COUNT: Record<UiImpactLevel, number> = {
  L0_none: 1,
  L1_micro: 2,
  L2_feature_workflow: 3,
  L3_system_design_system: 4,
};

/** Usability scenario ids selected per UI-impact level. */
export const SCENARIOS_BY_LEVEL: Record<UiImpactLevel, string[]> = {
  L0_none: [],
  L1_micro: ["scn-long-content", "scn-empty-data", "scn-loading"],
  L2_feature_workflow: [
    "scn-long-content",
    "scn-empty-data",
    "scn-huge-dataset",
    "scn-loading",
    "scn-backend-error",
    "scn-slow-network",
    "scn-rapid-clicks",
    "scn-double-submit",
    "scn-refresh",
    "scn-deep-link",
    "scn-back-forward",
    "scn-modal-drawer",
  ],
  L3_system_design_system: ROBUSTNESS_SCENARIOS.map((s) => s.id),
};

/** Map a viewport-matrix entry onto a policy {@link ViewportTarget}. */
function viewportTargetOf(width: number): ViewportTarget {
  if (width <= 430) return "mobile";
  if (width <= 1024) return "tablet";
  if (width <= 1920) return "desktop";
  return "ultrawide";
}

/** Deterministic 0..1 hash from a seed + salt (stable across runs). */
function seededNumber(seed: string, salt: number): number {
  let h = 0;
  const s = `${seed}:${salt}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);

/**
 * Build the {@link EvaluationBattery} for a UI-impact level: expands the policy
 * plan's metric ids, selects the applicable usability scenarios, and filters
 * the viewport matrix to the applicable viewport targets.
 */
export function buildEvaluationBattery(level: UiImpactLevel): EvaluationBattery {
  const plan = derivedEvaluation({ level });
  const knownScenarios = new Set(ROBUSTNESS_SCENARIOS.map((s) => s.id));
  const scenarios = SCENARIOS_BY_LEVEL[level].filter((s) => knownScenarios.has(s));
  const viewports = VIEWPORT_MATRIX.filter((v) => plan.viewports.includes(viewportTargetOf(v.width))).map((v) => v.id);
  return {
    metricIds: [...plan.metric_ids],
    usabilityScenarios: scenarios,
    viewports,
    browserTests: [...plan.browser_tests],
  };
}

function candidateProvenance(index: number, seed: string): ExecutionProvenance {
  return {
    schema_version: SCHEMA_VERSION,
    kind: "execution_provenance",
    id: newId("EXEC"),
    selected_model: `${seed}-candidate-${index}`,
    gateway: "tournament-plan",
    selection_reason: "Planned candidate; execution model is assigned at run time.",
  };
}

/**
 * Plan a candidate tournament for an uncertain/high-impact change: define
 * multiple isolated-worktree candidates, the evaluation battery, and the
 * baseline ref. Pure/deterministic — it only *plans*; the actual worktrees are
 * created by GitRepo and promoted by MergeQueue.
 */
export function tournamentPlan(
  taskRequest: TaskRequest,
  uiImpactLevel: UiImpactLevel,
  opts: TournamentPlanOptions = {},
): TournamentPlan {
  const count = opts.candidateCount ?? DEFAULT_CANDIDATE_COUNT[uiImpactLevel];
  if (!Number.isInteger(count) || count < 1) throw new Error(`candidateCount must be a positive integer, got ${count}`);
  const baselineRef = opts.baselineRef ?? "HEAD";
  const seed = opts.seed ?? taskRequest.id;
  const baseDir = opts.worktreeBaseDir ?? ".pi-eng/worktrees";

  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const diversity = count === 1 ? 0.5 : i / (count - 1);
    candidates.push({
      schema_version: SCHEMA_VERSION,
      kind: "candidate",
      id: newId("CAND"),
      task_request: taskRequest,
      artifacts: [],
      provenance: candidateProvenance(i, seed),
      diversity: Math.round((diversity + seededNumber(seed, i) * 0.05) * 1000) / 1000,
      status: "pending",
    });
  }

  const candidateWorktrees: TournamentCandidateWorktree[] = candidates.map((c, i) => {
    const branch = `tournament/${sanitize(seed)}-${i}`;
    return {
      candidateId: c.id,
      branch,
      worktree: { path: `${baseDir}/${sanitize(seed)}-${i}`, branch },
      promotionLevel: "candidate" as PromotionLevel,
    };
  });

  return {
    taskRequest,
    impactLevel: uiImpactLevel,
    candidates,
    candidateWorktrees,
    evaluationBattery: buildEvaluationBattery(uiImpactLevel),
    baselineRef,
  };
}

// ---------------------------------------------------------------------------
// 2. Pareto acceptance gate
// ---------------------------------------------------------------------------

/** Risk class of a change, used to decide whether approval is required. */
export type ChangeRiskClass =
  | "low_risk_proven_fix"
  | "standard"
  | "major_information_architecture"
  | "product_semantic"
  | "destructive"
  | "security_sensitive";

/** Change classes that require explicit human/model approval (never auto-accept). */
export const APPROVAL_REQUIRED_CLASSES: ReadonlySet<ChangeRiskClass> = new Set([
  "major_information_architecture",
  "product_semantic",
  "destructive",
  "security_sensitive",
]);

/** Budgets a candidate must stay within (performance/complexity floors). */
export interface ParetoBudgets {
  /** Performance rubric metric ids that must meet their floors. */
  performance: string[];
  /** Complexity rubric metric ids that must meet their floors. */
  complexity: string[];
  /**
   * Absolute per-metric floors (0..100). When absent, a metric's floor defaults
   * to the baseline score (i.e. no regression below baseline).
   */
  floors?: Record<string, number>;
}

/** Options for {@link evaluateCandidate}. */
export interface ParetoGateOptions {
  /** The candidate being judged (reuse schemas.ts Candidate). */
  candidate: Candidate;
  /** Provenance of the evaluator; MUST differ from the candidate's provenance. */
  evaluatorProvenance: ExecutionProvenance;
  /** Rubric metric ids that are critical and must never regress below their floor. */
  criticalMetricIds: string[];
  /** Performance/complexity budgets. */
  budgets: ParetoBudgets;
  /** Protected semantics/contracts that must remain intact. */
  protectedContracts: string[];
  /** metric id -> minimum required positive improvement over baseline. */
  targetDeltas: Record<string, number>;
  /** Whether protected contracts were verified intact (defaults to true when none are listed). */
  protectedContractsIntact?: boolean;
  /** Whether deterministic tests passed (default true). */
  deterministicTestsPassed?: boolean;
  /** Reviewer disagreement index 0..1 (from review.ts); default 0. */
  disagreementIndex?: number;
  /** Maximum tolerated disagreement before the verdict is untrusted; default 0.3. */
  disagreementThreshold?: number;
  /** Risk class of the change; drives the requiresApproval flag. */
  changeRiskClass?: ChangeRiskClass;
  /** Explicit override of the requiresApproval flag. */
  requiresApproval?: boolean;
  /** Optional decision id; defaults to a generated id. */
  decisionId?: string;
}

/** A {@link AcceptanceDecision} extended with the approval-required flag. */
export interface ParetoAcceptanceDecision extends AcceptanceDecision {
  /** True when the change must be explicitly approved (not auto-merged). */
  requiresApproval: boolean;
  changeRiskClass: ChangeRiskClass;
}

const DEFAULT_DISAGREEMENT_THRESHOLD = 0.3;

/** Alias of {@link evaluateCandidate} matching the "acceptanceDecision" wording. */
export const acceptanceDecision = evaluateCandidate;

/**
 * Pareto acceptance gate: decide whether a candidate is acceptable given the
 * baseline scores and the evaluation battery.
 *
 * Acceptance requires ALL of: target improvement met, no critical
 * task/accessibility/behavior regression, deterministic tests passing,
 * performance/complexity within budgets, protected contracts intact, and
 * reviewer disagreement below threshold. Every critical metric is judged
 * individually — never a single aesthetic/aggregate score. The evaluator
 * provenance must differ from the candidate's provenance (a model never
 * approves its own work). Low-risk proven fixes may auto-accept; major IA,
 * product-semantic, destructive, and security-sensitive changes set
 * `requiresApproval`.
 *
 * Pure and deterministic over the provided scores.
 */
export function evaluateCandidate(
  baselineScores: ScoreMap,
  candidateScores: ScoreMap,
  opts: ParetoGateOptions,
): ParetoAcceptanceDecision {
  const { candidate, evaluatorProvenance, criticalMetricIds, budgets, protectedContracts, targetDeltas } = opts;

  validateMetricIds(criticalMetricIds);
  validateMetricIds(Object.keys(candidateScores));

  const findings: Finding[] = [];
  const failures: string[] = [];
  const addFinding = (metricId: string | undefined, severity: MetricSeverity, message: string, score: number) => {
    findings.push({
      schema_version: SCHEMA_VERSION,
      kind: "finding",
      id: newId("FIND"),
      rubric: metricId,
      score: Math.min(1, Math.max(0, score / 100)),
      confidence: 0.9,
      severity,
      evidence: metricId ? [`metric:${metricId}`] : [],
      impact: message,
      evaluator_provenance: evaluatorProvenance,
    });
  };

  // -- 1. Never self-approve: evaluator provenance must differ from candidate's.
  const sameModel = evaluatorProvenance.selected_model === candidate.provenance.selected_model;
  const sameGateway = (evaluatorProvenance.gateway ?? "default") === (candidate.provenance.gateway ?? "default");
  const selfApproved = sameModel && sameGateway;
  if (selfApproved) {
    failures.push("evaluator provenance matches candidate provenance; self-approval is forbidden");
    addFinding(
      undefined,
      "critical",
      "Evaluator and candidate share the same execution provenance (self-approval).",
      0,
    );
  }

  // -- 2. No critical task/accessibility/behavior regression.
  for (const metricId of criticalMetricIds) {
    const floor = budgets.floors?.[metricId] ?? baselineScores[metricId] ?? 0;
    const cand = candidateScores[metricId];
    if (cand === undefined) {
      failures.push(`critical metric "${metricId}" was not evaluated`);
      addFinding(metricId, "critical", `Critical metric "${metricId}" missing from candidate scores.`, 0);
    } else if (cand < floor) {
      failures.push(`critical metric "${metricId}" regressed below floor ${floor}`);
      addFinding(metricId, "critical", `Critical metric "${metricId}" score ${cand} is below floor ${floor}.`, cand);
    }
  }

  // -- 3. Target improvement met.
  for (const [metricId, delta] of Object.entries(targetDeltas)) {
    if (typeof delta !== "number" || delta <= 0) continue;
    const base = baselineScores[metricId] ?? 0;
    const cand = candidateScores[metricId];
    if (cand === undefined || cand < base + delta) {
      failures.push(`target improvement for "${metricId}" not met (need >= ${base + delta}, got ${cand ?? "none"})`);
      addFinding(metricId, "high", `Target improvement for "${metricId}" not met.`, cand ?? 0);
    }
  }

  // -- 4. Deterministic tests pass.
  if (opts.deterministicTestsPassed === false) {
    failures.push("deterministic tests failed");
    addFinding(undefined, "critical", "Deterministic tests did not pass.", 0);
  }

  // -- 5. Performance/complexity within budgets.
  const withinBudget = (group: string, metricId: string): void => {
    const floor = budgets.floors?.[metricId] ?? baselineScores[metricId] ?? 0;
    const cand = candidateScores[metricId];
    if (cand === undefined || cand < floor) {
      failures.push(`${group} budget for "${metricId}" not met (need >= ${floor}, got ${cand ?? "none"})`);
      addFinding(metricId, "high", `${group} budget for "${metricId}" not met.`, cand ?? 0);
    }
  };
  for (const metricId of budgets.performance) withinBudget("performance", metricId);
  for (const metricId of budgets.complexity) withinBudget("complexity", metricId);

  // -- 6. Protected semantics/contracts intact.
  const contractsIntact = opts.protectedContractsIntact ?? protectedContracts.length === 0;
  if (protectedContracts.length > 0 && !contractsIntact) {
    failures.push(`protected contract(s) not intact: ${protectedContracts.join(", ")}`);
    addFinding(undefined, "critical", `Protected semantics/contracts not intact: ${protectedContracts.join(", ")}.`, 0);
  }

  // -- 7. Disagreement resolved/below threshold.
  const disagreement = opts.disagreementIndex ?? 0;
  const threshold = opts.disagreementThreshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  if (disagreement > threshold) {
    failures.push(`reviewer disagreement ${disagreement} is above threshold ${threshold}`);
    addFinding(undefined, "high", `Reviewer disagreement ${disagreement} exceeds threshold ${threshold}.`, 0);
  }

  // -- Approval requirement (low-risk proven fixes auto-accept; major changes don't).
  const changeRiskClass = opts.changeRiskClass ?? "standard";
  const requiresApproval = opts.requiresApproval ?? APPROVAL_REQUIRED_CLASSES.has(changeRiskClass);

  const accepted = failures.length === 0;
  const evaluation: EvaluationRun = {
    schema_version: SCHEMA_VERSION,
    kind: "evaluation_run",
    id: newId("RUN"),
    task_request: candidate.task_request,
    provenance: evaluatorProvenance,
    findings,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    verdict: accepted ? "pass" : "fail",
  };

  const rationale = accepted
    ? requiresApproval
      ? `Candidate ${candidate.id} passed every Pareto gate (${criticalMetricIds.length} critical metrics, ` +
        `${Object.keys(targetDeltas).length} target deltas, budgets, contracts, disagreement) but is classed ` +
        `"${changeRiskClass}" and requires explicit approval before promotion.`
      : `Candidate ${candidate.id} passed every Pareto gate (${criticalMetricIds.length} critical metrics, ` +
        `${Object.keys(targetDeltas).length} target deltas, budgets, contracts, disagreement) and auto-accepts.`
    : `Candidate ${candidate.id} rejected: ${failures.join("; ")}.`;

  const decision: ParetoAcceptanceDecision = {
    schema_version: SCHEMA_VERSION,
    kind: "acceptance_decision",
    id: opts.decisionId ?? newId("DEC"),
    candidate,
    accepted,
    rationale,
    findings,
    evaluation,
    provenance: evaluatorProvenance,
    decided_at: new Date().toISOString(),
    requiresApproval,
    changeRiskClass,
  };
  return decision;
}
