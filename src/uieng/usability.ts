/**
 * Runtime usability & robustness evaluation for autonomous UI engineering
 * (docs/specs/autonomous-ui-engineering/pi-engineering/05-runtime-tests.md).
 *
 * Four pure, deterministic pieces (no live browser required):
 *  1. Canonical tasks: user goals (not click scripts) with typed success
 *     criteria and runtime metrics (success/time/actions/navigation depth/
 *     wrong-turns/backtracks/mis-clicks/errors/latency/assistance) mapped to
 *     rubric metric ids (src/uieng/rubric.ts).
 *  2. A viewport matrix (phone 320/360/390/430, tablet both orientations,
 *     laptop/desktop/ultrawide, 200% zoom) plus a deterministic
 *     `viewportMetricGroup` mapping a {width,height,zoom} to the applicable
 *     reflow/layout metric ids.
 *  3. A robustness scenario catalog (long/empty/huge data, loading, backend
 *     errors, slow network, reconnect, rapid clicks, double submit, refresh,
 *     deep links, back/forward, modal/drawer stacking, temporal traces/video)
 *     with a deterministic `analyzeRobustnessScenario` that scores evidence
 *     against the rubric.
 *  4. A usability run helper that combines the three into a single
 *     `UsabilityEvaluationPlan` and produces per-metric scores.
 *
 * All functions are pure over plain structured inputs so unit tests need no
 * live browser. Analysis results reuse {@link AnalysisResult} from
 * src/uieng/evidence.ts and are consumable by `scoreRecord`.
 */

import type { AnalysisResult, OverflowRecord, BreakpointFailure, RuntimeError } from "./evidence.ts";
import { analyzeOverflow, analyzeBreakpoints, scoreAnalysis } from "./evidence.ts";
import type { MetricScore } from "./rubric.ts";
import type { UiImpactLevel } from "./policy.ts";

// ---------------------------------------------------------------------------
// 1. Canonical-task model
// ---------------------------------------------------------------------------

/** Interaction/context mode a canonical task is exercised under. */
export type TaskMode =
  | "first_time"
  | "power"
  | "keyboard"
  | "touch"
  | "small_screen"
  | "large_screen"
  | "high_info_load";

/**
 * A canonical task is a USER GOAL (not a click script). The agent/verifier
 * derives concrete interaction steps from the goal, but the task itself only
 * states what the user is trying to achieve and how success is recognized.
 */
export interface CanonicalTask {
  id: string;
  goal: string;
  mode: TaskMode;
  /** Routes/UI states the task must visit or transition through. */
  required_states: string[];
  /** Objective, verifiable success criteria. */
  success_criteria: string[];
  /** Viewport group ids (see `viewportMetricGroup`) the task is evaluated at. */
  viewport_targets: string[];
}

/**
 * Runtime metrics captured while exercising a canonical task. Every field maps
 * onto at least one rubric metric id (see `TASK_METRIC_MAPPING`).
 */
export interface TaskMetrics {
  /** Whether the task completed successfully. */
  success: boolean;
  /** Wall-clock time to completion (ms). */
  time_ms: number;
  /** Total user actions (clicks/keystrokes) taken. */
  actions: number;
  /** Maximum navigation depth reached (screen/state transitions). */
  navigation_depth: number;
  /** Off-path actions that required correction. */
  wrong_turns: number;
  /** Times the user had to go back and retry a step. */
  backtracks: number;
  /** Mis-clicks on non-target controls. */
  mis_clicks: number;
  /** Errors surfaced to the user during the task. */
  errors: number;
  /** Input-to-response latency observed during the task (ms). */
  latency_ms: number;
  /** Number of assistance requests needed to complete the task. */
  assistance: number;
}

/** All runtime metric fields that map onto rubric metric ids. */
export type TaskMetricKey = keyof TaskMetrics;

/**
 * Mapping from each runtime task metric to the rubric metric ids it informs.
 * Reuses ids from src/uieng/rubric.ts.
 */
export const TASK_METRIC_MAPPING: Readonly<Record<TaskMetricKey, readonly string[]>> = {
  success: ["critical_task_completion"],
  time_ms: ["task_efficiency"],
  actions: ["task_efficiency"],
  navigation_depth: ["navigation_clarity", "cognitive_load"],
  wrong_turns: ["navigation_clarity", "task_efficiency"],
  backtracks: ["navigation_clarity"],
  mis_clicks: ["error_prevention", "cognitive_load"],
  errors: ["error_prevention"],
  latency_ms: ["interaction_latency"],
  assistance: ["discoverability"],
};

const clampScore = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

/** Deterministic latency scoring (shared with evidence.ts render thresholds). */
function latencyScore(ms: number): number {
  if (ms <= 16) return 100;
  if (ms <= 50) return 75;
  if (ms <= 100) return 50;
  if (ms <= 250) return 25;
  return 0;
}

/**
 * Evaluate a canonical task against its runtime metrics, producing one
 * {@link AnalysisResult} per rubric metric id in `TASK_METRIC_MAPPING`.
 * Pure and deterministic over the structured inputs.
 */
export function evaluateCanonicalTask(task: CanonicalTask, metrics: TaskMetrics): AnalysisResult[] {
  const refs: string[] = [`task:${task.id}`];
  const detail = (metricId: string, details: string, score: number, confidence: number): AnalysisResult => ({
    metricId,
    score: clampScore(score),
    confidence,
    evidence: [...refs],
    details,
  });

  const efficiencyScore = clampScore(100 - metrics.actions * 4 - metrics.wrong_turns * 8 - metrics.backtracks * 6);
  const eff = metrics.success ? efficiencyScore : Math.min(efficiencyScore, 25);

  const navScore = clampScore(
    100 - metrics.navigation_depth * 3 - metrics.wrong_turns * 15 - metrics.backtracks * 15 - metrics.mis_clicks * 5,
  );
  const cogScore = clampScore(100 - metrics.wrong_turns * 10 - metrics.mis_clicks * 8 - metrics.errors * 10 - metrics.assistance * 20);
  const errScore = clampScore(100 - metrics.mis_clicks * 20 - metrics.errors * 20);
  const discScore = metrics.assistance === 0 ? 100 : clampScore(100 - metrics.assistance * 30);

  const results: AnalysisResult[] = [];
  const push = (metricId: string, score: number, details: string, confidence = 0.7) => {
    results.push(detail(metricId, details, score, confidence));
  };

  push(
    "critical_task_completion",
    metrics.success ? 100 : 0,
    metrics.success
      ? `Task "${task.id}" completed successfully (${metrics.actions} actions, ${metrics.time_ms}ms).`
      : `Task "${task.id}" failed; ${metrics.wrong_turns} wrong turns, ${metrics.assistance} assistance requests.`,
    0.85,
  );
  push(
    "task_efficiency",
    eff,
    `${metrics.actions} actions, ${metrics.time_ms}ms, ${metrics.wrong_turns} wrong turns, ${metrics.backtracks} backtracks.`,
  );
  push(
    "navigation_clarity",
    navScore,
    `depth ${metrics.navigation_depth}, wrong turns ${metrics.wrong_turns}, backtracks ${metrics.backtracks}.`,
  );
  push("cognitive_load", cogScore, `wrong turns ${metrics.wrong_turns}, mis-clicks ${metrics.mis_clicks}, errors ${metrics.errors}.`);
  push("error_prevention", errScore, `${metrics.mis_clicks} mis-clicks, ${metrics.errors} errors.`);
  push("interaction_latency", latencyScore(metrics.latency_ms), `observed latency ${metrics.latency_ms}ms.`, 0.8);
  push("discoverability", discScore, `${metrics.assistance} assistance request(s).`);
  return results;
}

// ---------------------------------------------------------------------------
// 2. Viewport matrix
// ---------------------------------------------------------------------------

/** A single entry in the evaluation viewport matrix. */
export interface ViewportMatrixEntry {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Browser zoom factor (e.g. 1 = 100%, 2 = 200%). */
  zoom: number;
  orientation: "portrait" | "landscape";
  /** Rubric reflow/layout metric ids that apply at this viewport. */
  metric_ids: string[];
}

/**
 * Deterministic mapping of a viewport {width,height,zoom} onto the applicable
 * rubric reflow/layout metric ids (mobile_reflow, tablet_reflow,
 * desktop_layout, ultrawide_behavior, orientation, zoom_reflow, touch_targets).
 */
export function viewportMetricGroup(width: number, height: number, zoom = 1): string[] {
  // Effective CSS width after zoom: at 200% a 1280px window is ~640 CSS px.
  const effWidth = zoom > 0 ? width / zoom : width;
  const ids = new Set<string>();
  if (zoom >= 1.5) ids.add("zoom_reflow");
  if (effWidth <= 430) {
    ids.add("mobile_reflow");
    ids.add("touch_targets");
  } else if (effWidth <= 1024) {
    ids.add("tablet_reflow");
    ids.add("orientation");
  } else if (effWidth <= 1920) {
    ids.add("desktop_layout");
  } else {
    ids.add("ultrawide_behavior");
    ids.add("desktop_layout");
  }
  if (effWidth <= 1024) ids.add("orientation");
  return [...ids];
}

/**
 * The canonical viewport matrix: 320/360/390/430 phone widths, tablet portrait
 * and landscape, laptop/desktop/ultrawide, and a 200%-zoom pass over the
 * primary widths. Each entry carries its applicable rubric metric ids.
 */
export function buildViewportMatrix(): ViewportMatrixEntry[] {
  const entries: Array<Omit<ViewportMatrixEntry, "metric_ids">> = [
    { id: "phone-320", label: "Phone 320", width: 320, height: 568, zoom: 1, orientation: "portrait" },
    { id: "phone-360", label: "Phone 360", width: 360, height: 640, zoom: 1, orientation: "portrait" },
    { id: "phone-390", label: "Phone 390", width: 390, height: 844, zoom: 1, orientation: "portrait" },
    { id: "phone-430", label: "Phone 430", width: 430, height: 932, zoom: 1, orientation: "portrait" },
    { id: "tablet-portrait", label: "Tablet portrait", width: 768, height: 1024, zoom: 1, orientation: "portrait" },
    { id: "tablet-landscape", label: "Tablet landscape", width: 1024, height: 768, zoom: 1, orientation: "landscape" },
    { id: "laptop", label: "Laptop", width: 1366, height: 768, zoom: 1, orientation: "landscape" },
    { id: "desktop", label: "Desktop", width: 1920, height: 1080, zoom: 1, orientation: "landscape" },
    { id: "ultrawide", label: "Ultrawide", width: 3440, height: 1440, zoom: 1, orientation: "landscape" },
    { id: "desktop-200", label: "Desktop 200% zoom", width: 1920, height: 1080, zoom: 2, orientation: "landscape" },
    { id: "laptop-200", label: "Laptop 200% zoom", width: 1366, height: 768, zoom: 2, orientation: "landscape" },
  ];
  return entries.map((e) => ({
    ...e,
    metric_ids: viewportMetricGroup(e.width, e.height, e.zoom),
  }));
}

/** Convenience: the built matrix keyed by viewport id. */
export const VIEWPORT_MATRIX: readonly ViewportMatrixEntry[] = buildViewportMatrix();

// ---------------------------------------------------------------------------
// 3. Robustness scenario catalog
// ---------------------------------------------------------------------------

/** Categories of robustness scenarios covered by the catalog. */
export type RobustnessScenarioKind =
  | "long_content"
  | "empty_data"
  | "huge_dataset"
  | "loading"
  | "backend_error"
  | "slow_network"
  | "reconnect"
  | "rapid_clicks"
  | "double_submit"
  | "refresh"
  | "deep_link"
  | "back_forward"
  | "modal_drawer_stacking"
  | "temporal_traces_video";

/** A single robustness scenario and the rubric metric ids it targets. */
export interface RobustnessScenario {
  id: string;
  kind: RobustnessScenarioKind;
  title: string;
  description: string;
  /** Rubric metric ids this scenario scores against. */
  metric_ids: string[];
}

/** Canonical mapping from scenario kind to applicable rubric metric ids. */
export const SCENARIO_METRIC_MAP: Readonly<Record<RobustnessScenarioKind, readonly string[]>> = {
  long_content: ["long_content_resilience"],
  empty_data: ["empty_states"],
  huge_dataset: ["large_dataset_resilience"],
  loading: ["loading_states"],
  backend_error: ["slow_error_network", "error_recovery"],
  slow_network: ["slow_error_network", "loading_states"],
  reconnect: ["slow_error_network", "feedback_state_visibility"],
  rapid_clicks: ["repeated_click_double_submit"],
  double_submit: ["repeated_click_double_submit"],
  refresh: ["refresh_deep_link_robustness"],
  deep_link: ["refresh_deep_link_robustness"],
  back_forward: ["back_forward"],
  modal_drawer_stacking: ["modal_drawer_stacking"],
  temporal_traces_video: ["feedback_state_visibility", "loading_states"],
};

/** The canonical robustness scenario catalog. */
export const ROBUSTNESS_SCENARIOS: readonly RobustnessScenario[] = [
  {
    id: "scn-long-content",
    kind: "long_content",
    title: "Long content",
    description: "Render long text/lists and verify layout integrity.",
    metric_ids: [...SCENARIO_METRIC_MAP.long_content],
  },
  {
    id: "scn-empty-data",
    kind: "empty_data",
    title: "Empty data",
    description: "Visit views with no data and assess empty-state quality.",
    metric_ids: [...SCENARIO_METRIC_MAP.empty_data],
  },
  {
    id: "scn-huge-dataset",
    kind: "huge_dataset",
    title: "Huge dataset",
    description: "Load a large dataset and measure render/scroll performance.",
    metric_ids: [...SCENARIO_METRIC_MAP.huge_dataset],
  },
  {
    id: "scn-loading",
    kind: "loading",
    title: "Loading",
    description: "Observe slow operations for indicators and layout stability.",
    metric_ids: [...SCENARIO_METRIC_MAP.loading],
  },
  {
    id: "scn-backend-error",
    kind: "backend_error",
    title: "Backend errors",
    description: "Trigger backend failures and verify message clarity and recovery.",
    metric_ids: [...SCENARIO_METRIC_MAP.backend_error],
  },
  {
    id: "scn-slow-network",
    kind: "slow_network",
    title: "Slow network",
    description: "Throttle network and verify graceful behavior.",
    metric_ids: [...SCENARIO_METRIC_MAP.slow_network],
  },
  {
    id: "scn-reconnect",
    kind: "reconnect",
    title: "Reconnect",
    description: "Drop and restore connectivity; verify state recovery.",
    metric_ids: [...SCENARIO_METRIC_MAP.reconnect],
  },
  {
    id: "scn-rapid-clicks",
    kind: "rapid_clicks",
    title: "Rapid/repeated clicks",
    description: "Rapidly click actions and verify no duplicates.",
    metric_ids: [...SCENARIO_METRIC_MAP.rapid_clicks],
  },
  {
    id: "scn-double-submit",
    kind: "double_submit",
    title: "Double submit",
    description: "Submit forms twice and verify idempotent handling.",
    metric_ids: [...SCENARIO_METRIC_MAP.double_submit],
  },
  {
    id: "scn-refresh",
    kind: "refresh",
    title: "Refresh",
    description: "Refresh views and verify state restoration.",
    metric_ids: [...SCENARIO_METRIC_MAP.refresh],
  },
  {
    id: "scn-deep-link",
    kind: "deep_link",
    title: "Deep links",
    description: "Deep-link into views and verify state restoration.",
    metric_ids: [...SCENARIO_METRIC_MAP.deep_link],
  },
  {
    id: "scn-back-forward",
    kind: "back_forward",
    title: "Back/forward",
    description: "Navigate forward/back and verify state and scroll restoration.",
    metric_ids: [...SCENARIO_METRIC_MAP.back_forward],
  },
  {
    id: "scn-modal-drawer",
    kind: "modal_drawer_stacking",
    title: "Modal/drawer stacking",
    description: "Open nested modals/drawers and verify stacking, focus, and dismissal.",
    metric_ids: [...SCENARIO_METRIC_MAP.modal_drawer_stacking],
  },
  {
    id: "scn-temporal-traces",
    kind: "temporal_traces_video",
    title: "Temporal traces / video",
    description: "Replay interaction traces/video to verify state feedback over time.",
    metric_ids: [...SCENARIO_METRIC_MAP.temporal_traces_video],
  },
];

/** Structured evidence inputs for a robustness scenario (no browser required). */
export interface RobustnessEvidence {
  /** Console/network runtime errors captured during the scenario. */
  runtimeErrors?: RuntimeError[];
  /** Timing information (e.g. slow-network duration, large-data render). */
  timing?: { duration_ms: number; timeout_ms?: number; attempts?: number };
  /** Event log entries (clicks, submits, navigation, overlay open/close). */
  events?: Array<Record<string, unknown>>;
  /** Scenario-specific pass/fail flags (e.g. duplicate_prevented, state_restored). */
  outcomes?: Record<string, boolean>;
  /** Number of detected issues (e.g. duplicate records, broken overlays). */
  issues?: number;
  /** Artifact/evidence refs supporting the analysis. */
  refs?: string[];
}

/** Optional per-call options for robustness analysis. */
export interface RobustnessAnalyzeOptions {
  /** Extra artifact/evidence refs to attach to results. */
  evidence?: string[];
}

interface Scored {
  score: number;
  confidence: number;
  details: string;
}

const ok = (details: string, confidence = 0.7): Scored => ({ score: 100, confidence, details });
const fromIssues = (issues: number, perIssue = 20, details: string, confidence = 0.7): Scored => ({
  score: clampScore(100 - issues * perIssue),
  confidence,
  details: issues === 0 ? `No issues: ${details}` : `${issues} issue(s): ${details}`,
});
const fromOutcome = (flag: boolean | undefined, failScore: number, failMsg: string, passMsg: string, confidence = 0.7): Scored =>
  flag === false ? { score: failScore, confidence, details: failMsg } : { score: 100, confidence, details: passMsg };
const fromTiming = (ms: number, confidence = 0.7): Scored => {
  let score: number;
  if (ms <= 500) score = 100;
  else if (ms <= 1000) score = 75;
  else if (ms <= 2000) score = 50;
  else if (ms <= 4000) score = 25;
  else score = 0;
  return { score, confidence, details: `took ${ms}ms.` };
};
const fromErrors = (errors: readonly RuntimeError[], confidence = 0.7): Scored => {
  if (errors.length === 0) return ok("no runtime errors captured.", confidence);
  let score = 100;
  for (const e of errors) score -= e.source === "network" ? 25 : 20;
  return { score: clampScore(score), confidence, details: `${errors.length} runtime error(s) captured.` };
};

/** Deterministic per-kind scoring of a robustness scenario's evidence. */
function scenarioScores(kind: RobustnessScenarioKind, evidence: RobustnessEvidence): Record<string, Scored> {
  const out = evidence.outcomes ?? {};
  const timing = evidence.timing;
  const errors = evidence.runtimeErrors ?? [];
  switch (kind) {
    case "long_content":
      return {
        long_content_resilience: fromIssues(
          evidence.issues ?? 0,
          20,
          "long content rendered without layout breakage.",
        ),
      };
    case "empty_data":
      return {
        empty_states: fromOutcome(
          out.helpful_empty_state,
          25,
          "empty state is blank/confusing.",
          "empty state present with clear guidance.",
        ),
      };
    case "huge_dataset":
      return {
        large_dataset_resilience: timing
          ? fromTiming(timing.duration_ms)
          : fromOutcome(out.rendered, 25, "large dataset failed to render.", "large dataset rendered acceptably."),
      };
    case "loading":
      return {
        loading_states: fromOutcome(
          out.indicator_shown,
          25,
          "no loading indicator / blank screen.",
          "loading indicator shown without layout jump.",
        ),
      };
    case "backend_error":
      return {
        slow_error_network: fromErrors(errors),
        error_recovery: fromOutcome(
          out.retry_offered,
          25,
          "backend error surfaced with no recovery path.",
          "backend error surfaced with a clear recovery path.",
        ),
      };
    case "slow_network":
      return {
        slow_error_network: fromErrors(errors),
        loading_states: out.indicator_shown === false
          ? { score: 25, confidence: 0.7, details: "no loading indication during slow network." }
          : ok("graceful behavior during slow network."),
      };
    case "reconnect":
      return {
        slow_error_network: fromErrors(errors),
        feedback_state_visibility: fromOutcome(
          out.recovered,
          25,
          "reconnect did not restore state or feedback.",
          "reconnect restored state with clear feedback.",
        ),
      };
    case "rapid_clicks":
      return {
        repeated_click_double_submit: fromOutcome(
          out.duplicate_prevented,
          25,
          "rapid clicks created duplicates/errors.",
          "rapid clicks were guarded against.",
        ),
      };
    case "double_submit":
      return {
        repeated_click_double_submit: fromOutcome(
          out.duplicate_prevented,
          0,
          "double submit created a duplicate record.",
          "double submit was handled idempotently.",
        ),
      };
    case "refresh":
      return {
        refresh_deep_link_robustness: fromOutcome(
          out.state_restored,
          25,
          "refresh lost state.",
          "refresh preserved state.",
        ),
      };
    case "deep_link":
      return {
        refresh_deep_link_robustness: fromOutcome(
          out.state_restored,
          25,
          "deep link did not restore correct state.",
          "deep link restored correct state.",
        ),
      };
    case "back_forward":
      return {
        back_forward: fromOutcome(
          out.state_restored ?? out.scroll_restored,
          25,
          "back/forward lost state or scroll.",
          "back/forward preserved state and scroll.",
        ),
      };
    case "modal_drawer_stacking":
      return {
        modal_drawer_stacking: fromIssues(
          evidence.issues ?? 0,
          25,
          out.focus_restored === false ? "focus was not restored after overlay close." : "overlays stacked and dismissed correctly.",
        ),
      };
    case "temporal_traces_video":
      return {
        feedback_state_visibility: fromOutcome(
          out.feedback_visible,
          25,
          "no visible feedback across the trace timeline.",
          "feedback/state visibility consistent across the trace timeline.",
        ),
        loading_states: fromOutcome(
          out.indicator_shown ?? out.feedback_visible,
          25,
          "loading state not visible in temporal traces.",
          "loading/feedback states visible in temporal traces.",
        ),
      };
  }
}

/**
 * Score a robustness scenario against its structured evidence, producing an
 * {@link AnalysisResult} for every rubric metric id the scenario targets.
 * Pure and deterministic.
 */
export function analyzeRobustnessScenario(
  scenario: RobustnessScenario,
  evidence: RobustnessEvidence,
  opts: RobustnessAnalyzeOptions = {},
): AnalysisResult[] {
  const scores = scenarioScores(scenario.kind, evidence);
  const refs = [...(opts.evidence ?? []), ...(evidence.refs ?? []), `scenario:${scenario.id}`];
  return scenario.metric_ids.map((metricId) => {
    const s = scores[metricId] ?? { score: 100, confidence: 0.5, details: "No evidence captured for this metric." };
    return { metricId, score: s.score, confidence: s.confidence, evidence: refs, details: s.details };
  });
}

/** Structured viewport evidence (reflow/layout signals) for scoring. */
export interface ViewportEvidence {
  overflows?: OverflowRecord[];
  breakpointFailures?: BreakpointFailure[];
  refs?: string[];
}

/**
 * Deterministically score a viewport's reflow/layout health using overflow and
 * breakpoint signals (reusing the evidence.ts analyzers).
 */
export function evaluateViewport(viewport: ViewportMatrixEntry, evidence: ViewportEvidence): AnalysisResult[] {
  const opts = { evidence: [...(evidence.refs ?? []), `viewport:${viewport.id}`] };
  const results: AnalysisResult[] = [];
  if (evidence.overflows) results.push(analyzeOverflow(evidence.overflows, opts));
  if (evidence.breakpointFailures) results.push(analyzeBreakpoints(evidence.breakpointFailures, opts));
  return results;
}

// ---------------------------------------------------------------------------
// 4. Usability run helper
// ---------------------------------------------------------------------------

/** Combined evaluation plan: canonical tasks + viewport matrix + robustness scenarios. */
export interface UsabilityEvaluationPlan {
  impact_level?: UiImpactLevel;
  tasks: CanonicalTask[];
  viewports: ViewportMatrixEntry[];
  /** viewport id -> applicable rubric reflow/layout metric ids. */
  viewport_metric_groups: Record<string, string[]>;
  scenarios: RobustnessScenario[];
}

/** Inputs for a usability run: task metrics and scenario evidence keyed by id. */
export interface UsabilityEvaluationInputs {
  tasks: Record<string, TaskMetrics>;
  scenarios: Record<string, RobustnessEvidence>;
  viewports?: Record<string, ViewportEvidence>;
}

/** Build a {@link UsabilityEvaluationPlan} from explicit parts. */
export function buildUsabilityEvaluationPlan(
  tasks: CanonicalTask[],
  viewports: ViewportMatrixEntry[],
  scenarios: RobustnessScenario[],
  impactLevel?: UiImpactLevel,
): UsabilityEvaluationPlan {
  const viewportMetricGroups: Record<string, string[]> = {};
  for (const v of viewports) viewportMetricGroups[v.id] = v.metric_ids;
  return { impact_level: impactLevel, tasks: [...tasks], viewports: [...viewports], viewport_metric_groups: viewportMetricGroups, scenarios: [...scenarios] };
}

/**
 * Run a usability evaluation over structured inputs and produce per-metric
 * {@link MetricScore}s (one per rubric metric the tasks, viewports, and
 * scenarios score). Pure and deterministic — no live browser.
 */
export function runUsabilityEvaluation(
  plan: UsabilityEvaluationPlan,
  inputs: UsabilityEvaluationInputs,
): MetricScore[] {
  const results: AnalysisResult[] = [];
  for (const task of plan.tasks) {
    const metrics = inputs.tasks[task.id];
    if (metrics) results.push(...evaluateCanonicalTask(task, metrics));
  }
  for (const scenario of plan.scenarios) {
    const evidence = inputs.scenarios[scenario.id];
    if (evidence) results.push(...analyzeRobustnessScenario(scenario, evidence));
  }
  for (const viewport of plan.viewports) {
    const evidence = inputs.viewports?.[viewport.id];
    if (evidence) results.push(...evaluateViewport(viewport, evidence));
  }
  return scoreAnalysis(results);
}
