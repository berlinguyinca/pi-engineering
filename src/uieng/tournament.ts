/**
 * Candidate tournaments + Pareto acceptance gates for autonomous UI
 * engineering (docs/specs/autonomous-ui-engineering/pi-engineering/07-tournaments-gates.md).
 *
 * Two deterministic, pure pieces (no live browser, no model invocation):
 *
 *  1. Tournament planning: for uncertain/high-impact changes we define MULTIPLE
 *     isolated-worktree candidates that compete, each carrying its own
 *     {@link ExecutionProvenance} so no single model's bias propagates. The
 *     plan derives an evaluation battery from the proportional UI policy
 *     (src/uieng/policy.ts) and references the rubric (src/uieng/rubric.ts),
 *     the runtime usability catalog (src/uieng/usability.ts), and the existing
 *     git/worktree + merge-queue infrastructure (src/git/GitRepo.ts,
 *     src/merge/MergeQueue.ts) — we reference it, never reimplement git.
 *
 *  2. Pareto gate: a candidate is accepted ONLY when it clears every gate
 *     independently (target improvement, no critical regression, deterministic
 *     tests pass, performance/complexity within budget, protected contracts
 *     intact, disagreement resolved). Decisions are made from the 60
 *     individually-retained rubric metrics (src/uieng/rubric.ts) — never from a
 *     single aesthetic/aggregate score. Models never approve their own work:
 *     the evaluator provenance MUST differ from the candidate provenance.
 *     Low-risk proven fixes may auto-accept; major IA / product-semantic /
 *     destructive / security-sensitive changes require approval (a
 *     `requiresApproval` flag on the returned decision).
 *
 * Reuses the shared schema contracts (Candidate, AcceptanceDecision,
 * EvaluationRun, ExecutionProvenance, Finding) from src/uieng/schemas.ts,
 * metric ids from src/uieng/rubric.ts, usability artifacts from
 * src/uieng/usability.ts, reviewer disagreement from src/uieng/review.ts, and
 * {@link UiImpactLevel} from src/uieng/policy.ts.
 */

import { id as newId } from "../core/ids.ts";
import type { GitRepo, WorktreeInfo } from "../git/GitRepo.ts";
import type { MergeQueue } from "../merge/MergeQueue.ts";
import { METRIC_GROUPS, derivedEvaluation } from "./policy.ts";
import type { EvaluationPlan, UiImpactLevel } from "./policy.ts";
import { disagreementIndex } from "./review.ts";
import type { ReviewerScore } from "./review.ts";
import { assertMetricKnown } from "./rubric.ts";
import type {
  AcceptanceDecision,
  Candidate,
  EvaluationRun,
  ExecutionProvenance,
  Finding,
  TaskRequest,
} from "./schemas.ts";
import {
  type CanonicalTask,
  ROBUSTNESS_SCENARIOS,
  type RobustnessScenario,
  type ViewportMatrixEntry,
  buildViewportMatrix,
} from "./usability.ts";

// ---------------------------------------------------------------------------
// Tournament plan
// ---------------------------------------------------------------------------

/** The evaluation battery a tournament runs: rubric metrics + usability pieces. */
export interface EvaluationBattery {
  /** Applicable rubric metric ids (from the proportional UI policy). */
  metric_ids: string[];
  /** Canonical usability tasks to exercise. */
  tasks: CanonicalTask[];
  /** Viewport matrix entries to render at. */
  viewports: ViewportMatrixEntry[];
  /** viewport id -> applicable rubric reflow/layout metric ids. */
  viewport_metric_groups: Record<string, string[]>;
  /** Robustness scenarios to run. */
  scenarios: RobustnessScenario[];
}

/** A full candidate-tournament plan for one task. */
export interface TournamentPlan {
  task_request: TaskRequest;
  /** The UI-impact level the tournament is scoped to. */
  ui_impact_level: UiImpactLevel;
  /** Competing isolated-worktree candidates (one per branch). */
  candidates: Candidate[];
  evaluation_battery: EvaluationBattery;
  /** Baseline ref the candidates branch from (e.g. "main" or a commit SHA). */
  baseline_ref: string;
  /** Human-readable reason for the tournament shape. */
  reason: string;
}

/** Options controlling tournament shape. */
export interface TournamentOptions {
  /** Baseline branch/commit the worktrees branch from. Default "main". */
  baselineRef?: string;
  /** Optional UI profile forwarded to the proportional policy plan. */
  uiProfile?: unknown;
  /** Explicit canonical tasks; defaults to the standard catalog. */
  tasks?: CanonicalTask[];
  /** Explicit robustness scenarios; defaults to the full catalog. */
  scenarios?: RobustnessScenario[];
  /** Explicit viewport matrix; defaults to the full matrix. */
  viewports?: ViewportMatrixEntry[];
  /** Prefix for candidate worktree branches. Default "cand". */
  branchPrefix?: string;
}

/**
 * The number of competing candidates per UI-impact level. Higher impact /
 * higher uncertainty → more isolated candidates so divergent solutions can
 * compete before any single one is promoted.
 */
const CANDIDATE_COUNT_BY_LEVEL: Record<UiImpactLevel, number> = {
  L0_none: 0,
  L1_micro: 2,
  L2_feature_workflow: 3,
  L3_system_design_system: 4,
};

/** The standard canonical-task catalog used when no tasks are supplied. */
export function defaultCanonicalTasks(): CanonicalTask[] {
  return [
    {
      id: "task-primary-flow",
      goal: "Complete the primary user journey end-to-end.",
      mode: "first_time",
      required_states: ["home", "primary"],
      success_criteria: ["Primary journey completes successfully", "State is correct at the end"],
      viewport_targets: ["phone-390", "desktop"],
    },
    {
      id: "task-keyboard-access",
      goal: "Complete a core task using only the keyboard.",
      mode: "keyboard",
      required_states: ["primary"],
      success_criteria: ["Every interactive element is reachable by keyboard", "Focus never lost or trapped"],
      viewport_targets: ["desktop"],
    },
    {
      id: "task-recovery",
      goal: "Recover cleanly from an error mid-task without losing context.",
      mode: "first_time",
      required_states: ["primary", "error"],
      success_criteria: ["Error is surfaced clearly", "Recovery preserves context"],
      viewport_targets: ["tablet-portrait"],
    },
  ];
}

/**
 * Assemble the evaluation battery for a tournament. Metric ids come from the
 * proportional UI policy for the level; viewports, scenarios, and tasks come
 * from src/uieng/usability.ts.
 */
export function buildEvaluationBattery(plan: EvaluationPlan, opts: TournamentOptions = {}): EvaluationBattery {
  const viewports = opts.viewports ?? [...buildViewportMatrix()];
  const viewportMetricGroups: Record<string, string[]> = {};
  for (const v of viewports) viewportMetricGroups[v.id] = v.metric_ids;
  return {
    metric_ids: [...plan.metric_ids],
    tasks: opts.tasks ?? defaultCanonicalTasks(),
    viewports,
    viewport_metric_groups: viewportMetricGroups,
    scenarios: opts.scenarios ?? [...ROBUSTNESS_SCENARIOS],
  };
}

/**
 * Build a tournament plan for a task at a UI-impact level. For high-impact /
 * uncertain changes this returns MULTIPLE isolated-worktree candidates with
 * distinct provenance and diversity; for L0 (no UI impact) it returns zero
 * candidates (no tournament). Pure/deterministic over the structured inputs.
 */
export function tournamentPlan(
  taskRequest: TaskRequest,
  uiImpactLevel: UiImpactLevel,
  opts: TournamentOptions = {},
): TournamentPlan {
  const plan = derivedEvaluation({ level: uiImpactLevel, uiProfile: opts.uiProfile as never });
  const battery = buildEvaluationBattery(plan, opts);
  const count = CANDIDATE_COUNT_BY_LEVEL[uiImpactLevel];
  const prefix = opts.branchPrefix ?? "cand";
  const baselineRef = opts.baselineRef ?? "main";

  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const diversity = count <= 1 ? 0 : i / (count - 1);
    candidates.push({
      schema_version: 1,
      kind: "candidate",
      id: newId("CAND"),
      task_request: taskRequest,
      artifacts: [],
      provenance: candidateProvenance(uiImpactLevel, i),
      diversity,
      status: "pending",
    });
  }

  return {
    task_request: taskRequest,
    ui_impact_level: uiImpactLevel,
    candidates,
    evaluation_battery: battery,
    baseline_ref: baselineRef,
    reason: plan.reason,
  };
}

/** Derive a deterministic per-slot provenance so candidate branches differ. */
export function candidateProvenance(level: UiImpactLevel, slot: number): ExecutionProvenance {
  return {
    schema_version: 1,
    kind: "execution_provenance",
    id: newId("EXEC"),
    provider: "uieng-tournament",
    selected_model: `candidate-${level}-${slot}`,
    site: "isolated-worktree",
    node: `slot-${slot}`,
    selection_reason: `Tournament candidate slot ${slot} for UI-impact level ${level}`,
  };
}

/**
 * A thin orchestrator that materializes the plan's isolated worktrees using the
 * existing git worktree infrastructure (src/git/GitRepo.ts) and can promote a
 * winner through the merge queue (src/merge/MergeQueue.ts). It references —
 * never reimplements — those primitives.
 */
export class TournamentRunner {
  private readonly git: GitRepo;
  private readonly queue: MergeQueue;

  constructor(git: GitRepo, queue: MergeQueue) {
    this.git = git;
    this.queue = queue;
  }

  /** Create one isolated worktree per candidate branch at the baseline. */
  async materialize(plan: TournamentPlan): Promise<WorktreeInfo[]> {
    const worktrees: WorktreeInfo[] = [];
    for (const candidate of plan.candidates) {
      const branch = `${plan.baseline_ref}-${candidate.id.toLowerCase()}`;
      const wt = await this.git.createWorktree(plan.baseline_ref, branch);
      worktrees.push(wt);
    }
    return worktrees;
  }

  /** Promote a winner branch through the merge queue (integration gate). */
  promote(branch: string): ReturnType<MergeQueue["promote"]> {
    return this.queue.promote(branch);
  }
}

// ---------------------------------------------------------------------------
// Pareto gate
// ---------------------------------------------------------------------------

/** Performance/complexity metric ids that must stay within budget. */
export const PERFORMANCE_COMPLEXITY_METRICS: readonly string[] = [...METRIC_GROUPS.performance, "component_complexity"];

/** Performance/complexity metric ids, de-duplicated and validated. */
export function performanceComplexityMetricIds(): string[] {
  return [...new Set(PERFORMANCE_COMPLEXITY_METRICS)];
}

/** Numeric budgets for the gate (performance/complexity floors). */
export interface GateBudgets {
  /** Minimum score for every performance/complexity metric (default 50). */
  performanceComplexityFloor?: number;
  /** Per-metric minimum floors overriding the group default. */
  metricFloors?: Record<string, number>;
}

/** Options to {@link evaluateCandidate} — the Pareto gate inputs. */
export interface ParetoGateOptions {
  /** Critical metric ids (task/accessibility/behavior) that have a hard floor. */
  criticalMetricIds: string[];
  budgets: GateBudgets;
  /** Protected semantics/contract names that must remain intact. */
  protectedContracts: string[];
  /** metric id -> required candidate-minus-baseline delta. */
  targetDeltas: Record<string, number>;
  /** Whether the deterministic verification tests passed. Default true. */
  deterministicTestsPass?: boolean;
  /** Whether all protected contracts are intact in the candidate. Default true. */
  protectedContractsIntact?: boolean;
  /** Observed reviewer disagreement (0..1). Default 0. */
  disagreement?: number;
  /** Max acceptable disagreement before a verdict is trusted. Default 0.2. */
  maxDisagreement?: number;
  /** Floor below which a critical metric fails. Default 50. */
  criticalFloor?: number;
  /** The candidate under evaluation (carries its own provenance). */
  candidate: Candidate;
  /** The evaluator provenance — MUST differ from the candidate's. */
  evaluatorProvenance: ExecutionProvenance;
  /** Whether this change is major IA / product-semantic / destructive / security-sensitive. */
  highRiskChange?: boolean;
  /** Explicit override forcing `requiresApproval` regardless of risk class. */
  forceRequiresApproval?: boolean;
  /** Optional pre-built evaluation run; one is synthesized when omitted. */
  evaluation?: EvaluationRun;
}

/** The gate verdict: accepted + whether human approval is still required. */
export type GatedAcceptanceDecision = AcceptanceDecision & { requiresApproval: boolean };

/** A single gate-criterion evaluation result (why the gate passed/failed). */
export interface GateCriterion {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

const clampScore = (n: number): number => Math.min(100, Math.max(0, n));

/**
 * A stable identity for a provenance: two executions are the same agent when
 * their model/gateway/provider/site/node all match. Used so a model can never
 * approve its own work.
 */
export function provenanceIdentity(prov: ExecutionProvenance): string {
  return JSON.stringify([
    prov.selected_model,
    prov.provider ?? null,
    prov.gateway ?? null,
    prov.site ?? null,
    prov.node ?? null,
  ]);
}

const APPROVAL_TRIGGER_PATTERNS: readonly RegExp[] = [
  /information\s*arch/i,
  /\bia\b/i,
  /product\s*semantic/i,
  /destructive/i,
  /security/i,
  /auth/i,
  /schema/i,
  /migration/i,
  /breaking/i,
  /redirect/i,
  /permission/i,
];

/**
 * Deterministically classify a change kind as requiring human approval. Major
 * information-architecture, product-semantic, destructive, or
 * security-sensitive changes must not be auto-accepted.
 */
export function changeRequiresApproval(changeKind: string): boolean {
  return APPROVAL_TRIGGER_PATTERNS.some((re) => re.test(changeKind));
}

/** Score lookup with a fail-fast for unknown metric ids. */
function scoreAt(scores: Record<string, number>, metricId: string): number {
  const value = scores[metricId];
  if (value === undefined) throw new Error(`Missing score for metric "${metricId}" in the gate inputs`);
  assertMetricKnown(metricId);
  return clampScore(value);
}

const findingFor = (metricId: string, message: string, severity: Finding["severity"]): Finding => ({
  schema_version: 1,
  kind: "finding",
  id: newId("FIND"),
  rubric: metricId,
  score: 0,
  confidence: 0.9,
  severity,
  evidence: [],
  impact: message,
  root_cause: `Pareto gate criterion failed for metric ${metricId}`,
});

/**
 * Evaluate a candidate against the baseline across ALL gate criteria. Returns a
 * persisted-ready {@link AcceptanceDecision} (plus a `requiresApproval` flag).
 *
 * Acceptance requires EVERY gate to pass independently:
 *  - target improvement (each required delta met);
 *  - no critical regression (each critical metric at/above its floor);
 *  - deterministic tests pass;
 *  - performance/complexity within budgets;
 *  - protected semantics/contracts intact;
 *  - disagreement resolved/below threshold.
 *
 * Models never approve their own work: if the evaluator provenance equals the
 * candidate's provenance the decision is rejected outright. The decision is
 * made from the 60 individually-retained rubric metrics — never an aggregate.
 */
export function evaluateCandidate(
  baselineScores: Record<string, number>,
  candidateScores: Record<string, number>,
  opts: ParetoGateOptions,
): GatedAcceptanceDecision {
  const { criticalMetricIds, budgets, protectedContracts, targetDeltas, candidate, evaluatorProvenance } = opts;

  const deterministicTestsPass = opts.deterministicTestsPass ?? true;
  const protectedContractsIntact = opts.protectedContractsIntact ?? true;
  const disagreement = opts.disagreement ?? 0;
  const maxDisagreement = opts.maxDisagreement ?? 0.2;
  const criticalFloor = opts.criticalFloor ?? 50;
  const performanceFloor = budgets.performanceComplexityFloor ?? 50;
  const highRiskChange = opts.highRiskChange ?? false;

  const criteria: GateCriterion[] = [];
  const findings: Finding[] = [];

  // 0. Self-approval guard: a model never approves its own work.
  const sameProvenance = provenanceIdentity(candidate.provenance) === provenanceIdentity(evaluatorProvenance);
  if (sameProvenance) {
    const finding = findingFor(
      candidate.provenance.selected_model,
      "Evaluator provenance matches candidate provenance",
      "critical",
    );
    findings.push(finding);
  }
  criteria.push({
    id: "independent_evaluator",
    label: "Independent evaluator",
    passed: !sameProvenance,
    detail: sameProvenance
      ? "Evaluator and candidate share provenance; a model cannot approve its own work."
      : "Evaluator provenance differs from candidate provenance.",
  });

  // 1. Target improvement: each required delta must be met.
  const targetIds = Object.keys(targetDeltas);
  const targetFindings: string[] = [];
  for (const metricId of targetIds) {
    const required = targetDeltas[metricId] ?? 0;
    const delta = scoreAt(candidateScores, metricId) - scoreAt(baselineScores, metricId);
    if (delta < required) targetFindings.push(`${metricId}: +${delta.toFixed(1)} < +${required}`);
  }
  const targetMet = targetFindings.length === 0;
  if (!targetMet) {
    findings.push(
      findingFor("critical_task_completion", `Target improvement not met: ${targetFindings.join("; ")}`, "high"),
    );
  }
  criteria.push({
    id: "target_improvement",
    label: "Target improvement",
    passed: targetMet,
    detail: targetMet ? "All required metric deltas met." : `Deltas missed: ${targetFindings.join("; ")}`,
  });

  // 2. No critical regression: every critical metric at/above its floor.
  const criticalFloors: string[] = [];
  for (const metricId of criticalMetricIds) {
    const score = scoreAt(candidateScores, metricId);
    const floor = budgets.metricFloors?.[metricId] ?? criticalFloor;
    if (score < floor) criticalFloors.push(`${metricId}: ${score.toFixed(1)} < ${floor}`);
  }
  const criticalMet = criticalFloors.length === 0;
  if (!criticalMet) {
    findings.push(
      findingFor(
        "critical_task_completion",
        `Critical regression below floor: ${criticalFloors.join("; ")}`,
        "critical",
      ),
    );
  }
  criteria.push({
    id: "critical_regression",
    label: "No critical regression",
    passed: criticalMet,
    detail: criticalMet ? "All critical metrics at/above their floors." : `Below floor: ${criticalFloors.join("; ")}`,
  });

  // 3. Deterministic tests pass.
  if (!deterministicTestsPass) {
    findings.push(findingFor("critical_task_completion", "Deterministic verification tests did not pass", "high"));
  }
  criteria.push({
    id: "deterministic_tests",
    label: "Deterministic tests pass",
    passed: deterministicTestsPass,
    detail: deterministicTestsPass ? "Deterministic verification passed." : "Deterministic verification failed.",
  });

  // 4. Performance/complexity within budgets.
  const perfBreaches: string[] = [];
  for (const metricId of performanceComplexityMetricIds()) {
    if (candidateScores[metricId] === undefined) continue;
    const floor = budgets.metricFloors?.[metricId] ?? performanceFloor;
    const score = scoreAt(candidateScores, metricId);
    if (score < floor) perfBreaches.push(`${metricId}: ${score.toFixed(1)} < ${floor}`);
  }
  const perfMet = perfBreaches.length === 0;
  if (!perfMet) {
    findings.push(
      findingFor("render_performance_cost", `Performance/complexity over budget: ${perfBreaches.join("; ")}`, "medium"),
    );
  }
  criteria.push({
    id: "performance_budget",
    label: "Performance/complexity within budgets",
    passed: perfMet,
    detail: perfMet ? "All performance/complexity metrics within budget." : `Over budget: ${perfBreaches.join("; ")}`,
  });

  // 5. Protected semantics/contracts intact.
  const contractMet = protectedContractsIntact && protectedContracts.length > 0 ? true : protectedContractsIntact;
  const contractDetail =
    protectedContracts.length === 0
      ? "No protected contracts declared."
      : protectedContractsIntact
        ? `Protected contracts intact: ${protectedContracts.join(", ")}`
        : `Protected contract(s) broken: ${protectedContracts.join(", ")}`;
  if (!contractMet) {
    findings.push(
      findingFor("semantic_accessibility", `Protected contracts broken: ${protectedContracts.join(", ")}`, "critical"),
    );
  }
  criteria.push({
    id: "protected_contracts",
    label: "Protected semantics/contracts intact",
    passed: contractMet,
    detail: contractDetail,
  });

  // 6. Disagreement resolved/below threshold.
  const disagreementMet = disagreement <= maxDisagreement;
  if (!disagreementMet) {
    findings.push(
      findingFor(
        "critical_task_completion",
        `Reviewer disagreement ${disagreement.toFixed(2)} above threshold ${maxDisagreement.toFixed(2)}`,
        "high",
      ),
    );
  }
  criteria.push({
    id: "disagreement",
    label: "Disagreement resolved/below threshold",
    passed: disagreementMet,
    detail: disagreementMet
      ? `Disagreement ${disagreement.toFixed(2)} at/below threshold ${maxDisagreement.toFixed(2)}.`
      : `Disagreement ${disagreement.toFixed(2)} exceeds threshold ${maxDisagreement.toFixed(2)}.`,
  });

  const allPassed = criteria.every((c) => c.passed);
  const accepted = allPassed && !sameProvenance;

  // Approval: high-risk changes (or a forced override) always require approval,
  // even when accepted. Low-risk proven fixes may auto-accept.
  const requiresApproval = (opts.forceRequiresApproval ?? false) || highRiskChange;

  const rationale =
    accepted && !requiresApproval
      ? `Candidate accepted and auto-approved: all ${criteria.length} Pareto gate criteria passed; low-risk proven fix with independent evaluator.`
      : accepted
        ? `Candidate accepted but requires human approval (${highRiskChange ? "high-risk change class" : "approval override"}).`
        : `Candidate rejected: ${
            criteria
              .filter((c) => !c.passed)
              .map((c) => c.label)
              .join(", ") || "independent-evaluator requirement failed"
          }.`;

  const decidedAt = new Date().toISOString();
  const evaluation: EvaluationRun = opts.evaluation ?? {
    schema_version: 1,
    kind: "evaluation_run",
    id: newId("RUN"),
    task_request: candidate.task_request,
    provenance: evaluatorProvenance,
    findings,
    started_at: decidedAt,
    finished_at: decidedAt,
    verdict: accepted ? "pass" : "fail",
  };

  return {
    schema_version: 1,
    kind: "acceptance_decision",
    id: newId("ADEC"),
    candidate,
    accepted,
    rationale,
    findings,
    evaluation,
    provenance: evaluatorProvenance,
    decided_at: decidedAt,
    requiresApproval,
  };
}

/**
 * Convenience wrapper around {@link disagreementIndex} to compute the gate's
 * disagreement input from reviewer scores (reusing src/uieng/review.ts).
 */
export function gateDisagreement(reviews: readonly ReviewerScore[]): number {
  return disagreementIndex(reviews);
}
