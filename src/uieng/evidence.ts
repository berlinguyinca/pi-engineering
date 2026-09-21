/**
 * Evidence capture + deterministic analyzers for autonomous UI engineering
 * (docs/specs/autonomous-ui-engineering/pi-engineering/02-evidence.md).
 *
 * Two layers:
 *  1. A typed {@link CapturePlan} -> {@link EvidenceBundle} producer that gathers
 *     synchronized screenshots, optional interaction video, DOM, accessibility
 *     tree, bounds, computed styles, route/state, console/network events,
 *     performance/layout-shift trace, interaction history,
 *     viewport/device/zoom/orientation, and source/component mapping. It emits
 *     the shared, persisted-ready {@link EvidenceBundle} from src/uieng/schemas.ts
 *     (never redefined here) and validates it against the shared schema.
 *  2. A set of DETERMINISTIC analyzers (no model inference) that run over
 *     structured capture inputs and map to rubric metric ids from
 *     src/uieng/rubric.ts. Each returns a typed {@link AnalysisResult} that the
 *     rubric engine's `scoreRecord` consumes directly.
 *
 * Analyzers are pure functions over plain structured inputs so they are
 * deterministically unit-testable with no live browser. Reuse patterns from
 * src/cav/a11y.ts and src/cav/browser.ts where helpful.
 */

import { id as newId } from "../core/ids.ts";
import { scoreRecord } from "./rubric.ts";
import type { MetricScore } from "./rubric.ts";
import { SCHEMA_VERSION, validateRecord } from "./schemas.ts";
import type { EvidenceBundle } from "./schemas.ts";

/**
 * Viewport/device/zoom/orientation capture. The shared EvidenceBundle schema
 * retains width/height/device_scale_factor; zoom/orientation/device are folded
 * into the bundle `state` field so nothing captured is lost (see
 * {@link produceEvidenceBundle}).
 */
export interface ViewportInfo {
  width: number;
  height: number;
  device_scale_factor?: number;
  /** Browser zoom factor (e.g. 1, 1.5). */
  zoom?: number;
  orientation?: "portrait" | "landscape";
  device?: string;
}

/** Bounding box captured for a target element / viewport. */
export interface Bounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * A typed capture plan: describes what evidence to gather and how it maps onto
 * a persisted {@link EvidenceBundle}. Consumers populate this from a real
 * browser instrumentation pass (see src/cav/browser.ts) and then call
 * {@link produceEvidenceBundle} to emit the persisted-ready record.
 */
export interface CapturePlan {
  route?: string;
  state?: string;
  viewport: ViewportInfo;
  /** Synchronized screenshot artifact refs (one per captured state/viewport). */
  screenshots: string[];
  /** Optional interaction-video artifact ref. */
  video?: string;
  /** Serialized DOM snapshot. */
  dom?: string;
  /** Serialized accessibility tree. */
  accessibility_tree?: string;
  bounds?: Bounds;
  computed_styles?: Record<string, unknown>;
  console?: Array<Record<string, unknown>>;
  network?: Array<Record<string, unknown>>;
  /** Performance / layout-shift trace (e.g. { cls, lcp, fid }). */
  performance?: Record<string, number>;
  interaction_traces?: Array<Record<string, unknown>>;
  source_mapping?: Array<Record<string, unknown>>;
  commit?: string;
  worktree?: string;
}

export interface ProduceEvidenceOptions {
  /** Explicit record id; defaults to a fresh `EVID` id. */
  id?: string;
}

/** Fold device/zoom/orientation viewport extras into the bundle `state`. */
function viewportState(plan: CapturePlan): string | undefined {
  const extras: Record<string, unknown> = {};
  if (plan.viewport.zoom !== undefined) extras.zoom = plan.viewport.zoom;
  if (plan.viewport.orientation !== undefined) extras.orientation = plan.viewport.orientation;
  if (plan.viewport.device !== undefined) extras.device = plan.viewport.device;
  if (Object.keys(extras).length === 0) return plan.state;
  return JSON.stringify({ ...(plan.state ? { state: plan.state } : {}), viewport: extras });
}

/**
 * Produce a persisted-ready, schema-valid {@link EvidenceBundle} from a typed
 * {@link CapturePlan}. The bundle is validated against the shared schema before
 * being returned so downstream rubric scoring is reproducible.
 */
export function produceEvidenceBundle(plan: CapturePlan, opts: ProduceEvidenceOptions = {}): EvidenceBundle {
  const bundle: EvidenceBundle = {
    schema_version: SCHEMA_VERSION,
    kind: "evidence_bundle",
    id: opts.id ?? newId("EVID"),
    screenshots: [...plan.screenshots],
    viewport: {
      width: plan.viewport.width,
      height: plan.viewport.height,
      ...(plan.viewport.device_scale_factor !== undefined
        ? { device_scale_factor: plan.viewport.device_scale_factor }
        : {}),
    },
  };
  if (plan.route !== undefined) bundle.route = plan.route;
  const state = viewportState(plan);
  if (state !== undefined) bundle.state = state;
  if (plan.video !== undefined) bundle.video = plan.video;
  if (plan.dom !== undefined) bundle.dom = plan.dom;
  if (plan.accessibility_tree !== undefined) bundle.accessibility_tree = plan.accessibility_tree;
  if (plan.bounds !== undefined) bundle.bounds = { ...plan.bounds };
  if (plan.computed_styles !== undefined) bundle.computed_styles = { ...plan.computed_styles };
  if (plan.console !== undefined) bundle.console = plan.console.map((e) => ({ ...e }));
  if (plan.network !== undefined) bundle.network = plan.network.map((e) => ({ ...e }));
  if (plan.performance !== undefined) bundle.performance = { ...plan.performance };
  if (plan.interaction_traces !== undefined) bundle.interaction_traces = plan.interaction_traces.map((e) => ({ ...e }));
  if (plan.source_mapping !== undefined) bundle.source_mapping = plan.source_mapping.map((e) => ({ ...e }));
  if (plan.commit !== undefined) bundle.commit = plan.commit;
  if (plan.worktree !== undefined) bundle.worktree = plan.worktree;
  if (!validateRecord("evidence_bundle", bundle)) {
    throw new Error(`produceEvidenceBundle produced a bundle that fails ${"evidence_bundle"} schema validation`);
  }
  return bundle;
}

/** Validate a bundle against the shared evidence_bundle schema. */
export function validateEvidenceBundle(bundle: EvidenceBundle): boolean {
  return validateRecord("evidence_bundle", bundle);
}

/**
 * Typed result of one deterministic analyzer, consumable by the rubric engine
 * (`scoreRecord` from src/uieng/rubric.ts).
 */
export interface AnalysisResult {
  /** Rubric metric id (must be known to the rubric registry). */
  metricId: string;
  /** 0..100 score. */
  score: number;
  /** 0..1 confidence. */
  confidence: number;
  /** Evidence/artifact refs supporting the score. */
  evidence: string[];
  /** Human-readable deterministic detail summary. */
  details: string;
}

const clampScore = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));
const pct = (pass: number, total: number): number => (total === 0 ? 100 : clampScore((pass / total) * 100));

/** Structured axe-style accessibility violation. */
export interface A11yViolation {
  id: string;
  impact?: string;
  nodes?: number;
  description?: string;
}

const IMPACT_PENALTY: Record<string, number> = { critical: 30, serious: 20, moderate: 10, minor: 5 };

/** Deterministic analyzer: accessibility violations -> semantic_accessibility. */
export function analyzeAccessibilityViolations(
  violations: A11yViolation[],
  opts: { evidence?: string[] } = {},
): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (violations.length === 0) {
    return {
      metricId: "semantic_accessibility",
      score: 100,
      confidence: 0.9,
      evidence,
      details: "No accessibility violations found.",
    };
  }
  let score = 100;
  const byImpact: Record<string, number> = {};
  for (const v of violations) {
    const impact = v.impact ?? "unknown";
    score -= IMPACT_PENALTY[impact] ?? 15;
    byImpact[impact] = (byImpact[impact] ?? 0) + 1;
  }
  const summary = Object.entries(byImpact)
    .map(([impact, count]) => `${impact}=${count}`)
    .join(", ");
  return {
    metricId: "semantic_accessibility",
    score: clampScore(score),
    confidence: 0.9,
    evidence,
    details: `${violations.length} accessibility violation(s); impacts: ${summary}`,
  };
}

/** Structured computed foreground/background contrast pair. */
export interface ContrastCheck {
  element?: string;
  foreground?: string;
  background?: string;
  /** Measured WCAG contrast ratio. */
  ratio: number;
  /** Required ratio (4.5 normal text, 3 large text/UI). */
  required?: number;
}

/** Deterministic analyzer: contrast ratios -> contrast. */
export function analyzeContrastRatios(checks: ContrastCheck[], opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (checks.length === 0) {
    return { metricId: "contrast", score: 100, confidence: 0.5, evidence, details: "No contrast samples captured." };
  }
  let passed = 0;
  const failures: string[] = [];
  for (const c of checks) {
    const required = c.required ?? 4.5;
    if (c.ratio >= required) passed++;
    else failures.push(`${c.element ?? "element"}: ${c.ratio.toFixed(2)} < ${required}`);
  }
  return {
    metricId: "contrast",
    score: pct(passed, checks.length),
    confidence: 0.9,
    evidence,
    details: `${passed}/${checks.length} contrast pairs pass WCAG; failures: ${failures.join("; ") || "none"}`,
  };
}

/** WCAG 2.5.8 minimum touch target (CSS px). */
export const MIN_TOUCH_TARGET = 24;
/** Recommended touch target size. */
export const RECOMMENDED_TOUCH_TARGET = 44;

export interface TouchTarget {
  selector?: string;
  width: number;
  height: number;
}

/** Deterministic analyzer: touch-target sizes -> touch_targets. */
export function analyzeTouchTargets(targets: TouchTarget[], opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (targets.length === 0) {
    return { metricId: "touch_targets", score: 100, confidence: 0.5, evidence, details: "No touch targets captured." };
  }
  let passed = 0;
  const failures: string[] = [];
  for (const t of targets) {
    if (t.width >= MIN_TOUCH_TARGET && t.height >= MIN_TOUCH_TARGET) passed++;
    else failures.push(`${t.selector ?? "element"}: ${t.width}x${t.height}`);
  }
  return {
    metricId: "touch_targets",
    score: pct(passed, targets.length),
    confidence: 0.9,
    evidence,
    details: `${passed}/${targets.length} targets >= ${MIN_TOUCH_TARGET}px; undersized: ${failures.join("; ") || "none"}`,
  };
}

export interface OverflowRecord {
  selector?: string;
  axis?: "x" | "y";
  /** Amount of overflow in px. */
  overflow: number;
}

/** Deterministic analyzer: overflow detection -> responsive_implementation. */
export function analyzeOverflow(overflows: OverflowRecord[], opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (overflows.length === 0) {
    return {
      metricId: "responsive_implementation",
      score: 100,
      confidence: 0.85,
      evidence,
      details: "No overflow detected.",
    };
  }
  const score = clampScore(100 - overflows.length * 20);
  return {
    metricId: "responsive_implementation",
    score,
    confidence: 0.85,
    evidence,
    details: `${overflows.length} element(s) overflow their box/viewport.`,
  };
}

export interface BreakpointFailure {
  breakpoint: string;
  viewport_width: number;
  issue: string;
}

/** Deterministic analyzer: breakpoint failures -> responsive_implementation. */
export function analyzeBreakpoints(failures: BreakpointFailure[], opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (failures.length === 0) {
    return {
      metricId: "responsive_implementation",
      score: 100,
      confidence: 0.85,
      evidence,
      details: "No breakpoint failures.",
    };
  }
  const score = clampScore(100 - failures.length * 25);
  const list = failures.map((f) => `${f.breakpoint}@${f.viewport_width}px`).join("; ");
  return {
    metricId: "responsive_implementation",
    score,
    confidence: 0.85,
    evidence,
    details: `${failures.length} breakpoint failure(s): ${list}`,
  };
}

export interface TokenViolation {
  property?: string;
  value?: string;
  element?: string;
}

/** Deterministic analyzer: design-token violations -> design_token_adherence. */
export function analyzeDesignTokenAdherence(
  violations: TokenViolation[],
  opts: { evidence?: string[] } = {},
): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (violations.length === 0) {
    return {
      metricId: "design_token_adherence",
      score: 100,
      confidence: 0.9,
      evidence,
      details: "No raw-value violations; token usage consistent.",
    };
  }
  const score = clampScore(100 - violations.length * 10);
  return {
    metricId: "design_token_adherence",
    score,
    confidence: 0.9,
    evidence,
    details: `${violations.length} hard-coded style value(s) bypass design tokens.`,
  };
}

export interface DesignEntropyInput {
  totalStyles: number;
  oneOffs: number;
}

/** Deterministic analyzer: design entropy -> design_entropy. */
export function analyzeDesignEntropy(input: DesignEntropyInput, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (input.totalStyles <= 0) {
    return { metricId: "design_entropy", score: 100, confidence: 0.5, evidence, details: "No styles to assess." };
  }
  const ratio = Math.min(1, input.oneOffs / input.totalStyles);
  return {
    metricId: "design_entropy",
    score: clampScore(100 * (1 - ratio)),
    confidence: 0.8,
    evidence,
    details: `${input.oneOffs}/${input.totalStyles} styles are one-off/divergent.`,
  };
}

export interface DuplicateRecord {
  signature?: string;
  occurrences: number;
  location?: string;
}

export interface DuplicationInput {
  /** Total declarations / blocks examined. */
  declarations: number;
  duplicates: DuplicateRecord[];
}

function duplicationAnalyzer(
  input: DuplicationInput,
  metricId: "style_duplication" | "code_duplication",
  label: string,
  opts: { evidence?: string[] },
): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  const extra = input.duplicates.reduce((sum, d) => sum + Math.max(0, d.occurrences - 1), 0);
  const base = Math.max(input.declarations, 1);
  const ratio = Math.min(1, extra / base);
  return {
    metricId,
    score: clampScore(100 * (1 - ratio)),
    confidence: 0.85,
    evidence,
    details: `${extra} duplicate ${label} across ${input.duplicates.length} repeated pattern(s).`,
  };
}

/** Deterministic analyzer: duplicated styles -> style_duplication. */
export function analyzeStyleDuplication(input: DuplicationInput, opts: { evidence?: string[] } = {}): AnalysisResult {
  return duplicationAnalyzer(input, "style_duplication", "style declarations", opts);
}

/** Deterministic analyzer: duplicated UI logic/code -> code_duplication. */
export function analyzeCodeDuplication(input: DuplicationInput, opts: { evidence?: string[] } = {}): AnalysisResult {
  return duplicationAnalyzer(input, "code_duplication", "UI logic blocks", opts);
}

export interface ComponentReuseInput {
  component_instances: number;
  distinct_components: number;
}

/** Deterministic analyzer: component reuse -> component_reuse. */
export function analyzeComponentReuse(input: ComponentReuseInput, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (input.component_instances <= 0) {
    return {
      metricId: "component_reuse",
      score: 100,
      confidence: 0.5,
      evidence,
      details: "No component instances captured.",
    };
  }
  const reuse = 1 - input.distinct_components / input.component_instances;
  return {
    metricId: "component_reuse",
    score: clampScore(100 * reuse),
    confidence: 0.85,
    evidence,
    details: `${input.distinct_components} distinct component(s) across ${input.component_instances} instance(s).`,
  };
}

export interface DomDepthInfo {
  maxDepth: number;
  nodeCount: number;
  wrapperCount?: number;
}

/** Deterministic analyzer: DOM depth -> dom_complexity. */
export function analyzeDomDepth(info: DomDepthInfo, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  const { maxDepth } = info;
  let score: number;
  if (maxDepth <= 10) score = 100;
  else if (maxDepth <= 20) score = 75;
  else if (maxDepth <= 30) score = 50;
  else if (maxDepth <= 45) score = 25;
  else score = 0;
  return {
    metricId: "dom_complexity",
    score,
    confidence: 0.85,
    evidence,
    details: `max DOM depth ${maxDepth}; ${info.nodeCount} nodes; ${info.wrapperCount ?? 0} wrapper(s).`,
  };
}

export interface DeadStyleRecord {
  selector?: string;
  location?: string;
}

export interface DeadStyleInput {
  total: number;
  dead: DeadStyleRecord[];
}

/** Deterministic analyzer: dead styles -> dead_ui_code_styles. */
export function analyzeDeadStyles(input: DeadStyleInput, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (input.total <= 0) {
    return { metricId: "dead_ui_code_styles", score: 100, confidence: 0.5, evidence, details: "No styles to analyze." };
  }
  const ratio = Math.min(1, input.dead.length / input.total);
  return {
    metricId: "dead_ui_code_styles",
    score: clampScore(100 * (1 - ratio)),
    confidence: 0.8,
    evidence,
    details: `${input.dead.length}/${input.total} styles unreferenced.`,
  };
}

export interface FocusIssue {
  selector?: string;
  issue: string;
}

/** Deterministic analyzer: keyboard/focus -> semantic_accessibility. */
export function analyzeKeyboardFocus(issues: FocusIssue[], opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (issues.length === 0) {
    return {
      metricId: "semantic_accessibility",
      score: 100,
      confidence: 0.85,
      evidence,
      details: "No keyboard/focus issues detected.",
    };
  }
  const score = clampScore(100 - issues.length * 20);
  return {
    metricId: "semantic_accessibility",
    score,
    confidence: 0.85,
    evidence,
    details: `${issues.length} focus/keyboard issue(s).`,
  };
}

export interface RefreshDeepLinkFailure {
  url?: string;
  issue: string;
}

/** Deterministic analyzer: refresh/deep-link robustness. */
export function analyzeRefreshDeepLink(
  failures: RefreshDeepLinkFailure[],
  opts: { evidence?: string[] } = {},
): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (failures.length === 0) {
    return {
      metricId: "refresh_deep_link_robustness",
      score: 100,
      confidence: 0.7,
      evidence,
      details: "Refresh and deep links restore state.",
    };
  }
  const score = clampScore(100 - failures.length * 30);
  const list = failures.map((f) => `${f.url ?? "route"}: ${f.issue}`).join("; ");
  return {
    metricId: "refresh_deep_link_robustness",
    score,
    confidence: 0.7,
    evidence,
    details: `${failures.length} refresh/deep-link failure(s): ${list}`,
  };
}

export interface BundlePerf {
  totalBytes?: number;
  transferBytes?: number;
}

/** Deterministic analyzer: bundle/asset weight -> asset_weight. */
export function analyzeAssetWeight(input: BundlePerf, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  const bytes = input.transferBytes ?? input.totalBytes;
  if (bytes === undefined) {
    return {
      metricId: "asset_weight",
      score: 100,
      confidence: 0.4,
      evidence,
      details: "No network/bundle size captured.",
    };
  }
  const kb = bytes / 1024;
  let score: number;
  if (kb <= 200) score = 100;
  else if (kb <= 500) score = 75;
  else if (kb <= 1000) score = 50;
  else if (kb <= 3000) score = 25;
  else score = 0;
  return { metricId: "asset_weight", score, confidence: 0.8, evidence, details: `${Math.round(kb)} KB transferred.` };
}

export interface RenderPerf {
  renderMs: number;
}

/** Deterministic analyzer: render/performance cost -> render_performance_cost. */
export function analyzeRenderPerformance(input: RenderPerf, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  const { renderMs } = input;
  let score: number;
  if (renderMs <= 16) score = 100;
  else if (renderMs <= 50) score = 75;
  else if (renderMs <= 100) score = 50;
  else if (renderMs <= 250) score = 25;
  else score = 0;
  return {
    metricId: "render_performance_cost",
    score,
    confidence: 0.8,
    evidence,
    details: `render cost ${renderMs}ms.`,
  };
}

/** Deterministic analyzer: layout-shift trace (CLS) -> layout_stability. */
export function analyzeLayoutStability(cls: number, opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  let score: number;
  if (cls <= 0.001) score = 100;
  else if (cls <= 0.1) score = 75;
  else if (cls <= 0.25) score = 50;
  else if (cls <= 0.5) score = 25;
  else score = 0;
  return {
    metricId: "layout_stability",
    score,
    confidence: 0.85,
    evidence,
    details: `cumulative layout shift ${cls.toFixed(3)}.`,
  };
}

export interface RuntimeError {
  source?: "console" | "network";
  message?: string;
  status?: number;
  url?: string;
}

/** Deterministic analyzer: console/network runtime errors -> slow_error_network. */
export function analyzeRuntimeErrors(errors: RuntimeError[], opts: { evidence?: string[] } = {}): AnalysisResult {
  const evidence = [...(opts.evidence ?? [])];
  if (errors.length === 0) {
    return {
      metricId: "slow_error_network",
      score: 100,
      confidence: 0.8,
      evidence,
      details: "No console/network errors captured.",
    };
  }
  let score = 100;
  for (const e of errors) score -= e.source === "network" ? 25 : 20;
  const network = errors.filter((e) => e.source === "network").length;
  return {
    metricId: "slow_error_network",
    score: clampScore(score),
    confidence: 0.8,
    evidence,
    details: `${errors.length} runtime error(s): console=${errors.length - network}, network=${network}.`,
  };
}

/**
 * Structured snapshot of all deterministic capture inputs. Passing a snapshot
 * to {@link analyzeCapture} runs every analyzer that has data and returns their
 * {@link AnalysisResult}s.
 */
export interface CaptureSnapshot {
  a11yViolations?: A11yViolation[];
  contrastChecks?: ContrastCheck[];
  touchTargets?: TouchTarget[];
  overflows?: OverflowRecord[];
  breakpointFailures?: BreakpointFailure[];
  tokenViolations?: TokenViolation[];
  designEntropy?: DesignEntropyInput;
  styleDuplicates?: DuplicationInput;
  codeDuplicates?: DuplicationInput;
  componentReuse?: ComponentReuseInput;
  domInfo?: DomDepthInfo;
  deadStyles?: DeadStyleInput;
  focusIssues?: FocusIssue[];
  refreshFailures?: RefreshDeepLinkFailure[];
  assetWeight?: BundlePerf;
  render?: RenderPerf;
  cls?: number;
  runtimeErrors?: RuntimeError[];
}

/** Run every deterministic analyzer that has data in the snapshot. */
export function analyzeCapture(snapshot: CaptureSnapshot, opts: { evidence?: string[] } = {}): AnalysisResult[] {
  const results: AnalysisResult[] = [];
  if (snapshot.a11yViolations) results.push(analyzeAccessibilityViolations(snapshot.a11yViolations, opts));
  if (snapshot.contrastChecks) results.push(analyzeContrastRatios(snapshot.contrastChecks, opts));
  if (snapshot.touchTargets) results.push(analyzeTouchTargets(snapshot.touchTargets, opts));
  if (snapshot.overflows) results.push(analyzeOverflow(snapshot.overflows, opts));
  if (snapshot.breakpointFailures) results.push(analyzeBreakpoints(snapshot.breakpointFailures, opts));
  if (snapshot.tokenViolations) results.push(analyzeDesignTokenAdherence(snapshot.tokenViolations, opts));
  if (snapshot.designEntropy) results.push(analyzeDesignEntropy(snapshot.designEntropy, opts));
  if (snapshot.styleDuplicates) results.push(analyzeStyleDuplication(snapshot.styleDuplicates, opts));
  if (snapshot.codeDuplicates) results.push(analyzeCodeDuplication(snapshot.codeDuplicates, opts));
  if (snapshot.componentReuse) results.push(analyzeComponentReuse(snapshot.componentReuse, opts));
  if (snapshot.domInfo) results.push(analyzeDomDepth(snapshot.domInfo, opts));
  if (snapshot.deadStyles) results.push(analyzeDeadStyles(snapshot.deadStyles, opts));
  if (snapshot.focusIssues) results.push(analyzeKeyboardFocus(snapshot.focusIssues, opts));
  if (snapshot.refreshFailures) results.push(analyzeRefreshDeepLink(snapshot.refreshFailures, opts));
  if (snapshot.assetWeight) results.push(analyzeAssetWeight(snapshot.assetWeight, opts));
  if (snapshot.render) results.push(analyzeRenderPerformance(snapshot.render, opts));
  if (snapshot.cls !== undefined) results.push(analyzeLayoutStability(snapshot.cls, opts));
  if (snapshot.runtimeErrors) results.push(analyzeRuntimeErrors(snapshot.runtimeErrors, opts));
  return results;
}

/**
 * Consume a deterministic {@link AnalysisResult} into the rubric engine,
 * producing a typed, persisted-ready {@link MetricScore}. Throws on unknown
 * metric ids.
 */
export function toMetricScore(result: AnalysisResult, notes?: string): MetricScore {
  return scoreRecord(result.metricId, {
    score: result.score,
    confidence: result.confidence,
    evidence: result.evidence,
    notes: notes ?? result.details,
  });
}

/** Score a set of deterministic analysis results into rubric {@link MetricScore}s. */
export function scoreAnalysis(results: readonly AnalysisResult[], notes?: string): MetricScore[] {
  return results.map((r) => toMetricScore(r, notes));
}
