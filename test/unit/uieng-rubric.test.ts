import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateScores,
  assertMetricKnown,
  METRICS,
  METRIC_IDS,
  METRICS_BY_ID,
  RUBRIC_REGISTRY,
  RUBRIC_VERSION,
  scoreAll,
  scoreRecord,
  validateMetricIds,
  type MetricScore,
} from "../../src/uieng/rubric.ts";
import type { EvidenceBundle, Finding } from "../../src/uieng/schemas.ts";

describe("uieng 60-metric versioned rubric", () => {
  it("exposes exactly 60 separately-retained metrics with unique, known ids", () => {
    assert.equal(METRICS.length, 60);
    assert.equal(METRIC_IDS.length, 60);
    assert.equal(new Set(METRIC_IDS).size, 60, "metric ids must be unique");
    assert.equal(METRICS_BY_ID.size, 60);
    assert.equal(RUBRIC_REGISTRY.metric_count, 60);
    assert.equal(RUBRIC_REGISTRY.version, RUBRIC_VERSION);
  });

  it("every metric is a fully-typed entry with all required fields", () => {
    for (const m of METRICS) {
      assert.equal(typeof m.id, "string");
      assert.equal(typeof m.name, "string");
      assert.ok(["deterministic", "model", "task"].includes(m.source), `${m.id} source invalid`);
      assert.equal(typeof m.evidence, "string");
      for (const anchor of [0, 25, 50, 75, 100]) {
        assert.equal(typeof m.anchors[anchor as keyof typeof m.anchors], "string", `${m.id} anchor ${anchor}`);
      }
      assert.ok(m.confidence >= 0 && m.confidence <= 1, `${m.id} confidence`);
      assert.ok(
        ["info", "low", "medium", "high", "critical"].includes(m.severity),
        `${m.id} severity invalid`,
      );
      assert.equal(typeof m.applicability, "string");
      assert.equal(typeof m.verification, "string");
    }
  });

  it("covers all 60 named metrics", () => {
    const expected = [
      "visual_hierarchy", "alignment", "composition", "whitespace", "density",
      "typography_hierarchy", "typography_consistency", "color_consistency", "contrast", "icon_consistency",
      "affordance", "discoverability", "navigation_clarity", "task_efficiency", "cognitive_load",
      "feedback_state_visibility", "error_prevention", "error_recovery", "empty_states", "loading_states",
      "terminology_consistency", "progressive_disclosure", "information_grouping", "information_pixel_value",
      "mobile_reflow", "tablet_reflow", "desktop_layout", "ultrawide_behavior", "orientation", "zoom_reflow",
      "touch_targets", "keyboard_navigation", "focus_management", "semantic_accessibility", "labels",
      "reduced_motion", "component_reuse", "component_api_consistency", "component_complexity",
      "design_token_adherence", "design_entropy", "style_duplication", "code_duplication",
      "dead_ui_code_styles", "dom_complexity", "dependency_complexity", "responsive_implementation",
      "interaction_latency", "layout_stability", "render_performance_cost", "asset_weight",
      "refresh_deep_link_robustness", "back_forward", "repeated_click_double_submit", "slow_error_network",
      "long_content_resilience", "large_dataset_resilience", "modal_drawer_stacking",
      "cross_screen_semantic_consistency", "critical_task_completion",
    ];
    assert.equal(expected.length, 60);
    assert.deepEqual(new Set(METRIC_IDS), new Set(expected));
  });

  it("validateMetricIds rejects unknown and duplicate ids", () => {
    assert.doesNotThrow(() => validateMetricIds(METRIC_IDS));
    assert.throws(() => validateMetricIds(["visual_hierarchy", "nope"]), /Unknown metric id "nope"/);
    assert.throws(() => validateMetricIds(["alignment", "alignment"]), /Duplicate metric id "alignment"/);
  });

  it("assertMetricKnown returns the definition and throws for unknown ids", () => {
    assert.equal(assertMetricKnown("contrast").name, "Contrast");
    assert.throws(() => assertMetricKnown("bogus"), /Unknown metric id "bogus"/);
  });

  it("scoreRecord produces a persisted-ready, typed MetricScore", () => {
    const rec = scoreRecord("contrast", { score: 80, evidence: ["EVID-1"], notes: "passes AA" });
    assert.equal(rec.schema_version, RUBRIC_VERSION);
    assert.equal(rec.metric_id, "contrast");
    assert.equal(rec.metric_name, "Contrast");
    assert.equal(rec.source, "deterministic");
    assert.equal(rec.score, 80);
    assert.equal(rec.confidence, 0.95); // default from metric
    assert.equal(rec.severity, "high");
    assert.deepEqual(rec.evidence, ["EVID-1"]);
    assert.equal(rec.notes, "passes AA");
    assert.ok(rec.recorded_at);
    assert.ok(rec.id.startsWith("MSC-"));
  });

  it("scoreRecord clamps score/confidence and honors overrides", () => {
    const rec = scoreRecord("contrast", { score: 120, confidence: 2 });
    assert.equal(rec.score, 100);
    assert.equal(rec.confidence, 1);
    const low = scoreRecord("contrast", { score: -5, confidence: -1 });
    assert.equal(low.score, 0);
    assert.equal(low.confidence, 0);
    assert.throws(() => scoreRecord("contrast", { score: NaN }), /Invalid score/);
  });

  it("scoreRecord rejects unknown metric ids", () => {
    assert.throws(() => scoreRecord("bogus", { score: 50 }), /Unknown metric id "bogus"/);
  });

  it("scoreRecord can link shared Finding and EvidenceBundle schema types", () => {
    const finding: Finding = {
      schema_version: 1,
      kind: "finding",
      id: "FIND-1",
      score: 0.8,
      confidence: 0.9,
      severity: "high",
      evidence: ["EVID-1"],
      rubric: "02-rubric",
    };
    const bundle: EvidenceBundle = {
      schema_version: 1,
      kind: "evidence_bundle",
      id: "EVID-1",
      screenshots: ["artifact://shots/main.png"],
    };
    const rec = scoreRecord("contrast", { score: 80, finding, evidence_bundle: bundle });
    assert.equal(rec.finding?.id, "FIND-1");
    assert.equal(rec.evidence_bundle?.kind, "evidence_bundle");
  });

  it("scoreAll returns all 60 scores for an evaluation", () => {
    const inputs: Record<string, { score: number }> = {};
    for (const id of METRIC_IDS) inputs[id] = { score: 50 };
    const scores = scoreAll(inputs);
    assert.equal(scores.length, 60);
    assert.deepEqual(scores.map((s) => s.metric_id), METRIC_IDS);
    assert.ok(scores.every((s) => s.score === 50));
  });

  it("scoreAll rejects missing and unknown metric ids", () => {
    const inputs: Record<string, { score: number }> = {};
    for (const id of METRIC_IDS) inputs[id] = { score: 50 };
    const { visual_hierarchy, ...missing } = inputs;
    assert.throws(() => scoreAll(missing), /Expected 60 metric scores, got 59/);
    assert.throws(
      () => scoreAll({ ...inputs, extra: { score: 10 } }),
      /Unknown metric id "extra"/,
    );
  });

  it("aggregate is explicitly secondary and retains every individual score", () => {
    const scores: MetricScore[] = METRIC_IDS.map((id, i) => scoreRecord(id, { score: i * 2 }));
    const agg = aggregateScores(scores);
    assert.equal(agg.secondary, true);
    assert.equal(agg.scores.length, 60);
    assert.equal(agg.rubric_version, RUBRIC_VERSION);
    assert.equal(agg.mean_score, 59);
    assert.equal(agg.min_score, 0);
    assert.equal(agg.max_score, 100); // (59 * 2) = 118 clamped to 100
    assert.equal(agg.median_score, 60);
    assert.ok(agg.counts_by_source.deterministic > 0);
    assert.ok(agg.counts_by_source.model > 0);
    assert.ok(agg.counts_by_source.task > 0);
  });
});
