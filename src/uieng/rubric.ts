/**
 * Versioned 60-metric UI rubric engine.
 *
 * Implements docs/specs/autonomous-ui-engineering/shared/02-rubric.md: a stable,
 * versioned registry of 60 separately-retained UI metrics, each with a typed
 * definition (id, name, source, evidence type, 0/25/50/75/100 anchors,
 * confidence, severity, applicability, verification), a persisted-ready
 * `MetricScore` producer, a whole-evaluation scoring entry point with an
 * explicitly-secondary aggregate, and strict id validation.
 *
 * Individual metrics are always retained independently; the aggregate is a
 * convenience and never hides per-metric scores.
 *
 * Scores reference the shared, validated schema contracts from
 * src/uieng/schemas.ts (Finding / EvidenceBundle) and reuse id generation from
 * src/core/ids.ts for any linked record ids.
 */

import { id as newId } from "../core/ids.ts";
import type { EvidenceBundle, Finding } from "./schemas.ts";

/** Current rubric version. Bump whenever metric ids/anchors change semantically. */
export const RUBRIC_VERSION = 1;

export type MetricSource = "deterministic" | "model" | "task";
export type MetricSeverity = "info" | "low" | "medium" | "high" | "critical";

/** Anchored score descriptors at 0 / 25 / 50 / 75 / 100. */
export interface MetricAnchors {
  0: string;
  25: string;
  50: string;
  75: string;
  100: string;
}

/** Typed definition entry for a single rubric metric. */
export interface RubricMetric {
  /** Stable, unique metric id (snake_case). */
  id: string;
  name: string;
  /** How the metric is scored: deterministic tooling, model judgment, or interactive task. */
  source: MetricSource;
  /** The evidence/artifact type that supports the score. */
  evidence: string;
  anchors: MetricAnchors;
  /** Default confidence (0..1) applied when a caller omits one. */
  confidence: number;
  severity: MetricSeverity;
  applicability: string;
  verification: string;
}

/** Input to record a single metric score. */
export interface MetricScoreInput {
  /** 0-100 score. */
  score: number;
  /** 0-1 confidence; defaults to the metric's default confidence when omitted. */
  confidence?: number;
  /** References to EvidenceBundle ids / artifact:// URIs supporting the score. */
  evidence?: string[];
  notes?: string;
  /** Optional linked Finding (from src/uieng/schemas.ts). */
  finding?: Finding;
  /** Optional linked EvidenceBundle (from src/uieng/schemas.ts). */
  evidence_bundle?: EvidenceBundle;
}

/** Persisted-ready typed metric score referencing the shared schema types. */
export interface MetricScore {
  schema_version: number;
  id: string;
  metric_id: string;
  metric_name: string;
  source: MetricSource;
  score: number;
  confidence: number;
  severity: MetricSeverity;
  evidence: string[];
  notes?: string;
  finding?: Finding;
  evidence_bundle?: EvidenceBundle;
  recorded_at: string;
}

/** Whole-evaluation aggregate. Explicitly secondary; never hides per-metric scores. */
export interface RubricAggregate {
  schema_version: number;
  secondary: true;
  rubric_version: number;
  mean_score: number;
  median_score: number;
  min_score: number;
  max_score: number;
  counts_by_source: Record<MetricSource, number>;
  counts_by_severity: Record<MetricSeverity, number>;
  /** All 60 individual scores are always retained alongside the aggregate. */
  scores: MetricScore[];
}

const metric = (
  id: string,
  name: string,
  source: MetricSource,
  evidence: string,
  anchors: MetricAnchors,
  confidence: number,
  severity: MetricSeverity,
  applicability: string,
  verification: string,
): RubricMetric => ({ id, name, source, evidence, anchors, confidence, severity, applicability, verification });

/** Registry of all 60 separately-retained UI metrics. */
export const METRICS: readonly RubricMetric[] = [
  metric(
    "visual_hierarchy",
    "Visual hierarchy",
    "model",
    "screenshots; dom; computed_styles",
    {
      0: "No discernible hierarchy; all elements visually equal",
      25: "Weak hierarchy, few scannable regions",
      50: "Clear primary/secondary emphasis in most views",
      75: "Consistent, deliberate hierarchy across states",
      100: "Exemplary, unambiguous visual hierarchy everywhere",
    },
    0.7,
    "medium",
    "all UIs",
    "Compare screenshot salience + DOM order against intended content priority",
  ),
  metric(
    "alignment",
    "Alignment",
    "deterministic",
    "screenshot; dom; bounds",
    {
      0: "Random placement; elements misaligned",
      25: "Frequent misalignment within groups",
      50: "Mostly aligned with occasional drift",
      75: "Consistent alignment on shared grid",
      100: "Pixel-tight, intentional alignment across all views",
    },
    0.85,
    "low",
    "all UIs",
    "Measure edge offsets/gutters from computed bounds against grid",
  ),
  metric(
    "composition",
    "Composition",
    "model",
    "screenshots",
    {
      0: "Chaotic, unbalanced layout",
      25: "Awkward balance in key views",
      50: "Balanced composition in most views",
      75: "Strong visual balance and grouping",
      100: "Outstanding, cohesive composition",
    },
    0.7,
    "medium",
    "all UIs",
    "Visual review of full-viewport screenshots across states",
  ),
  metric(
    "whitespace",
    "Whitespace",
    "model",
    "screenshots; computed_styles",
    {
      0: "No breathing room; dense cramming",
      25: "Inconsistent or excessive spacing",
      50: "Reasonable whitespace in most views",
      75: "Intentional spacing rhythm",
      100: "Masterful whitespace guiding attention",
    },
    0.7,
    "medium",
    "all UIs",
    "Review padding/margin distribution in screenshots and styles",
  ),
  metric(
    "density",
    "Density",
    "model",
    "screenshots; dom",
    {
      0: "Overcrowded or wasted empty space",
      25: "Poor density balance",
      50: "Acceptable density for content type",
      75: "Good density tuned to task",
      100: "Optimal density maximizing information-to-scroll",
    },
    0.65,
    "medium",
    "data-dense UIs",
    "Assess content-to-scroll ratio and element crowding",
  ),
  metric(
    "typography_hierarchy",
    "Typography hierarchy",
    "deterministic",
    "computed_styles; screenshots",
    {
      0: "Single font size for all text",
      25: "Weak or random type scale",
      50: "Clear heading/body differentiation",
      75: "Consistent, logical type scale",
      100: "Exemplary type scale reinforcing content structure",
    },
    0.85,
    "medium",
    "all UIs",
    "Inspect computed font sizes/weights against a defined type scale",
  ),
  metric(
    "typography_consistency",
    "Typography consistency",
    "deterministic",
    "computed_styles",
    {
      0: "Many ad-hoc font styles",
      25: "Frequent inconsistent styles",
      50: "Mostly consistent with outliers",
      75: "Consistent styles across views",
      100: "Single coherent typography system",
    },
    0.9,
    "low",
    "all UIs",
    "Count distinct font-family/size/weight combinations in computed styles",
  ),
  metric(
    "color_consistency",
    "Color consistency",
    "deterministic",
    "computed_styles",
    {
      0: "Every element a different color",
      25: "Many off-palette colors",
      50: "Mostly on-palette with exceptions",
      75: "Consistent palette usage",
      100: "Strict palette adherence with semantic intent",
    },
    0.9,
    "low",
    "all UIs",
    "Extract computed colors and diff against the declared design palette",
  ),
  metric(
    "contrast",
    "Contrast",
    "deterministic",
    "computed_styles; screenshots",
    {
      0: "Text illegible against background",
      25: "Frequent WCAG failures",
      50: "Most text passes WCAG AA",
      75: "Consistent WCAG AA with AAA in key text",
      100: "Full WCAG AA+ with no failures",
    },
    0.95,
    "high",
    "all UIs",
    "Compute WCAG contrast ratios from computed foreground/background",
  ),
  metric(
    "icon_consistency",
    "Icon consistency",
    "model",
    "screenshots; source_mapping",
    {
      0: "Mixed icon families and strokes",
      25: "Noticeable icon style clashes",
      50: "Mostly consistent iconography",
      75: "Coherent icon set with clear semantics",
      100: "Unified, semantic icon system",
    },
    0.75,
    "low",
    "UIs using icons",
    "Review icons across screenshots for stroke weight/family consistency",
  ),
  metric(
    "affordance",
    "Affordance",
    "model",
    "screenshots; interaction_traces",
    {
      0: "Interactive elements indistinguishable from text",
      25: "Weak affordances for key actions",
      50: "Most controls signal interactivity",
      75: "Clear affordances for all actions",
      100: "Perfectly self-evident interactions",
    },
    0.7,
    "medium",
    "all UIs",
    "Verify hover/focus/cursor cues and visual state for interactive elements",
  ),
  metric(
    "discoverability",
    "Discoverability",
    "model",
    "screenshots; interaction_traces",
    {
      0: "Key features hidden and undiscoverable",
      25: "Important actions buried",
      50: "Main actions discoverable",
      75: "Most features discoverable within 1-2 clicks",
      100: "All features easily discoverable",
    },
    0.65,
    "medium",
    "all UIs",
    "Task-based checks for finding and using key features",
  ),
  metric(
    "navigation_clarity",
    "Navigation clarity",
    "model",
    "screenshots; accessibility_tree",
    {
      0: "No coherent navigation; users get lost",
      25: "Confusing or overlapping nav",
      50: "Clear primary navigation",
      75: "Consistent, predictable navigation model",
      100: "Exemplary navigation with strong wayfinding",
    },
    0.7,
    "high",
    "multi-view UIs",
    "Assess nav structure and current-location indication across views",
  ),
  metric(
    "task_efficiency",
    "Task efficiency",
    "task",
    "interaction_traces; performance",
    {
      0: "Core tasks take many steps or fail",
      25: "Tasks are slow and roundabout",
      50: "Tasks completable in reasonable steps",
      75: "Efficient task flows with few steps",
      100: "Minimal-step, highly efficient flows",
    },
    0.6,
    "high",
    "all UIs",
    "Measure clicks/keystrokes and time-to-complete for representative tasks",
  ),
  metric(
    "cognitive_load",
    "Cognitive load",
    "model",
    "screenshots; dom",
    {
      0: "Overwhelming; too much competing information",
      25: "High load in most views",
      50: "Moderate load with some noise",
      75: "Low load; focused views",
      100: "Minimal cognitive friction",
    },
    0.6,
    "medium",
    "all UIs",
    "Assess information volume, jargon, and competing attention cues",
  ),
  metric(
    "feedback_state_visibility",
    "Feedback/state visibility",
    "model",
    "interaction_traces; screenshots",
    {
      0: "No feedback on user actions",
      25: "Slow or missing state changes",
      50: "Feedback on primary actions",
      75: "Immediate, clear feedback on all actions",
      100: "Exemplary state visibility everywhere",
    },
    0.7,
    "high",
    "all UIs",
    "Verify visible responses to clicks, submits, saves, and errors",
  ),
  metric(
    "error_prevention",
    "Error prevention",
    "task",
    "interaction_traces; console",
    {
      0: "Errors easy to trigger, hard to avoid",
      25: "Few guardrails against mistakes",
      50: "Validation on most inputs",
      75: "Strong validation and confirmation for destructive actions",
      100: "Near-zero preventable errors",
    },
    0.65,
    "high",
    "form/input UIs",
    "Attempt invalid inputs and destructive actions; assess guardrails",
  ),
  metric(
    "error_recovery",
    "Error recovery",
    "task",
    "interaction_traces; console",
    {
      0: "Errors fatal; no recovery path",
      25: "Errors surfaced but no recovery",
      50: "Clear error messages, basic recovery",
      75: "Errors recoverable with preserved context",
      100: "Seamless recovery with full state preservation",
    },
    0.65,
    "high",
    "form/input UIs",
    "Trigger errors and verify message clarity and recovery path",
  ),
  metric(
    "empty_states",
    "Empty states",
    "model",
    "screenshots",
    {
      0: "Empty states are blank/broken",
      25: "Empty states confusing",
      50: "Empty states present with guidance",
      75: "Helpful empty states with clear next action",
      100: "Exemplary empty states that guide users",
    },
    0.7,
    "medium",
    "list/dashboard UIs",
    "Visit views with no data and assess empty-state quality",
  ),
  metric(
    "loading_states",
    "Loading states",
    "task",
    "interaction_traces; screenshots",
    {
      0: "No loading indication; blank screens",
      25: "Loading indicators missing or misleading",
      50: "Basic spinners/skeletons on slow ops",
      75: "Good skeletons/progress with no layout jump",
      100: "Exemplary loading UX",
    },
    0.7,
    "medium",
    "async-heavy UIs",
    "Observe slow network operations for indicators and layout stability",
  ),
  metric(
    "terminology_consistency",
    "Terminology consistency",
    "deterministic",
    "accessibility_tree; dom",
    {
      0: "Contradictory labels for same concept",
      25: "Frequent terminology drift",
      50: "Mostly consistent terminology",
      75: "Consistent labels and copy",
      100: "Single authoritative terminology everywhere",
    },
    0.85,
    "low",
    "all UIs",
    "Scan DOM/accessibility tree for duplicate/conflicting label strings",
  ),
  metric(
    "progressive_disclosure",
    "Progressive disclosure",
    "model",
    "screenshots; dom",
    {
      0: "Everything exposed at once; overwhelming",
      25: "Poor use of reveal-on-demand",
      50: "Advanced options collapsed in some places",
      75: "Good progressive disclosure by task",
      100: "Masterful reveal-on-demand",
    },
    0.65,
    "medium",
    "complex/feature-rich UIs",
    "Assess whether advanced controls are staged and discoverable",
  ),
  metric(
    "information_grouping",
    "Information grouping",
    "model",
    "screenshots; dom",
    {
      0: "Related info scattered randomly",
      25: "Weak grouping of related content",
      50: "Related info grouped in most views",
      75: "Logical grouping with clear sections",
      100: "Optimal grouping aligned to mental model",
    },
    0.7,
    "medium",
    "all UIs",
    "Review layout grouping of related content against task flow",
  ),
  metric(
    "information_pixel_value",
    "Information-to-pixel value",
    "model",
    "screenshots; dom",
    {
      0: "Large pixels wasted on trivial content",
      25: "Poor use of viewport space",
      50: "Reasonable information density",
      75: "High-value use of space",
      100: "Every pixel carries meaningful information",
    },
    0.6,
    "medium",
    "data-dense UIs",
    "Assess data density vs. whitespace for the content type",
  ),
  metric(
    "mobile_reflow",
    "Mobile reflow",
    "task",
    "screenshots; viewport; interaction_traces",
    {
      0: "Layout broken or unusable on mobile",
      25: "Mobile layout has major issues",
      50: "Usable but rough mobile layout",
      75: "Good mobile layout with proper reflow",
      100: "Excellent mobile experience",
    },
    0.7,
    "high",
    "responsive UIs",
    "Render at mobile viewport widths and test core flows",
  ),
  metric(
    "tablet_reflow",
    "Tablet reflow",
    "task",
    "screenshots; viewport",
    {
      0: "Tablet layout broken",
      25: "Tablet layout has major issues",
      50: "Usable but rough tablet layout",
      75: "Good tablet layout",
      100: "Excellent tablet experience",
    },
    0.7,
    "medium",
    "responsive UIs",
    "Render at tablet viewport widths and assess layout",
  ),
  metric(
    "desktop_layout",
    "Desktop layout",
    "task",
    "screenshots; viewport",
    {
      0: "Desktop layout broken or empty",
      25: "Desktop layout has issues",
      50: "Usable desktop layout",
      75: "Good desktop layout",
      100: "Excellent desktop experience",
    },
    0.75,
    "medium",
    "all UIs",
    "Render at standard desktop widths and assess layout",
  ),
  metric(
    "ultrawide_behavior",
    "Ultrawide behavior",
    "task",
    "screenshots; viewport",
    {
      0: "Ultrawide renders unusable",
      25: "Content stretches/breaks at ultrawide",
      50: "Acceptable ultrawide behavior",
      75: "Content max-widths and layout hold up",
      100: "Excellent ultrawide experience",
    },
    0.6,
    "low",
    "all UIs",
    "Render at ultrawide viewport and check for over-stretching",
  ),
  metric(
    "orientation",
    "Orientation",
    "task",
    "screenshots; viewport",
    {
      0: "Rotating device breaks layout",
      25: "Orientation change causes issues",
      50: "Layout works in both orientations",
      75: "Good both orientations with no data loss",
      100: "Seamless orientation handling",
    },
    0.6,
    "medium",
    "mobile/tablet UIs",
    "Rotate viewport and verify layout and state preservation",
  ),
  metric(
    "zoom_reflow",
    "Zoom/reflow",
    "task",
    "screenshots; viewport",
    {
      0: "Zooming breaks or clips content",
      25: "Zoom causes severe layout issues",
      50: "Zoom usable with minor issues",
      75: "Content reflows well under zoom",
      100: "Perfect reflow under all zoom levels",
    },
    0.6,
    "medium",
    "all UIs",
    "Test browser zoom levels and verify content reflow/clipping",
  ),
  metric(
    "touch_targets",
    "Touch targets",
    "deterministic",
    "bounds; accessibility_tree",
    {
      0: "Targets tiny and un-tappable",
      25: "Many targets below 44px",
      50: "Most targets at least 44px",
      75: "All targets ≥44px with spacing",
      100: "Comfortable ≥48px targets with spacing",
    },
    0.9,
    "medium",
    "touch UIs",
    "Measure interactive element bounding sizes against 44/48px minimums",
  ),
  metric(
    "keyboard_navigation",
    "Keyboard navigation",
    "task",
    "accessibility_tree; interaction_traces",
    {
      0: "Keyboard unusable",
      25: "Major keyboard navigation gaps",
      50: "Basic keyboard navigation works",
      75: "Full keyboard navigation with shortcuts",
      100: "Exemplary keyboard-first experience",
    },
    0.7,
    "high",
    "all UIs",
    "Traverse the UI using only keyboard; verify focus reachability",
  ),
  metric(
    "focus_management",
    "Focus management",
    "task",
    "accessibility_tree; interaction_traces",
    {
      0: "Focus lost or trapped",
      25: "Focus frequently lost",
      50: "Focus mostly managed",
      75: "Focus moves predictably and is restored",
      100: "Exemplary focus management incl. modals",
    },
    0.7,
    "high",
    "all UIs",
    "Verify focus order, visible focus indicators, and restoration on close",
  ),
  metric(
    "semantic_accessibility",
    "Semantic accessibility",
    "deterministic",
    "accessibility_tree; dom",
    {
      0: "No semantic roles or landmarks",
      25: "Mostly divs; few semantics",
      50: "Some semantic elements and landmarks",
      75: "Consistent landmarks, roles, and ARIA",
      100: "Exemplary semantic accessibility",
    },
    0.9,
    "high",
    "all UIs",
    "Validate accessibility tree for landmarks, roles, names, and aria attributes",
  ),
  metric(
    "labels",
    "Labels",
    "deterministic",
    "accessibility_tree",
    {
      0: "Controls have no accessible labels",
      25: "Many unlabeled controls",
      50: "Most controls labeled",
      75: "All controls labeled with clear names",
      100: "Exemplary labeling incl. group/context",
    },
    0.9,
    "high",
    "all UIs",
    "Check every interactive control has a non-empty accessible name",
  ),
  metric(
    "reduced_motion",
    "Reduced motion",
    "deterministic",
    "computed_styles; source_mapping",
    {
      0: "No reduced-motion handling; heavy animation",
      25: "Minimal reduced-motion support",
      50: "Some animations respect prefers-reduced-motion",
      75: "Most animations disabled under reduced motion",
      100: "Full reduced-motion compliance",
    },
    0.8,
    "medium",
    "animated UIs",
    "Audit CSS/JS animation against prefers-reduced-motion media query",
  ),
  metric(
    "component_reuse",
    "Component reuse",
    "deterministic",
    "source_mapping; dom",
    {
      0: "Every element hand-built; no reuse",
      25: "Little component reuse",
      50: "Some shared components",
      75: "Most UI built from reusable components",
      100: "High reuse with clean composition",
    },
    0.85,
    "low",
    "code-based UIs",
    "Analyze source_mapping for duplicated vs shared component usage",
  ),
  metric(
    "component_api_consistency",
    "Component API consistency",
    "deterministic",
    "source_mapping",
    {
      0: "Inconsistent component props/APIs",
      25: "Frequent API inconsistency",
      50: "Mostly consistent APIs",
      75: "Consistent, well-named component APIs",
      100: "Exemplary API consistency",
    },
    0.8,
    "low",
    "code-based UIs",
    "Audit component prop signatures and naming across the codebase",
  ),
  metric(
    "component_complexity",
    "Component complexity",
    "deterministic",
    "source_mapping",
    {
      0: "Monolithic, unmaintainable components",
      25: "Over-complex components",
      50: "Moderate component complexity",
      75: "Components well-scoped and composable",
      100: "Simple, focused components",
    },
    0.8,
    "medium",
    "code-based UIs",
    "Measure component size/coupling via source_mapping",
  ),
  metric(
    "design_token_adherence",
    "Design-token adherence",
    "deterministic",
    "computed_styles; source_mapping",
    {
      0: "Hard-coded values everywhere; no tokens",
      25: "Few tokens used",
      50: "Most styles via tokens",
      75: "Consistent token usage",
      100: "Strict token adherence, no raw literals",
    },
    0.9,
    "medium",
    "code-based UIs",
    "Scan computed_styles/source_mapping for raw values vs. token references",
  ),
  metric(
    "design_entropy",
    "Design entropy",
    "deterministic",
    "computed_styles; source_mapping",
    {
      0: "Chaotic accumulation of one-off styles",
      25: "Rising style divergence",
      50: "Moderate style entropy",
      75: "Low entropy, consistent patterns",
      100: "Negligible entropy; coherent design system",
    },
    0.8,
    "low",
    "all UIs",
    "Measure divergence of repeated style patterns across the codebase",
  ),
  metric(
    "style_duplication",
    "Style duplication",
    "deterministic",
    "computed_styles; source_mapping",
    {
      0: "Same styles re-declared everywhere",
      25: "Heavy style duplication",
      50: "Some duplication",
      75: "Little duplication; shared styles",
      100: "No duplication; single source of truth",
    },
    0.85,
    "low",
    "code-based UIs",
    "Detect repeated style declarations via computed_styles/source_mapping",
  ),
  metric(
    "code_duplication",
    "Code duplication",
    "deterministic",
    "source_mapping",
    {
      0: "Extensive copy-pasted UI logic",
      25: "Frequent duplication",
      50: "Some duplication",
      75: "Little duplication; shared helpers",
      100: "No duplication; clean reuse",
    },
    0.85,
    "low",
    "code-based UIs",
    "Detect duplicated UI logic blocks via source_mapping",
  ),
  metric(
    "dead_ui_code_styles",
    "Dead UI code/styles",
    "deterministic",
    "source_mapping; dom",
    {
      0: "Large amounts of unused UI code/styles",
      25: "Notable dead code",
      50: "Some dead code/styles",
      75: "Little dead code; mostly pruned",
      100: "No dead code or unused styles",
    },
    0.8,
    "low",
    "code-based UIs",
    "Detect unreferenced CSS and unused UI components via source_mapping",
  ),
  metric(
    "dom_complexity",
    "DOM complexity",
    "deterministic",
    "dom; accessibility_tree",
    {
      0: "Extremely deep/nested DOM",
      25: "Deep DOM with many wrapper elements",
      50: "Moderate DOM depth",
      75: "Shallow, clean DOM",
      100: "Minimal DOM with flat, semantic structure",
    },
    0.85,
    "medium",
    "all UIs",
    "Measure DOM depth, node count, and wrapper elements",
  ),
  metric(
    "dependency_complexity",
    "Dependency complexity",
    "deterministic",
    "source_mapping",
    {
      0: "Tangled dependency graph",
      25: "Many unnecessary dependencies",
      50: "Moderate dependency footprint",
      75: "Lean, justified dependencies",
      100: "Minimal, well-scoped dependencies",
    },
    0.8,
    "low",
    "code-based UIs",
    "Analyze UI module dependency graph for size/cycles",
  ),
  metric(
    "responsive_implementation",
    "Responsive implementation",
    "deterministic",
    "computed_styles; source_mapping",
    {
      0: "No responsive rules; fixed widths",
      25: "Few breakpoints, inconsistent",
      50: "Responsive rules in most views",
      75: "Consistent responsive implementation",
      100: "Exemplary responsive architecture",
    },
    0.85,
    "high",
    "responsive UIs",
    "Audit media queries/breakpoints and responsive style coverage",
  ),
  metric(
    "interaction_latency",
    "Interaction latency",
    "deterministic",
    "performance; interaction_traces",
    {
      0: "Interactions feel unresponsive (>300ms)",
      25: "Noticeable lag on interactions",
      50: "Acceptable latency",
      75: "Snappy interactions",
      100: "Instant, imperceptible latency",
    },
    0.8,
    "high",
    "all UIs",
    "Measure input-to-response latency from performance/interaction traces",
  ),
  metric(
    "layout_stability",
    "Layout stability",
    "deterministic",
    "performance; screenshots",
    {
      0: "Severe layout shift on load/async",
      25: "Frequent layout shifts",
      50: "Occasional shifts",
      75: "Stable layout with minimal shift",
      100: "No layout shift (CLS ≈ 0)",
    },
    0.85,
    "high",
    "async UIs",
    "Measure cumulative layout shift across loads and async updates",
  ),
  metric(
    "render_performance_cost",
    "Render/performance cost",
    "deterministic",
    "performance",
    {
      0: "Slow renders; jank on interactions",
      25: "High render cost",
      50: "Acceptable render performance",
      75: "Efficient renders",
      100: "Excellent render performance",
    },
    0.8,
    "medium",
    "all UIs",
    "Measure render/repaint times and frame rates from performance data",
  ),
  metric(
    "asset_weight",
    "Asset weight",
    "deterministic",
    "network; performance",
    {
      0: "Excessive asset sizes/bundles",
      25: "Heavy assets slowing load",
      50: "Moderate asset weight",
      75: "Lean, optimized assets",
      100: "Minimal, optimal asset delivery",
    },
    0.8,
    "medium",
    "all UIs",
    "Measure total transferred bytes and bundle sizes from network data",
  ),
  metric(
    "refresh_deep_link_robustness",
    "Refresh/deep-link robustness",
    "task",
    "network; interaction_traces",
    {
      0: "Refresh/deep-link loses state or 404s",
      25: "Frequent state loss on refresh",
      50: "Refresh preserves most state",
      75: "Deep links restore correct state",
      100: "Refresh and deep links always restore state",
    },
    0.7,
    "high",
    "SPA UIs",
    "Refresh and deep-link into views; verify state restoration",
  ),
  metric(
    "back_forward",
    "Back/forward",
    "task",
    "interaction_traces",
    {
      0: "Back/forward broken or loses state",
      25: "Back navigation frequently wrong",
      50: "Basic back/forward works",
      75: "Back/forward preserves state and scroll",
      100: "Seamless history navigation",
    },
    0.7,
    "high",
    "multi-view UIs",
    "Navigate forward/back and verify state and scroll restoration",
  ),
  metric(
    "repeated_click_double_submit",
    "Repeated-click/double-submit robustness",
    "task",
    "interaction_traces; network",
    {
      0: "Double-submit creates duplicate records/errors",
      25: "Double-click causes problems",
      50: "Some guards against repeat submits",
      75: "Robust idempotent handling",
      100: "Fully guarded against repeated clicks/submits",
    },
    0.7,
    "high",
    "form/action UIs",
    "Rapidly click submit/actions and verify no duplicates",
  ),
  metric(
    "slow_error_network",
    "Slow/error network behavior",
    "task",
    "network; console",
    {
      0: "App breaks or hangs on slow/error network",
      25: "Poor handling of network errors",
      50: "Errors handled with retry",
      75: "Graceful degradation with clear retry",
      100: "Excellent resilience to network issues",
    },
    0.7,
    "high",
    "network UIs",
    "Throttle/simulate network failures and observe behavior",
  ),
  metric(
    "long_content_resilience",
    "Long-content resilience",
    "task",
    "screenshots; performance",
    {
      0: "Layout breaks with long content",
      25: "Long content causes issues",
      50: "Handles long content acceptably",
      75: "Good handling of long content",
      100: "Exemplary long-content rendering",
    },
    0.7,
    "medium",
    "content UIs",
    "Inject long text/lists and verify layout integrity",
  ),
  metric(
    "large_dataset_resilience",
    "Large-dataset resilience",
    "task",
    "performance; screenshots",
    {
      0: "UI crashes or unusable with large datasets",
      25: "Severe degradation with large data",
      50: "Acceptable performance with large data",
      75: "Good performance via virtualization/pagination",
      100: "Excellent large-dataset handling",
    },
    0.7,
    "high",
    "data-dense UIs",
    "Load large datasets and measure render/scroll performance",
  ),
  metric(
    "modal_drawer_stacking",
    "Modal/drawer stacking",
    "task",
    "interaction_traces; screenshots",
    {
      0: "Modals/drawers break or trap users",
      25: "Stacking issues with multiple overlays",
      50: "Basic overlay handling",
      75: "Correct stacking, focus, and dismissal",
      100: "Exemplary overlay management",
    },
    0.7,
    "medium",
    "overlay UIs",
    "Open nested modals/drawers and verify stacking, focus, and close",
  ),
  metric(
    "cross_screen_semantic_consistency",
    "Cross-screen semantic consistency",
    "model",
    "screenshots; accessibility_tree",
    {
      0: "Each screen looks/behaves differently",
      25: "Notable inconsistency across screens",
      50: "Mostly consistent patterns",
      75: "Consistent semantics and patterns across screens",
      100: "Fully coherent cross-screen experience",
    },
    0.7,
    "medium",
    "multi-screen UIs",
    "Compare patterns, terminology, and behavior across all screens",
  ),
  metric(
    "critical_task_completion",
    "Critical-task completion",
    "task",
    "interaction_traces; performance",
    {
      0: "Core tasks fail to complete",
      25: "Critical tasks often fail",
      50: "Critical tasks complete with friction",
      75: "Critical tasks complete reliably",
      100: "All critical tasks complete flawlessly",
    },
    0.6,
    "high",
    "all UIs",
    "Execute the top critical user journeys end-to-end and measure success",
  ),
];

/** Stable ordered list of all 60 metric ids. */
export const METRIC_IDS: readonly string[] = METRICS.map((m) => m.id);

/** Lookup registry keyed by metric id. */
export const METRICS_BY_ID: ReadonlyMap<string, RubricMetric> = new Map(METRICS.map((m) => [m.id, m]));

/** The 60-metric registry, versioned. */
export const RUBRIC_REGISTRY = {
  version: RUBRIC_VERSION,
  metric_count: METRICS.length,
  metrics: METRICS,
} as const;

const clampScore = (n: number): number => {
  if (!Number.isFinite(n)) throw new Error(`Invalid score ${n}; expected 0..100`);
  return Math.min(100, Math.max(0, n));
};

const clampConfidence = (n: number): number => {
  if (!Number.isFinite(n)) throw new Error(`Invalid confidence ${n}; expected 0..1`);
  return Math.min(1, Math.max(0, n));
};

/**
 * Validate that a set of metric ids contains exactly known ids, with no
 * duplicates and no unknown ids.
 */
export function validateMetricIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const metricId of ids) {
    const def = METRICS_BY_ID.get(metricId);
    if (!def) throw new Error(`Unknown metric id "${metricId}"`);
    if (seen.has(metricId)) throw new Error(`Duplicate metric id "${metricId}"`);
    seen.add(metricId);
  }
}

/** Assert a single metric id is known; returns its definition. */
export function assertMetricKnown(metricId: string): RubricMetric {
  const def = METRICS_BY_ID.get(metricId);
  if (!def) throw new Error(`Unknown metric id "${metricId}"`);
  return def;
}

/**
 * Produce a typed, persisted-ready MetricScore for a single metric.
 * Validates the metric id and clamps score/confidence to valid ranges.
 */
export function scoreRecord(metricId: string, input: MetricScoreInput): MetricScore {
  const def = assertMetricKnown(metricId);
  const confidence = clampConfidence(input.confidence ?? def.confidence);
  const score = clampScore(input.score);
  return {
    schema_version: RUBRIC_VERSION,
    id: newId("MSC"),
    metric_id: def.id,
    metric_name: def.name,
    source: def.source,
    score,
    confidence,
    severity: def.severity,
    evidence: [...(input.evidence ?? [])],
    notes: input.notes,
    finding: input.finding,
    evidence_bundle: input.evidence_bundle,
    recorded_at: new Date().toISOString(),
  };
}

/**
 * Score ALL 60 metrics for an evaluation. Requires exactly the 60 known ids
 * (no unknown, no duplicates, no missing). Returns every individual score.
 */
export function scoreAll(inputs: Record<string, MetricScoreInput>): MetricScore[] {
  const keys = Object.keys(inputs);
  validateMetricIds(keys);
  if (keys.length !== METRICS.length) {
    throw new Error(
      `Expected ${METRICS.length} metric scores, got ${keys.length}. Missing: ${METRICS.filter(
        (m) => !keys.includes(m.id),
      )
        .map((m) => m.id)
        .join(", ")}`,
    );
  }
  return METRICS.map((m) => scoreRecord(m.id, inputs[m.id] as MetricScoreInput));
}

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Compute the OPTIONAL aggregate over all 60 scores.
 *
 * Explicitly marked `secondary: true`; the individual `MetricScore`s are always
 * retained and must never be hidden behind the aggregate. Callers consuming an
 * aggregate must also surface per-metric scores.
 */
export function aggregateScores(scores: readonly MetricScore[]): RubricAggregate {
  const values = scores.map((s) => s.score).sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const countsBySource: Record<MetricSource, number> = { deterministic: 0, model: 0, task: 0 };
  const countsBySeverity: Record<MetricSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const s of scores) {
    countsBySource[s.source] = (countsBySource[s.source] ?? 0) + 1;
    countsBySeverity[s.severity] = (countsBySeverity[s.severity] ?? 0) + 1;
  }
  return {
    schema_version: RUBRIC_VERSION,
    secondary: true,
    rubric_version: RUBRIC_VERSION,
    mean_score: mean,
    median_score: median(values),
    min_score: values[0] ?? 0,
    max_score: values[values.length - 1] ?? 0,
    counts_by_source: countsBySource,
    counts_by_severity: countsBySeverity,
    scores: [...scores],
  };
}
