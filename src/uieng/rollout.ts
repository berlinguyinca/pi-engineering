/**
 * Staged rollout for autonomous UI engineering
 * (docs/specs/autonomous-ui-engineering/pi-engineering/10-rollout.md).
 *
 * Rolls autonomous UI improvements through a bounded sequence of stages:
 *
 *   shadow (measurement only) -> advisory (advisory specs, no auto-change)
 *   -> automatic_worktree_remediation (auto isolated-worktree candidates)
 *   -> low_risk_deterministic_auto_accept (accept low-risk proven fixes)
 *   -> bounded_autonomous_improvements (bounded autonomous improvement)
 *   -> repository_policy_auto_merge (OPTIONAL — only when repo policy allows).
 *
 * Two hard invariants from the spec:
 *  1. Baselines, provenance and rollback are ALWAYS retained. Every
 *     {@link RolloutState} carries a {@link BaselineSnapshot} (baseline
 *     EvidenceBundle + metric scores), the {@link ExecutionProvenance} that
 *     captured it, and the {@link RollbackCondition}s that gate any later
 *     auto-merge. Rollback is checked for a candidate before/after acceptance.
 *  2. Existing behavioral tests remain authoritative; UI-quality tooling only
 *     AUGMENTS them, never replaces them. {@link isAuthoritativeGate}
 *     distinguishes authoritative behavioral-test gates from advisory
 *     UI-quality metrics, and stage advancement never lets an advisory
 *     UI-quality signal override a failed behavioral gate.
 *
 * The state machine is pure/deterministic over structured inputs. It reuses
 * (never reimplements) the Pareto acceptance gate + auto-accept/requiresApproval
 * rules from src/uieng/tournament.ts, budget / cooldown / diminishing-returns
 * from src/uieng/controller.ts, auto-attach from src/uieng/policy.ts, design
 * exploration from src/uieng/exploration.ts, and reviewer disagreement from
 * src/uieng/review.ts.
 */

import { id as newId } from "../core/ids.ts";
import { remainingBudget } from "./controller.ts";
import type { UiQualityConfig, UiQualityState } from "./controller.ts";
import { shouldExplore } from "./exploration.ts";
import type { ExplorationInputs } from "./exploration.ts";
import { autoAttach } from "./policy.ts";
import type { AutoAttachDecision, UiImpactLevel } from "./policy.ts";
import { disagreementIndex } from "./review.ts";
import type { ReviewerScore } from "./review.ts";
import type { MetricSeverity } from "./rubric.ts";
import type { EvidenceBundle, ExecutionProvenance } from "./schemas.ts";
import { changeRequiresApproval } from "./tournament.ts";

// ---------------------------------------------------------------------------
// Rollout stages
// ---------------------------------------------------------------------------

/** The staged-rollout sequence for autonomous UI improvements. */
export type RolloutStage =
  | "shadow"
  | "advisory"
  | "automatic_worktree_remediation"
  | "low_risk_deterministic_auto_accept"
  | "bounded_autonomous_improvements"
  | "repository_policy_auto_merge";

/** Canonical ordering of the stages. `repository_policy_auto_merge` is optional. */
export const ROLLOUT_STAGE_ORDER: readonly RolloutStage[] = [
  "shadow",
  "advisory",
  "automatic_worktree_remediation",
  "low_risk_deterministic_auto_accept",
  "bounded_autonomous_improvements",
  "repository_policy_auto_merge",
];

/** Numeric position of a stage in {@link ROLLOUT_STAGE_ORDER}. */
export function rolloutStageIndex(stage: RolloutStage): number {
  return ROLLOUT_STAGE_ORDER.indexOf(stage);
}

/** Whether a stage performs any autonomous repo mutation. */
export function stageMutatesRepo(stage: RolloutStage): boolean {
  return rolloutStageIndex(stage) >= rolloutStageIndex("automatic_worktree_remediation");
}

// ---------------------------------------------------------------------------
// Configuration + evidence
// ---------------------------------------------------------------------------

/** Configuration controlling how far/quickly rollout may advance. */
export interface RolloutConfig {
  /** When true, the repository policy permits auto-merge (unlocks the optional final stage). Default false. */
  repositoryPolicyAllowsAutoMerge?: boolean;
  /** Min consecutive passing evaluations to advance out of a stage. Default 3. */
  minConsecutivePasses?: number;
  /** Max reviewer disagreement allowed before advancing into auto-accept. Default 0.2. */
  maxDisagreement?: number;
  /** When true, the change is high risk (requires human approval). Default false. */
  highRiskChange?: boolean;
  /** When true, the change is protected and cannot be auto-changed. Default false. */
  protectedChange?: boolean;
  /** When false, no bounded budget remains for autonomous improvement. Default true. */
  budgetAvailable?: boolean;
  /** When false, the UI-quality (advisory) gate is not trusted to gate advancement. Default true. */
  uiQualityGateTrusted?: boolean;
}

/** Evidence observed at the current stage that drives {@link nextStage}. */
export interface RolloutEvidence {
  /** Consecutive passing evaluations at the current stage. */
  consecutivePasses?: number;
  /** Whether the authoritative behavioral/deterministic tests passed. Default true. */
  deterministicTestsPass?: boolean;
  /** Whether the advisory UI-quality gate passed. Default true. */
  uiQualityGatePass?: boolean;
  /** Reviewer disagreement 0..1. Default 0. */
  disagreement?: number;
  /** Whether the candidate/change requires human approval. Default false. */
  requiresApproval?: boolean;
}

const DEFAULT_MIN_PASSES = 3;
const DEFAULT_MAX_DISAGREEMENT = 0.2;

/**
 * Config-level precondition check: may the rollout advance PAST the current
 * stage? This is purely structural (config), so it never depends on runtime
 * evidence. The terminal stage never advances. Auto-accept / bounded
 * autonomous-improvement stages are blocked for protected or high-risk changes,
 * and the optional auto-merge stage requires repository policy to allow it.
 */
export function canAdvance(current: RolloutStage, config: RolloutConfig = {}): boolean {
  switch (current) {
    case "shadow":
      // Measurement only: passive, no risk — always structurally allowed.
      return true;
    case "advisory":
      // Advisory specs still make no auto-change, but must not run on protected work.
      return !config.protectedChange;
    case "automatic_worktree_remediation":
      // Auto-creating worktree candidates must be low-risk and non-protected.
      return !config.highRiskChange && !config.protectedChange;
    case "low_risk_deterministic_auto_accept":
      // Auto-accepting fixes requires a non-protected change with budget to spend.
      return !config.protectedChange && (config.budgetAvailable ?? true);
    case "bounded_autonomous_improvements":
      // Only advance to the optional auto-merge stage when repo policy allows it.
      return config.repositoryPolicyAllowsAutoMerge === true;
    case "repository_policy_auto_merge":
      return false;
  }
}

/**
 * Evidence-level precondition check for advancing out of the current stage.
 * The authoritative behavioral gate is always required once present; the
 * advisory UI-quality gate is required only when the config trusts it.
 */
export function evidenceAllowsAdvance(
  current: RolloutStage,
  config: RolloutConfig = {},
  evidence: RolloutEvidence = {},
): boolean {
  const minPasses = config.minConsecutivePasses ?? DEFAULT_MIN_PASSES;
  const passes = evidence.consecutivePasses ?? 0;
  const deterministic = evidence.deterministicTestsPass ?? true;
  const qualityTrusted = config.uiQualityGateTrusted ?? true;
  const quality = !qualityTrusted || (evidence.uiQualityGatePass ?? true);
  const disagreement = evidence.disagreement ?? 0;
  const maxDisagreement = config.maxDisagreement ?? DEFAULT_MAX_DISAGREEMENT;
  const approval = evidence.requiresApproval ?? false;

  switch (current) {
    case "shadow":
      return passes >= minPasses;
    case "advisory":
      return passes >= minPasses && deterministic && quality;
    case "automatic_worktree_remediation":
      return deterministic && quality && disagreement <= maxDisagreement && !approval;
    case "low_risk_deterministic_auto_accept":
      return deterministic && !approval && (config.budgetAvailable ?? true);
    case "bounded_autonomous_improvements":
      return config.repositoryPolicyAllowsAutoMerge === true && deterministic;
    case "repository_policy_auto_merge":
      return false;
  }
}

/**
 * The stage state machine transition: given the current stage, config, and
 * observed evidence, return the next {@link RolloutStage}. A stage advances
 * only when BOTH the config-level and evidence-level preconditions hold;
 * otherwise it stays put. `repository_policy_auto_merge` is terminal and only
 * reachable when the repository policy allows auto-merge.
 */
export function nextStage(
  current: RolloutStage,
  config: RolloutConfig = {},
  evidence: RolloutEvidence = {},
): RolloutStage {
  if (current === "repository_policy_auto_merge") return current;
  if (!canAdvance(current, config)) return current;
  if (!evidenceAllowsAdvance(current, config, evidence)) return current;
  const next = ROLLOUT_STAGE_ORDER[rolloutStageIndex(current) + 1];
  return next ?? current;
}

// ---------------------------------------------------------------------------
// Baselines / provenance / rollback preservation
// ---------------------------------------------------------------------------

/** A captured baseline: the evidence bundle + metric scores at capture time. */
export interface BaselineSnapshot {
  schema_version: number;
  kind: "baseline_snapshot";
  id: string;
  /** Baseline EvidenceBundle (from src/uieng/schemas.ts), retained forever. */
  evidence: EvidenceBundle;
  /** metric id -> baseline score (0-100) at capture time. */
  metric_scores: Record<string, number>;
  captured_at: string;
}

/** One rollback condition: a metric must not drop more than `max_drop` below baseline. */
export interface RollbackCondition {
  metric_id: string;
  /** Max allowed absolute drop (score points) from the baseline score. Default 20. */
  max_drop?: number;
  /** Whether this condition is authoritative (behavioral) or advisory (UI-quality). Default true. */
  authoritative?: boolean;
  severity?: MetricSeverity;
}

/** A persisted stage transition in the rollout history. */
export interface RolloutTransition {
  stage: RolloutStage;
  decided_at: string;
  reason: string;
}

/**
 * The persisted rollout state record. It ALWAYS retains the baseline snapshot,
 * the {@link ExecutionProvenance} that captured it, and the rollback
 * conditions — so a candidate can be checked for rollback before/after.
 */
export interface RolloutState {
  mission_id: string;
  stage: RolloutStage;
  /** Always retained once captured (spec: baselines preserved). */
  baseline: BaselineSnapshot | null;
  /** The provenance that captured the baseline (spec: provenance preserved). */
  provenance: ExecutionProvenance;
  /** Rollback conditions that must hold for any auto-merge (spec: rollback preserved). */
  rollback_conditions: RollbackCondition[];
  history: RolloutTransition[];
  updated_at: string;
}

/**
 * Capture a baseline snapshot from an EvidenceBundle + metric scores. Always
 * retains the bundle, the per-metric scores, and a capture timestamp. Pure.
 */
export function captureBaselineSnapshot(
  evidence: EvidenceBundle,
  metricScores: Record<string, number>,
  opts: { now?: number } = {},
): BaselineSnapshot {
  return {
    schema_version: 1,
    kind: "baseline_snapshot",
    id: newId("BASE"),
    evidence,
    metric_scores: { ...metricScores },
    captured_at: new Date(opts.now ?? Date.now()).toISOString(),
  };
}

/** Create a fresh rollout state carrying baseline + provenance + rollback conditions. */
export function createRolloutState(opts: {
  missionId: string;
  provenance: ExecutionProvenance;
  baseline?: BaselineSnapshot;
  rollbackConditions?: RollbackCondition[];
  stage?: RolloutStage;
  now?: number;
}): RolloutState {
  const iso = new Date(opts.now ?? Date.now()).toISOString();
  return {
    mission_id: opts.missionId,
    stage: opts.stage ?? "shadow",
    baseline: opts.baseline ?? null,
    provenance: opts.provenance,
    rollback_conditions: opts.rollbackConditions ?? [],
    history: [],
    updated_at: iso,
  };
}

/** Append a stage transition to the rollout history (pure). */
export function recordRolloutTransition(state: RolloutState, transition: RolloutTransition): RolloutState {
  return {
    ...state,
    stage: transition.stage,
    history: [...state.history, transition],
    updated_at: transition.decided_at,
  };
}

/** The candidate-side inputs used to check rollback conditions. */
export interface RollbackCandidate {
  /** metric id -> candidate score (0-100). */
  candidate_scores: Record<string, number>;
  /** When false, an authoritative behavioral gate failed. */
  deterministic_tests_pass?: boolean;
  /** When false, a protected contract broke. */
  protected_contracts_intact?: boolean;
}

/** A single rollback-condition violation. */
export interface RollbackViolation {
  metric_id: string;
  baseline_score: number;
  candidate_score: number;
  max_drop: number;
  /** Whether the violated condition is authoritative (behavioral) or advisory. */
  authoritative: boolean;
}

/** Result of {@link checkRollbackConditions}. */
export interface RollbackCheck {
  rollback: boolean;
  violations: RollbackViolation[];
  reason: string;
}

/**
 * Check the persisted rollback conditions against a candidate's scores. Any
 * authoritative metric regression below baseline (minus max_drop), a failed
 * deterministic behavioral gate, or a broken protected contract triggers a
 * rollback. Advisory UI-quality regressions also surface as violations (so
 * they are never hidden) but are reported separately via `authoritative`.
 */
export function checkRollbackConditions(state: RolloutState, candidate: RollbackCandidate): RollbackCheck {
  const baseline = state.baseline;
  if (!baseline) {
    return {
      rollback: false,
      violations: [],
      reason: "No baseline captured; rollback conditions cannot be evaluated.",
    };
  }
  const violations: RollbackViolation[] = [];
  for (const cond of state.rollback_conditions) {
    const base = baseline.metric_scores[cond.metric_id];
    const cand = candidate.candidate_scores[cond.metric_id];
    if (base === undefined || cand === undefined) continue;
    const maxDrop = cond.max_drop ?? 20;
    if (cand < base - maxDrop) {
      violations.push({
        metric_id: cond.metric_id,
        baseline_score: base,
        candidate_score: cand,
        max_drop: maxDrop,
        authoritative: cond.authoritative ?? true,
      });
    }
  }
  if (candidate.deterministic_tests_pass === false) {
    violations.push({
      metric_id: "deterministic_tests",
      baseline_score: 0,
      candidate_score: 0,
      max_drop: 0,
      authoritative: true,
    });
  }
  if (candidate.protected_contracts_intact === false) {
    violations.push({
      metric_id: "protected_contracts",
      baseline_score: 0,
      candidate_score: 0,
      max_drop: 0,
      authoritative: true,
    });
  }
  const rollback = violations.length > 0;
  const reason = rollback
    ? `Rollback required: ${violations.map((v) => v.metric_id).join(", ")}`
    : "No rollback conditions violated.";
  return { rollback, violations, reason };
}

// ---------------------------------------------------------------------------
// Policy guard: behavioral tests authoritative, UI-quality advisory
// ---------------------------------------------------------------------------

/** Kind of a gate: authoritative behavioral test vs advisory UI-quality metric. */
export type GateKind = "behavioral" | "ui_quality";

/** A gate reference (behavioral test or advisory UI-quality signal). */
export interface GateRef {
  id: string;
  kind: GateKind;
  label?: string;
}

/**
 * Policy guard: existing behavioral tests remain AUTHORITATIVE; UI-quality
 * tooling augments them and never replaces them. Returns `true` only for
 * authoritative behavioral-test gates. `false` for advisory UI-quality metrics.
 */
export function isAuthoritativeGate(gate: GateRef | GateKind): boolean {
  const kind = typeof gate === "string" ? gate : gate.kind;
  return kind === "behavioral";
}

// ---------------------------------------------------------------------------
// Reuse of the autonomous-UI-engineering modules
// ---------------------------------------------------------------------------

/** Derive requiresApproval evidence from a change kind (reuses tournament.ts). */
export function rolloutApprovalForChange(changeKind: string): boolean {
  return changeRequiresApproval(changeKind);
}

/** Derive disagreement evidence from reviewer scores (reuses review.ts). */
export function rolloutDisagreement(reviews: readonly ReviewerScore[]): number {
  return disagreementIndex(reviews);
}

/** Whether a bounded budget remains for autonomous improvement (reuses controller.ts). */
export function rolloutBudgetAvailable(state: UiQualityState, config: UiQualityConfig): boolean {
  return remainingBudget(state, config) > 0;
}

/** Derive an auto-attach decision for a diff (reuses policy.ts). */
export function rolloutAutoAttach(
  diffPaths: string[],
  uiProfile?: unknown,
  opts?: { budget?: import("./policy.ts").GateBudget },
): AutoAttachDecision {
  return autoAttach(diffPaths, uiProfile as never, opts);
}

/** Whether design exploration should run at a UI-impact level (reuses exploration.ts). */
export function rolloutShouldExplore(inputs: ExplorationInputs, level: UiImpactLevel): boolean {
  return shouldExplore(inputs, level);
}
