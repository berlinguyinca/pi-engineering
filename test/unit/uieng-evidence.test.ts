import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AnalysisResult,
  analyzeAccessibilityViolations,
  analyzeAssetWeight,
  analyzeBreakpoints,
  analyzeCapture,
  analyzeCodeDuplication,
  analyzeComponentReuse,
  analyzeContrastRatios,
  analyzeDeadStyles,
  analyzeDesignEntropy,
  analyzeDesignTokenAdherence,
  analyzeDomDepth,
  analyzeKeyboardFocus,
  analyzeLayoutStability,
  analyzeOverflow,
  analyzeRefreshDeepLink,
  analyzeRenderPerformance,
  analyzeRuntimeErrors,
  analyzeStyleDuplication,
  analyzeTouchTargets,
  produceEvidenceBundle,
  scoreAnalysis,
  toMetricScore,
  validateEvidenceBundle,
} from "../../src/uieng/evidence.ts";
import { METRIC_IDS, type MetricScore, assertMetricKnown } from "../../src/uieng/rubric.ts";
import { validateRecord } from "../../src/uieng/schemas.ts";

describe("uieng evidence capture + deterministic analyzers", () => {
  it("produceEvidenceBundle emits a schema-valid EvidenceBundle with all gathered fields", () => {
    const bundle = produceEvidenceBundle(
      {
        route: "/dashboard",
        state: "loaded",
        viewport: {
          width: 1280,
          height: 800,
          device_scale_factor: 2,
          zoom: 1,
          orientation: "landscape",
          device: "Desktop Chrome",
        },
        screenshots: ["artifact://shots/main.png", "artifact://shots/hover.png"],
        video: "artifact://video/run.webm",
        dom: "<html><body></body></html>",
        accessibility_tree: "root\n  main",
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        computed_styles: { ".btn": { color: "#fff" } },
        console: [{ level: "error", text: "boom" }],
        network: [{ url: "https://api/x", status: 404 }],
        performance: { cls: 0.02, lcp: 1200 },
        interaction_traces: [{ type: "click", target: ".btn" }],
        source_mapping: [{ component: "Button", file: "Button.tsx" }],
        commit: "abc123",
        worktree: "/tmp/wi",
      },
      { id: "EVID-1" },
    );
    assert.equal(bundle.schema_version, 1);
    assert.equal(bundle.kind, "evidence_bundle");
    assert.equal(bundle.id, "EVID-1");
    assert.equal(bundle.route, "/dashboard");
    assert.equal(bundle.viewport?.width, 1280);
    assert.equal(bundle.viewport?.device_scale_factor, 2);
    assert.equal(bundle.screenshots.length, 2);
    assert.equal(bundle.video, "artifact://video/run.webm");
    assert.equal(bundle.dom, "<html><body></body></html>");
    assert.equal(bundle.accessibility_tree, "root\n  main");
    assert.equal(bundle.bounds?.height, 800);
    assert.equal(bundle.console?.length, 1);
    assert.equal(bundle.network?.length, 1);
    assert.equal(bundle.performance?.cls, 0.02);
    assert.equal(bundle.interaction_traces?.length, 1);
    assert.equal(bundle.source_mapping?.length, 1);
    assert.equal(bundle.commit, "abc123");
    assert.equal(bundle.worktree, "/tmp/wi");
    // device/zoom/orientation folded into state so nothing is lost.
    assert.match(bundle.state ?? "", /"zoom":1/);
    assert.match(bundle.state ?? "", /"orientation":"landscape"/);
    assert.match(bundle.state ?? "", /"device":"Desktop Chrome"/);
    assert.equal(validateRecord("evidence_bundle", bundle), true);
    assert.equal(validateEvidenceBundle(bundle), true);
  });

  it("produceEvidenceBundle defaults id and screenshots and stays schema-valid for minimal plans", () => {
    const bundle = produceEvidenceBundle({
      viewport: { width: 375, height: 812 },
      screenshots: [],
    });
    assert.ok(bundle.id.startsWith("EVID-"));
    assert.deepEqual(bundle.screenshots, []);
    assert.equal(bundle.state, undefined);
    assert.equal(validateRecord("evidence_bundle", bundle), true);
  });

  it("analyzeAccessibilityViolations scores by impact", () => {
    const clean = analyzeAccessibilityViolations([]);
    assert.equal(clean.metricId, "semantic_accessibility");
    assert.equal(clean.score, 100);
    const bad = analyzeAccessibilityViolations([
      { id: "color-contrast", impact: "serious", nodes: 3 },
      { id: "aria-prohibited-attr", impact: "critical", nodes: 1 },
    ]);
    assert.equal(bad.score, 50); // 100 - 20 - 30
    assert.match(bad.details, /2 accessibility violation/);
  });

  it("analyzeContrastRatios passes/fails against required ratio", () => {
    const all = analyzeContrastRatios([
      { element: ".a", ratio: 5.2 },
      { element: ".b", ratio: 2.1 },
    ]);
    assert.equal(all.metricId, "contrast");
    assert.equal(all.score, 50);
    const custom = analyzeContrastRatios([{ element: ".lg", ratio: 3.5, required: 3 }]);
    assert.equal(custom.score, 100);
  });

  it("analyzeTouchTargets applies WCAG minimum size", () => {
    const res = analyzeTouchTargets([
      { selector: ".ok", width: 44, height: 44 },
      { selector: ".tiny", width: 16, height: 16 },
      { selector: ".min", width: 24, height: 24 },
    ]);
    assert.equal(res.metricId, "touch_targets");
    assert.equal(res.score, 67);
    assert.match(res.details, /undersized: \.tiny/);
  });

  it("analyzeOverflow and analyzeBreakpoints target responsive_implementation", () => {
    assert.equal(analyzeOverflow([]).score, 100);
    assert.equal(analyzeOverflow([{ selector: ".card", axis: "x", overflow: 40 }]).score, 80);
    assert.equal(analyzeBreakpoints([]).score, 100);
    assert.equal(analyzeBreakpoints([{ breakpoint: "sm", viewport_width: 640, issue: "table overflows" }]).score, 75);
  });

  it("design-token, entropy, duplication, and component-reuse analyzers are deterministic", () => {
    assert.equal(analyzeDesignTokenAdherence([{ property: "color", value: "#333" }]).score, 90);
    assert.equal(analyzeDesignEntropy({ totalStyles: 100, oneOffs: 25 }).score, 75);
    const dup = analyzeStyleDuplication({ declarations: 100, duplicates: [{ signature: "c1", occurrences: 10 }] });
    assert.equal(dup.metricId, "style_duplication");
    assert.equal(dup.score, 91);
    const code = analyzeCodeDuplication({ declarations: 50, duplicates: [{ signature: "helper", occurrences: 5 }] });
    assert.equal(code.metricId, "code_duplication");
    assert.equal(code.score, 92);
    const reuse = analyzeComponentReuse({ component_instances: 10, distinct_components: 2 });
    assert.equal(reuse.metricId, "component_reuse");
    assert.equal(reuse.score, 80);
  });

  it("DOM depth, dead styles, and keyboard/focus analyzers map to rubric metrics", () => {
    assert.equal(analyzeDomDepth({ maxDepth: 8, nodeCount: 50 }).score, 100);
    assert.equal(analyzeDomDepth({ maxDepth: 60, nodeCount: 500 }).score, 0);
    assert.equal(analyzeDeadStyles({ total: 100, dead: [{ selector: ".unused" }] }).score, 99);
    assert.equal(analyzeKeyboardFocus([]).score, 100);
    assert.equal(analyzeKeyboardFocus([{ selector: ".modal", issue: "not focusable" }]).score, 80);
  });

  it("refresh/deep-link, bundle/perf, layout-stability, and runtime-error analyzers map to rubric metrics", () => {
    assert.equal(analyzeRefreshDeepLink([]).score, 100);
    assert.equal(analyzeRefreshDeepLink([{ url: "/x", issue: "404 after refresh" }]).score, 70);
    assert.equal(analyzeAssetWeight({ transferBytes: 150 * 1024 }).score, 100);
    assert.equal(analyzeAssetWeight({ transferBytes: 4 * 1024 * 1024 }).score, 0);
    assert.equal(analyzeRenderPerformance({ renderMs: 10 }).score, 100);
    assert.equal(analyzeRenderPerformance({ renderMs: 300 }).score, 0);
    assert.equal(analyzeLayoutStability(0.001).score, 100);
    assert.equal(analyzeLayoutStability(0.6).score, 0);
    assert.equal(analyzeRuntimeErrors([]).score, 100);
    assert.equal(analyzeRuntimeErrors([{ source: "network", status: 500 }]).score, 75);
  });

  it("every analyzer emits a metricId known to the rubric registry", () => {
    const results = analyzeCapture({
      a11yViolations: [{ id: "x", impact: "serious" }],
      contrastChecks: [{ ratio: 2 }],
      touchTargets: [{ width: 10, height: 10 }],
      overflows: [{ selector: ".a", overflow: 5 }],
      breakpointFailures: [{ breakpoint: "md", viewport_width: 768, issue: "clip" }],
      tokenViolations: [{ property: "color" }],
      designEntropy: { totalStyles: 10, oneOffs: 1 },
      styleDuplicates: { declarations: 10, duplicates: [] },
      codeDuplicates: { declarations: 10, duplicates: [] },
      componentReuse: { component_instances: 5, distinct_components: 5 },
      domInfo: { maxDepth: 12, nodeCount: 30 },
      deadStyles: { total: 10, dead: [] },
      focusIssues: [{ selector: ".a", issue: "nofocus" }],
      refreshFailures: [{ issue: "x" }],
      assetWeight: { transferBytes: 100 },
      render: { renderMs: 20 },
      cls: 0.05,
      runtimeErrors: [{ source: "console", message: "e" }],
    });
    assert.ok(results.length >= 15, `expected many analyzers, got ${results.length}`);
    for (const r of results) assert.doesNotThrow(() => assertMetricKnown(r.metricId), r.metricId);
  });

  it("toMetricScore / scoreAnalysis consume AnalysisResults into rubric MetricScores", () => {
    const result: AnalysisResult = analyzeContrastRatios([{ ratio: 6 }], { evidence: ["EVID-1"] });
    const rec = toMetricScore(result, "custom note");
    assert.ok(rec instanceof Object);
    assert.equal((rec as MetricScore).metric_id, "contrast");
    assert.equal((rec as MetricScore).score, 100);
    assert.equal((rec as MetricScore).evidence[0], "EVID-1");
    assert.equal((rec as MetricScore).notes, "custom note");
    assert.ok((rec as MetricScore).id.startsWith("MSC-"));
    assert.ok(METRIC_IDS.includes((rec as MetricScore).metric_id));

    const scores = scoreAnalysis(analyzeCapture({ contrastChecks: [{ ratio: 4 }] }));
    assert.equal(scores.length, 1);
    assert.equal(scores[0]?.metric_id, "contrast");
  });

  it("toMetricScore rejects unknown metric ids", () => {
    assert.throws(
      () => toMetricScore({ metricId: "bogus", score: 50, confidence: 0.5, evidence: [], details: "x" }),
      /Unknown metric id/,
    );
  });
});
