/**
 * Automatic UI-impact change classifier + auto-attach policy
 * (docs/specs/autonomous-ui-engineering/pi-engineering/01-auto-policy.md).
 *
 * A change touching UI paths derives a proportional UI-evaluation gate with
 * levels L0 none / L1 micro / L2 feature-workflow / L3 system-design-system.
 * Backend/API/auth/data changes can be UI-impacting too (API response shape,
 * auth redirects, data-driven rendering), so classification is NOT limited to
 * *.css/*.tsx paths.
 *
 * All functions here are pure and deterministic — auto-attach requires no user
 * command and no remembered prompt.
 */

import { ChangeClassifier } from "../cav/classify.ts";
import type { MetricSeverity } from "./rubric.ts";
import type { Finding, UiProfile } from "./schemas.ts";

/** Proportional UI-impact levels. */
export type UiImpactLevel = "L0_none" | "L1_micro" | "L2_feature_workflow" | "L3_system_design_system";

export const UI_IMPACT_LEVELS: readonly UiImpactLevel[] = [
  "L0_none",
  "L1_micro",
  "L2_feature_workflow",
  "L3_system_design_system",
];

const LEVEL_ORDER: Record<UiImpactLevel, number> = {
  L0_none: 0,
  L1_micro: 1,
  L2_feature_workflow: 2,
  L3_system_design_system: 3,
};

/** Numeric rank of a level (higher = more impact). */
export function rankLevel(level: UiImpactLevel): number {
  return LEVEL_ORDER[level];
}

/** Path patterns that imply system/design-system impact. */
const SYSTEM_PATHS: RegExp[] = [
  /(^|\/)(design-system|design_system)(\/|\.|$)/i,
  /(^|\/)(tokens?|theme|themes)(\/|\.|$)/i,
  /(^|\/)(styles?|css|scss|sass|stylus|less)(\/|\.|$)/i,
  /(^|\/)tailwind\.config/i,
  /(^|\/)(global|base|reset)\.(css|scss|sass|less)$/i,
  /(^|\/)(layouts?)(\/|\.|$)/i,
  /(^|\/)theme\.(ts|tsx|js|jsx)$/i,
  /(^|\/)variables\.(css|scss|sass|less)$/i,
];

/** Path patterns that imply feature/workflow impact (pages, routes, flows). */
const FEATURE_PATHS: RegExp[] = [
  /(^|\/)(pages?|routes?|app|views?|screens?|features?)(\/|\.|$)/i,
  /(^|\/)(workflows?|flows?|journeys?)(\/|\.|$)/i,
  /(^|\/)(components)\/[^/]*\/[^/]+\.(tsx|jsx|svelte|vue|astro)$/i,
];

/** Backend/API/auth/data patterns that can still be UI-impacting. */
const BACKEND_PATHS: RegExp[] = [
  /(^|\/)(api|controllers?|handlers?|services?|endpoints?|middleware)(\/|\.|$)/i,
  /(^|\/)(auth|login|signin|signup|logout|redirect|session|sessions)(\/|\.|$)/i,
  /(^|\/)(data|models?|schemas?|repositories?|stores?|store)(\/|\.|$)/i,
];

const COMPONENT_EXT_RE = /\.(tsx|jsx|svelte|vue|astro|html)$/i;

/** Per-path UI-impact level; pure and deterministic. */
function uiImpactForPath(path: string, kind: string, profile: UiProfile | undefined): UiImpactLevel {
  if (SYSTEM_PATHS.some((re) => re.test(path))) return "L3_system_design_system";
  if (FEATURE_PATHS.some((re) => re.test(path))) return "L2_feature_workflow";
  if (BACKEND_PATHS.some((re) => re.test(path))) {
    // Backend/API/auth/data changes are UI-impacting when a UI surface exists.
    return profile?.ui_present ? "L2_feature_workflow" : "L0_none";
  }
  if (kind === "ui" || COMPONENT_EXT_RE.test(path)) return "L1_micro";
  return "L0_none";
}

/**
 * Classify a diff into a proportional UI-impact level. Reuses the CAV change
 * classifier (src/cav/classify.ts) for per-path kinds, then maps UI, feature,
 * backend/API/auth/data and design-system paths onto the level scale.
 */
export function classifyChange(diffPaths: string[], uiProfile?: UiProfile): UiImpactLevel {
  const classification = new ChangeClassifier().classify(diffPaths);
  let level: UiImpactLevel = "L0_none";
  for (const path of diffPaths) {
    const l = uiImpactForPath(path, classification.byPath[path] ?? "other", uiProfile);
    if (rankLevel(l) > rankLevel(level)) level = l;
  }
  return level;
}

// ---------------------------------------------------------------------------
// Rubric metric groups
// ---------------------------------------------------------------------------

export const METRIC_GROUP_IDS = [
  "visual",
  "accessibility",
  "responsive",
  "interaction_workflow",
  "design_system",
  "performance",
  "robustness",
] as const;
export type MetricGroupId = (typeof METRIC_GROUP_IDS)[number];

/** Rubric metric groups used by the proportional evaluation plan. */
export const METRIC_GROUPS: Record<MetricGroupId, readonly string[]> = {
  visual: [
    "visual_hierarchy",
    "alignment",
    "composition",
    "whitespace",
    "density",
    "typography_hierarchy",
    "typography_consistency",
    "color_consistency",
    "contrast",
    "icon_consistency",
  ],
  accessibility: [
    "affordance",
    "discoverability",
    "touch_targets",
    "keyboard_navigation",
    "focus_management",
    "semantic_accessibility",
    "labels",
    "reduced_motion",
    "orientation",
    "zoom_reflow",
    "terminology_consistency",
  ],
  responsive: [
    "mobile_reflow",
    "tablet_reflow",
    "desktop_layout",
    "ultrawide_behavior",
    "orientation",
    "zoom_reflow",
    "touch_targets",
    "responsive_implementation",
  ],
  interaction_workflow: [
    "discoverability",
    "navigation_clarity",
    "task_efficiency",
    "cognitive_load",
    "feedback_state_visibility",
    "error_prevention",
    "error_recovery",
    "empty_states",
    "loading_states",
    "progressive_disclosure",
    "information_grouping",
    "information_pixel_value",
  ],
  design_system: [
    "design_token_adherence",
    "design_entropy",
    "style_duplication",
    "component_reuse",
    "component_api_consistency",
    "component_complexity",
    "code_duplication",
    "dead_ui_code_styles",
    "dependency_complexity",
  ],
  performance: ["interaction_latency", "layout_stability", "render_performance_cost", "asset_weight", "dom_complexity"],
  robustness: [
    "refresh_deep_link_robustness",
    "back_forward",
    "repeated_click_double_submit",
    "slow_error_network",
    "long_content_resilience",
    "large_dataset_resilience",
    "modal_drawer_stacking",
    "cross_screen_semantic_consistency",
    "critical_task_completion",
  ],
};

/** Browser test kinds in the evaluation plan. */
export const BROWSER_TEST_KINDS = ["smoke", "workflow", "visual_regression", "accessibility", "performance"] as const;
export type BrowserTestKind = (typeof BROWSER_TEST_KINDS)[number];

/** Viewport matrix targets. */
export const VIEWPORT_TARGETS = ["mobile", "tablet", "desktop", "ultrawide"] as const;
export type ViewportTarget = (typeof VIEWPORT_TARGETS)[number];

/** The proportional evaluation plan for a given impact level. */
export interface EvaluationPlan {
  level: UiImpactLevel;
  /** Required gate is active whenever level > L0. */
  required: boolean;
  /** Rubric metric groups that apply at this level. */
  metric_groups: MetricGroupId[];
  /** Expanded metric ids from the applicable groups. */
  metric_ids: string[];
  /** Browser test kinds to run. */
  browser_tests: BrowserTestKind[];
  /** Viewport matrix to evaluate against. */
  viewports: ViewportTarget[];
  reason: string;
}

const ALL_GROUPS = [...METRIC_GROUP_IDS];
const ALL_TESTS = [...BROWSER_TEST_KINDS];
const ALL_VIEWPORTS = [...VIEWPORT_TARGETS];

/**
 * Derive the proportional UI-evaluation plan for a level + profile.
 * L0 → no gate. L1 → visual/responsive smoke. L2 → + accessibility and the
 * workflow/robustness groups across tablet. L3 → full system-design-system
 * pass across the whole viewport matrix.
 */
export function derivedEvaluation(input: { level: UiImpactLevel; uiProfile?: UiProfile }): EvaluationPlan {
  const { level } = input;
  const groups = (ids: MetricGroupId[]) => ids;
  const expand = (gs: MetricGroupId[]) => [...new Set(gs.flatMap((g) => METRIC_GROUPS[g]))];

  switch (level) {
    case "L0_none":
      return {
        level,
        required: false,
        metric_groups: [],
        metric_ids: [],
        browser_tests: [],
        viewports: [],
        reason: "No UI-impacting change: no UI-evaluation gate is required.",
      };
    case "L1_micro": {
      const gs = groups(["visual", "responsive"]);
      return {
        level,
        required: true,
        metric_groups: gs,
        metric_ids: expand(gs),
        browser_tests: ["smoke"],
        viewports: ["mobile", "desktop"],
        reason: "Micro UI change: smoke visual/responsive check on primary viewports.",
      };
    }
    case "L2_feature_workflow": {
      const gs = groups(["visual", "responsive", "accessibility", "interaction_workflow", "robustness"]);
      return {
        level,
        required: true,
        metric_groups: gs,
        metric_ids: expand(gs),
        browser_tests: ["smoke", "workflow", "accessibility"],
        viewports: ["mobile", "tablet", "desktop"],
        reason: "Feature/workflow change: full workflow + a11y pass across mobile/tablet/desktop.",
      };
    }
    case "L3_system_design_system":
      return {
        level,
        required: true,
        metric_groups: ALL_GROUPS,
        metric_ids: expand(ALL_GROUPS),
        browser_tests: ALL_TESTS,
        viewports: ALL_VIEWPORTS,
        reason: "System/design-system change: full rubric pass across the whole viewport matrix.",
      };
  }
}

// ---------------------------------------------------------------------------
// Gate failure + remediation budget
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<MetricSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface AutoRemedy {
  summary: string;
  severity: MetricSeverity;
}

export interface GateFailure {
  failed: boolean;
  level: UiImpactLevel;
  /** Findings severe enough to count as failures. */
  failingFindings: Finding[];
  /** Auto-created remediation items (bounded by budget). */
  remediation: AutoRemedy[];
  reason: string;
}

export interface GateBudget {
  /** Lowest severity that counts as a gate failure. Default "high". */
  minSeverity?: MetricSeverity;
  /** Max auto-created remediation items per gate. Default unlimited. */
  maxRemediation?: number;
}

/**
 * Determine whether a change is unfinished (gate failed) and should
 * auto-create remediation work. Pure/deterministic; respects a configured
 * budget (severity floor + max remediation items). L0 never fails.
 */
export function gateFailed(level: UiImpactLevel, findings: readonly Finding[], budget?: GateBudget): GateFailure {
  const plan = derivedEvaluation({ level });
  if (!plan.required) {
    return { failed: false, level, failingFindings: [], remediation: [], reason: "No UI-evaluation gate required." };
  }
  const minSeverity = budget?.minSeverity ?? "high";
  const floor = SEVERITY_ORDER[minSeverity];
  const failing = findings.filter((f) => SEVERITY_ORDER[f.severity] >= floor);
  if (failing.length === 0) {
    return {
      failed: false,
      level,
      failingFindings: [],
      remediation: [],
      reason: `Gate passed: no finding at or above ${minSeverity} severity.`,
    };
  }
  const capped = failing.slice(0, budget?.maxRemediation ?? failing.length);
  const remediation = capped.map((f) => ({
    summary: f.remediation ?? `Resolve ${f.severity} finding: ${f.impact ?? f.root_cause ?? "unfinished UI change"}`,
    severity: f.severity,
  }));
  return {
    failed: true,
    level,
    failingFindings: capped,
    remediation,
    reason: `${failing.length} finding(s) at or above ${minSeverity} severity; auto-creating ${remediation.length} remediation item(s).`,
  };
}

// ---------------------------------------------------------------------------
// Auto-attach (pure, deterministic, no command / no remembered prompt)
// ---------------------------------------------------------------------------

export interface AutoAttachOptions {
  /** Gate budget forwarded to gateFailed for remediation sizing. */
  budget?: GateBudget;
}

export interface AutoAttachDecision {
  /** Whether to auto-attach a UI-evaluation gate to this change. */
  attach: boolean;
  level: UiImpactLevel;
  plan: EvaluationPlan;
  reason: string;
}

/**
 * The automatic UI-policy attach rule: given a diff and the discovered UI
 * profile, decide whether a UI-evaluation gate should be attached. Pure and
 * deterministic — never requires a slash command or remembered prompt.
 */
export function autoAttach(diffPaths: string[], uiProfile?: UiProfile, opts?: AutoAttachOptions): AutoAttachDecision {
  const level = classifyChange(diffPaths, uiProfile);
  const plan = derivedEvaluation({ level, uiProfile });
  return {
    attach: plan.required,
    level,
    plan,
    reason: plan.required
      ? `Change classified ${level}; attaching UI-evaluation gate (${plan.browser_tests.join(", ")} on ${plan.viewports.join(", ")}).`
      : "Change has no UI impact; no gate attached.",
  };
}
