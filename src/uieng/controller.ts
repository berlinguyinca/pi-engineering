/**
 * Autonomous UI quality controller
 * (docs/specs/autonomous-ui-engineering/pi-engineering/08-autonomous-controller.md).
 *
 * A persistent orchestration CONTROLLER model: a deterministic state machine
 * plus policy functions that drive the autonomous UI-evaluation control loop
 * over structured state. It does NOT spawn workers — it decides the next
 * action from pure, deterministic inputs so the whole loop is unit-testable.
 *
 * The controller owns:
 *  1. Quality state & debt — {@link UiQualityState} with {@link DebtItem}s, a
 *     bounded quality-debt ledger, and deterministic remaining-budget /
 *     idle-capacity spending rules (`idleCapacityForDebt`).
 *  2. Loop transitions — `decideNext` returns a {@link ControllerAction}:
 *     trigger_evaluation, continue_remediation (after a failed gate),
 *     create_experiment, accept_with_evidence, reject_with_evidence, or stop.
 *  3. Stop conditions — diminishing returns, exhausted budget, excessive
 *     disagreement, protected change, purely subjective preference, and
 *     per-surface cooldowns that block re-evaluating the same surface.
 *  4. Observability / reversibility — every action records provenance/evidence
 *     and emits a structured {@link ControlEvent}; remediation carries a
 *     rollback ref and the controller can revert an accepted change.
 *
 * Reuses the shared schema contracts (EvaluationRun / AcceptanceDecision /
 * Finding) from src/uieng/schemas.ts, rubric metric ids from src/uieng/rubric.ts,
 * the Pareto gate / AcceptanceDecision from src/uieng/tournament.ts,
 * disagreement from src/uieng/review.ts, and follows the declarative policy
 * pattern of src/orchestration/policies.ts.
 */

import { id as newId } from "../core/ids.ts";
import { fnv1a } from "./review.ts";
import type { AcceptanceDecision, EvaluationRun, Finding } from "./schemas.ts";
import type { GatedAcceptanceDecision } from "./tournament.ts";

// ---------------------------------------------------------------------------
// Quality state & debt
// ---------------------------------------------------------------------------

export type DebtItemStatus = "open" | "in_progress" | "remediated" | "rejected";

/** One bounded unit of UI-quality debt derived from a failed gate. */
export interface DebtItem {
  id: string;
  /** Root cause shared by the findings that created this debt (clustered). */
  rootCause: string;
  /** Rubric metric ids this debt affects (validated against the rubric). */
  metricIds: string[];
  /** 0..1 aggregate severity impact. */
  impact: number;
  /** 0..1 remediation effort (higher = costlier). */
  effort: number;
  /** 0..1 remediation risk (higher = riskier). */
  risk: number;
  createdAt: string;
  status: DebtItemStatus;
  /** Optional human-readable affected UI surface; derived from metricIds when absent. */
  affectedSurface?: string;
  /** Evidence/artifact refs supporting this debt item (evidence bundles / finding ids). */
  evidenceRefs?: string[];
  /** Rollback ref set when remediation starts (reversibility). */
  rollbackRef?: string;
}

/** A per-surface re-evaluation cooldown. */
export interface Cooldown {
  surface: string;
  /** ISO timestamp after which the surface may be re-evaluated. */
  cooldownUntil: string;
}

/** The persisted controller state the loop drives deterministically. */
export interface UiQualityState {
  missionId: string;
  qualityDebt: DebtItem[];
  /** Evaluation run refs (persisted-ready records) preserving the loop history. */
  history: EvaluationRun[];
  /** Budget units consumed so far. */
  budgetUsed: number;
  cooldowns: Cooldown[];
  createdAt: string;
  updatedAt: string;
}

/** Configuration controlling the loop's budget, gates, and cooldowns. */
export interface UiQualityConfig {
  /** Total budget units for the whole control loop. Default 100. */
  totalBudget?: number;
  /** Budget cost of one evaluation trigger. Default 10. */
  evaluationCost?: number;
  /** Base budget cost of one remediation; scaled by debt effort. Default 5. */
  remediationCost?: number;
  /** Budget cost of one experiment. Default 15. */
  experimentCost?: number;
  /** Max debt items spendable as idle capacity in one pass. Default 5. */
  maxIdleDebtItems?: number;
  /** Improvement below this stops the loop (diminishing returns). Default 0.02. */
  improvementThreshold?: number;
  /** Number of recent evaluations considered for diminishing returns. Default 3. */
  recentEvaluationWindow?: number;
  /** Reviewer disagreement above this stops the loop. Default 0.2. */
  maxDisagreement?: number;
  /** Per-surface cooldown window in ms. Default 60_000. */
  surfaceCooldownMs?: number;
  /** When true, the loop stops because the change is protected. Default false. */
  protectedChange?: boolean;
  /** When true, the loop stops because the preference is purely subjective. Default false. */
  purelySubjectivePreference?: boolean;
  /** Whether bounded experiments may be created. Default true. */
  experimentsEnabled?: boolean;
}

/** Optional runtime signals feeding `decideNext`. */
export interface ControllerContext {
  /** A gated decision produced from the latest evaluation (lands accept/reject). */
  latestDecision?: GatedAcceptanceDecision;
  /** Recent evaluation runs used for the diminishing-returns check. */
  recentEvaluations?: EvaluationRun[];
  /** Observed reviewer disagreement (0..1) from the latest review. */
  disagreement?: number;
  /** The surface currently under evaluation (used for cooldown checks). */
  currentSurface?: string;
  /** When true (and experiments are enabled + budget allows) create an experiment. */
  experimentRequested?: boolean;
  /** Evidence/artifact refs supporting the experiment request. */
  experimentEvidence?: string[];
  /** Evidence/artifact refs supporting the next evaluation trigger. */
  evaluationEvidence?: string[];
}

/** Deterministic stop conditions (plus `cooldown` preventing redesign churn). */
export type StopCondition =
  | "diminishing_returns"
  | "budget_exhausted"
  | "excessive_disagreement"
  | "protected_change"
  | "subjective_preference"
  | "cooldown";

// ---------------------------------------------------------------------------
// Controller actions
// ---------------------------------------------------------------------------

/** A controller action without its derived event (the discriminated base). */
export type ControllerActionBase =
  | { type: "trigger_evaluation"; reason: string; surface?: string; evidence: string[] }
  | {
      type: "continue_remediation";
      debtItemId: string;
      rootCause: string;
      surface: string;
      rollbackRef: string;
      reason: string;
      evidence: string[];
    }
  | { type: "create_experiment"; reason: string; budgetCost: number; evidence: string[] }
  | { type: "accept_with_evidence"; decision: GatedAcceptanceDecision; reason: string; evidence: string[] }
  | { type: "reject_with_evidence"; decision: GatedAcceptanceDecision; reason: string; evidence: string[] }
  | { type: "stop"; reason: string; stopCondition: StopCondition; evidence: string[] };

export type ControllerAction = ControllerActionBase & { event: ControlEvent };

// ---------------------------------------------------------------------------
// Control events (observability)
// ---------------------------------------------------------------------------

export type ControlEventType =
  | "controller.evaluation_triggered"
  | "controller.remediation_continued"
  | "controller.experiment_created"
  | "controller.accepted"
  | "controller.rejected"
  | "controller.reverted"
  | "controller.stopped";

/** A structured, persisted-ready control event emitted for every action. */
export interface ControlEvent {
  event_id: string;
  mission_id: string;
  timestamp: string;
  type: ControlEventType;
  /** The controller action type that produced this event. */
  action: ControllerAction["type"];
  /** Provenance/evidence refs backing this event. */
  evidence: string[];
  /** Rollback ref when the action is reversible. */
  rollback_ref?: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  info: 0.2,
  low: 0.4,
  medium: 0.6,
  high: 0.8,
  critical: 1,
};

/** Derive a deterministic rollback ref from a root cause + surface. */
export function rollbackRefFor(rootCause: string, surface: string): string {
  return `RB-${fnv1a(`${rootCause}::${surface}`).toString(36).toUpperCase()}`;
}

/** The surface a debt item affects; falls back to its metric ids joined. */
export function debtSurface(item: DebtItem): string {
  return item.affectedSurface ?? item.metricIds.join("+");
}

/** Remaining budget, clamped to >= 0. */
export function remainingBudget(state: UiQualityState, config: UiQualityConfig): number {
  const total = config.totalBudget ?? 100;
  return Math.max(0, total - state.budgetUsed);
}

/** Budget cost to remediate a debt item (higher effort costs more). */
export function debtCost(item: DebtItem, config: UiQualityConfig): number {
  const base = config.remediationCost ?? 5;
  const scaled = base * (1 + Math.max(0, item.effort));
  return Math.round(scaled * 100) / 100;
}

/** Deterministic leverage = impact, discounted by risk, divided by effort. */
export function debtLeverage(item: DebtItem): number {
  const impact = Number.isFinite(item.impact) ? item.impact : 0;
  const risk = Number.isFinite(item.risk) ? item.risk : 0;
  const effort = Number.isFinite(item.effort) ? item.effort : 0;
  return (impact * (1 - Math.min(1, Math.max(0, risk)))) / (0.1 + Math.max(0, effort));
}

/** Whether a surface is still in its re-evaluation cooldown. */
export function surfaceInCooldown(state: UiQualityState, surface: string, now: number = Date.now()): boolean {
  const cd = state.cooldowns.find((c) => c.surface === surface);
  if (!cd) return false;
  return new Date(cd.cooldownUntil).getTime() > now;
}

/**
 * The idle-capacity spending rule: eligible (open/in_progress) debt items
 * prioritized by highest leverage, greedily included while each fits within
 * the remaining budget and the per-pass cap. Returns a new array; does not
 * mutate state.
 */
export function idleCapacityForDebt(state: UiQualityState, config: UiQualityConfig): DebtItem[] {
  let remaining = remainingBudget(state, config);
  const maxItems = config.maxIdleDebtItems ?? 5;
  const eligible = state.qualityDebt
    .filter((d) => d.status === "open" || d.status === "in_progress")
    .slice()
    .sort((a, b) => {
      const diff = debtLeverage(b) - debtLeverage(a);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });
  const result: DebtItem[] = [];
  for (const item of eligible) {
    if (result.length >= maxItems) break;
    const cost = debtCost(item, config);
    if (cost > remaining) continue;
    result.push(item);
    remaining -= cost;
  }
  return result;
}

/** Mean finding severity as a 0..1 quality score for one evaluation run. */
export function evaluationScore(run: EvaluationRun): number {
  if (run.findings.length === 0) return 1;
  const total = run.findings.reduce((sum, f) => sum + (1 - SEVERITY_RANK[f.severity]), 0);
  return Math.min(1, Math.max(0, total / run.findings.length));
}

/**
 * Recent quality improvement across the recent evaluation window. Returns the
 * score delta between the two most recent runs in the window, or `null` when
 * there are fewer than two runs (no diminishing-returns signal yet).
 */
export function recentImprovement(
  state: UiQualityState,
  config: UiQualityConfig,
  ctx: ControllerContext = {},
): number | null {
  const runs = ctx.recentEvaluations ?? state.history;
  const window = config.recentEvaluationWindow ?? 3;
  const recent = runs.slice(-window);
  if (recent.length < 2) return null;
  const scores = recent.map(evaluationScore);
  const prev = scores[scores.length - 2] ?? 0;
  const last = scores[scores.length - 1] ?? 0;
  return last - prev;
}

/**
 * Deterministic stop-condition check (cooldown is handled separately in the
 * trigger path). Returns the first applicable {@link StopCondition} or null.
 */
export function checkStopConditions(
  state: UiQualityState,
  config: UiQualityConfig,
  ctx: ControllerContext = {},
): StopCondition | null {
  if (config.protectedChange) return "protected_change";
  if (config.purelySubjectivePreference) return "subjective_preference";
  if (remainingBudget(state, config) <= 0) return "budget_exhausted";
  if (ctx.disagreement !== undefined && ctx.disagreement > (config.maxDisagreement ?? 0.2)) {
    return "excessive_disagreement";
  }
  const improvement = recentImprovement(state, config, ctx);
  if (improvement !== null && improvement < (config.improvementThreshold ?? 0.02)) return "diminishing_returns";
  return null;
}

const STOP_REASON: Record<StopCondition, string> = {
  diminishing_returns: "Recent improvement is below the threshold; further evaluation yields diminishing returns.",
  budget_exhausted: "The quality budget is exhausted; the loop must stop.",
  excessive_disagreement: "Reviewer disagreement exceeds the threshold; the loop must stop pending investigation.",
  protected_change: "The change is protected; autonomous evaluation is not permitted.",
  subjective_preference: "The change is a purely subjective preference; autonomous acceptance is not permitted.",
  cooldown: "The target surface is in cooldown; re-evaluating it would cause redesign churn.",
};

function eventTypeForAction(type: ControllerActionBase["type"]): ControlEventType {
  switch (type) {
    case "trigger_evaluation":
      return "controller.evaluation_triggered";
    case "continue_remediation":
      return "controller.remediation_continued";
    case "create_experiment":
      return "controller.experiment_created";
    case "accept_with_evidence":
      return "controller.accepted";
    case "reject_with_evidence":
      return "controller.rejected";
    case "stop":
      return "controller.stopped";
  }
}

/** Build a structured {@link ControlEvent} for an action (observability). */
export function controlEventFor(
  state: UiQualityState,
  action: ControllerActionBase,
  now: number = Date.now(),
): ControlEvent {
  const payload: Record<string, unknown> = { reason: action.reason };
  if ("surface" in action && action.surface !== undefined) payload.surface = action.surface;
  if ("budgetCost" in action && action.budgetCost !== undefined) payload.budgetCost = action.budgetCost;
  if ("decision" in action && action.decision !== undefined) payload.decision_id = action.decision.id;
  if ("debtItemId" in action && action.debtItemId !== undefined) payload.debt_item_id = action.debtItemId;
  if ("stopCondition" in action && action.stopCondition !== undefined) payload.stop_condition = action.stopCondition;
  const rollbackRef = "rollbackRef" in action ? action.rollbackRef : undefined;
  return {
    event_id: newId("CTRL"),
    mission_id: state.missionId,
    timestamp: new Date(now).toISOString(),
    type: eventTypeForAction(action.type),
    action: action.type,
    evidence: [...action.evidence],
    ...(rollbackRef ? { rollback_ref: rollbackRef } : {}),
    payload,
  };
}

function evidenceFor(decision: GatedAcceptanceDecision): string[] {
  return [decision.id, decision.evaluation.id, ...decision.findings.map((f) => f.id)];
}

function attachEvent(state: UiQualityState, action: ControllerActionBase, now: number): ControllerAction {
  return { ...action, event: controlEventFor(state, action, now) } as ControllerAction;
}

/**
 * The controller loop transition — pure and deterministic. Decides the next
 * {@link ControllerAction} from the current state, config, and runtime context:
 * lands a pending gated decision, then applies stop conditions, then continues
 * bounded remediation, then (optionally) creates a bounded experiment, and
 * finally triggers the next evaluation (unless the surface is in cooldown).
 */
export function decideNext(
  state: UiQualityState,
  config: UiQualityConfig,
  ctx: ControllerContext = {},
  now: number = Date.now(),
): ControllerAction {
  // 1. Land a pending gated decision first (accept/reject with evidence).
  const decision = ctx.latestDecision;
  if (decision) {
    const type = decision.accepted ? "accept_with_evidence" : "reject_with_evidence";
    return attachEvent(state, { type, decision, reason: decision.rationale, evidence: evidenceFor(decision) }, now);
  }

  // 2. Stop conditions.
  const stop = checkStopConditions(state, config, ctx);
  if (stop) {
    return attachEvent(state, { type: "stop", reason: STOP_REASON[stop], stopCondition: stop, evidence: [] }, now);
  }

  // 3. Continue remediation (after a failed gate / bounded idle-capacity spend).
  const candidates = idleCapacityForDebt(state, config);
  if (candidates.length > 0) {
    const item = candidates[0] as DebtItem;
    const surface = debtSurface(item);
    return attachEvent(
      state,
      {
        type: "continue_remediation",
        debtItemId: item.id,
        rootCause: item.rootCause,
        surface,
        rollbackRef: rollbackRefFor(item.rootCause, surface),
        reason: `Continue remediation of "${item.rootCause}" (leverage ${debtLeverage(item).toFixed(3)}).`,
        evidence: item.evidenceRefs ?? [],
      },
      now,
    );
  }

  // 4. Bounded experiment when the direction is uncertain and budget allows.
  const experimentCost = config.experimentCost ?? 15;
  if (
    config.experimentsEnabled !== false &&
    ctx.experimentRequested &&
    remainingBudget(state, config) >= experimentCost
  ) {
    return attachEvent(
      state,
      {
        type: "create_experiment",
        reason: "Uncertain/high-impact direction warrants competing isolated-worktree candidates.",
        budgetCost: experimentCost,
        evidence: ctx.experimentEvidence ?? [],
      },
      now,
    );
  }

  // 5. Cooldown guard prevents re-evaluating the same surface too soon.
  const surface = ctx.currentSurface;
  if (surface && surfaceInCooldown(state, surface, now)) {
    return attachEvent(
      state,
      { type: "stop", reason: STOP_REASON.cooldown, stopCondition: "cooldown", evidence: [] },
      now,
    );
  }

  // 6. Otherwise trigger the next proportional UI-evaluation pass.
  return attachEvent(
    state,
    {
      type: "trigger_evaluation",
      reason: "No stop condition; next proportional UI-evaluation pass.",
      surface,
      evidence: ctx.evaluationEvidence ?? [],
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Reducers / reversibility
// ---------------------------------------------------------------------------

function upsertCooldown(cooldowns: Cooldown[], surface: string, untilMs: number): Cooldown[] {
  const untilIso = new Date(untilMs).toISOString();
  const existing = cooldowns.find((c) => c.surface === surface);
  if (existing) {
    return cooldowns.map((c) => (c.surface === surface ? { ...c, cooldownUntil: untilIso } : c));
  }
  return [...cooldowns, { surface, cooldownUntil: untilIso }];
}

function markDebtStatus(list: DebtItem[], id: string, status: DebtItemStatus, rollbackRef?: string): DebtItem[] {
  return list.map((d) => (d.id === id ? { ...d, status, ...(rollbackRef ? { rollbackRef } : {}) } : d));
}

function actionCost(state: UiQualityState, action: ControllerActionBase, config: UiQualityConfig): number {
  switch (action.type) {
    case "trigger_evaluation":
      return config.evaluationCost ?? 10;
    case "continue_remediation": {
      const item = state.qualityDebt.find((d) => d.id === action.debtItemId);
      return item ? debtCost(item, config) : 0;
    }
    case "create_experiment":
      return action.budgetCost ?? config.experimentCost ?? 15;
    default:
      return 0;
  }
}

/**
 * Apply a controller action to the state (pure reducer): consumes budget,
 * sets cooldowns, transitions debt status, and preserves evaluation history.
 */
export function applyAction(
  state: UiQualityState,
  action: ControllerActionBase,
  config: UiQualityConfig,
  now: number = Date.now(),
): UiQualityState {
  const iso = new Date(now).toISOString();
  const cost = actionCost(state, action, config);
  let next: UiQualityState = { ...state, budgetUsed: state.budgetUsed + cost, updatedAt: iso };

  switch (action.type) {
    case "trigger_evaluation": {
      if (action.surface) {
        const until = now + (config.surfaceCooldownMs ?? 60_000);
        next = { ...next, cooldowns: upsertCooldown(state.cooldowns, action.surface, until) };
      }
      break;
    }
    case "continue_remediation": {
      next = {
        ...next,
        qualityDebt: markDebtStatus(state.qualityDebt, action.debtItemId, "in_progress", action.rollbackRef),
      };
      break;
    }
    case "create_experiment":
      break;
    case "accept_with_evidence":
    case "reject_with_evidence": {
      const history = [...state.history];
      if (action.decision?.evaluation && !history.some((h) => h.id === action.decision.evaluation.id)) {
        history.push(action.decision.evaluation);
      }
      next = { ...next, history };
      break;
    }
    case "stop":
      break;
  }
  return next;
}

/** Record a completed evaluation run into history (budget + cooldown). */
export function recordEvaluation(
  state: UiQualityState,
  run: EvaluationRun,
  opts: { config?: UiQualityConfig; surface?: string; now?: number } = {},
): UiQualityState {
  const config = opts.config ?? {};
  const now = opts.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const history = state.history.some((h) => h.id === run.id) ? state.history : [...state.history, run];
  let next: UiQualityState = {
    ...state,
    history,
    budgetUsed: state.budgetUsed + (config.evaluationCost ?? 10),
    updatedAt: iso,
  };
  if (opts.surface) {
    const until = now + (config.surfaceCooldownMs ?? 60_000);
    next = { ...next, cooldowns: upsertCooldown(state.cooldowns, opts.surface, until) };
  }
  return next;
}

/** Record a completed gated decision (preserves its evaluation in history). */
export function recordDecision(
  state: UiQualityState,
  decision: GatedAcceptanceDecision,
  opts: { now?: number } = {},
): UiQualityState {
  const now = opts.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const history = state.history.some((h) => h.id === decision.evaluation.id)
    ? state.history
    : [...state.history, decision.evaluation];
  return { ...state, history, updatedAt: iso };
}

/** Mark a debt item remediated (reversible via its rollback ref). */
export function markDebtRemediated(
  state: UiQualityState,
  debtId: string,
  opts: { evidenceRefs?: string[]; now?: number } = {},
): UiQualityState {
  const iso = new Date(opts.now ?? Date.now()).toISOString();
  return {
    ...state,
    qualityDebt: markDebtStatus(state.qualityDebt, debtId, "remediated"),
    updatedAt: iso,
  };
}

/** Mark a debt item rejected (no remediation will be performed). */
export function rejectDebt(state: UiQualityState, debtId: string, opts: { now?: number } = {}): UiQualityState {
  const iso = new Date(opts.now ?? Date.now()).toISOString();
  return { ...state, qualityDebt: markDebtStatus(state.qualityDebt, debtId, "rejected"), updatedAt: iso };
}

// ---------------------------------------------------------------------------
// Construction + reversibility
// ---------------------------------------------------------------------------

/** Create a fresh, empty quality state for a mission. */
export function createQualityState(
  missionId: string,
  opts: {
    debt?: DebtItem[];
    history?: EvaluationRun[];
    budgetUsed?: number;
    cooldowns?: Cooldown[];
    now?: number;
  } = {},
): UiQualityState {
  const iso = new Date(opts.now ?? Date.now()).toISOString();
  return {
    missionId,
    qualityDebt: opts.debt ?? [],
    history: opts.history ?? [],
    budgetUsed: opts.budgetUsed ?? 0,
    cooldowns: opts.cooldowns ?? [],
    createdAt: iso,
    updatedAt: iso,
  };
}

/** Result of reverting an accepted change. */
export interface RevertResult {
  reverted: boolean;
  rollbackRef: string;
  conditions: string[];
  evidence: string[];
  event: ControlEvent;
}

/**
 * Revert an accepted change given its rollback conditions. Reversible:
 * produces a structured control event carrying the rollback ref and the
 * conditions that triggered the revert.
 */
export function revertChange(
  accepted: AcceptanceDecision,
  rollbackConditions: string[],
  opts: { missionId: string; evidence?: string[]; now?: number },
): RevertResult {
  const now = opts.now ?? Date.now();
  const rollbackRef = `RB-${fnv1a(`${accepted.id}::revert`).toString(36).toUpperCase()}`;
  const evidence = [...(opts.evidence ?? [])];
  const event: ControlEvent = {
    event_id: newId("CTRL"),
    mission_id: opts.missionId,
    timestamp: new Date(now).toISOString(),
    type: "controller.reverted",
    action: "reject_with_evidence",
    evidence,
    rollback_ref: rollbackRef,
    payload: { decision_id: accepted.id, rollback_conditions: rollbackConditions },
  };
  return { reverted: true, rollbackRef, conditions: [...rollbackConditions], evidence, event };
}
