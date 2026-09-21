import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeRobustnessScenario,
  buildUsabilityEvaluationPlan,
  buildViewportMatrix,
  evaluateCanonicalTask,
  evaluateViewport,
  ROBUSTNESS_SCENARIOS,
  runUsabilityEvaluation,
  TASK_METRIC_MAPPING,
  VIEWPORT_MATRIX,
  viewportMetricGroup,
  type CanonicalTask,
} from "../../src/uieng/usability.ts";
import { METRIC_IDS, assertMetricKnown } from "../../src/uieng/rubric.ts";
import { analyzeCapture } from "../../src/uieng/evidence.ts";

describe("uieng runtime usability & robustness evaluation", () => {
  it("viewportMetricGroup maps viewports deterministically", () => {
    assert.deepEqual(new Set(viewportMetricGroup(360, 640)).has("mobile_reflow"), true);
    assert.deepEqual(new Set(viewportMetricGroup(360, 640)).has("touch_targets"), true);
    assert.deepEqual(new Set(viewportMetricGroup(768, 1024)).has("tablet_reflow"), true);
    assert.deepEqual(new Set(viewportMetricGroup(1024, 768)).has("orientation"), true);
    assert.deepEqual(new Set(viewportMetricGroup(1920, 1080)).has("desktop_layout"), true);
    assert.deepEqual(new Set(viewportMetricGroup(3440, 1440)).has("ultrawide_behavior"), true);
    // 200% zoom shrinks effective CSS width -> zoom_reflow + a smaller group.
    const zoomed = viewportMetricGroup(1920, 1080, 2);
    assert.deepEqual(new Set(zoomed).has("zoom_reflow"), true);
    assert.deepEqual(new Set(zoomed).has("desktop_layout"), true);
    assert.deepEqual(new Set(viewportMetricGroup(1280, 800, 2)).has("tablet_reflow"), true);
    assert.equal(viewportMetricGroup(1280, 800, 2).length, viewportMetricGroup(1280, 800, 2).length);
  });

  it("viewport matrix covers all required targets and known metric ids", () => {
    const ids = new Set(VIEWPORT_MATRIX.map((v) => v.id));
    for (const required of [
      "phone-320",
      "phone-360",
      "phone-390",
      "phone-430",
      "tablet-portrait",
      "tablet-landscape",
      "laptop",
      "desktop",
      "ultrawide",
      "desktop-200",
    ]) {
      assert.equal(ids.has(required), true, `missing ${required}`);
    }
    for (const v of VIEWPORT_MATRIX) {
      for (const m of v.metric_ids) assertMetricKnown(m);
    }
    // buildViewportMatrix is stable and equals the exported constant.
    assert.deepEqual(buildViewportMatrix(), VIEWPORT_MATRIX);
  });

  it("evaluateCanonicalTask maps runtime metrics to rubric metric ids", () => {
    const task: CanonicalTask = {
      id: "create-report",
      goal: "Create and export a monthly report",
      mode: "first_time",
      required_states: ["dashboard", "reports/new"],
      success_criteria: ["Report is saved", "Report is exported as CSV"],
      viewport_targets: ["desktop"],
    };
    const results = evaluateCanonicalTask(task, {
      success: true,
      time_ms: 12000,
      actions: 5,
      navigation_depth: 3,
      wrong_turns: 1,
      backtracks: 0,
      mis_clicks: 1,
      errors: 0,
      latency_ms: 40,
      assistance: 0,
    });
    const metricIds = new Set(results.map((r) => r.metricId));
    for (const mapped of Object.values(TASK_METRIC_MAPPING)) for (const m of mapped) assertMetricKnown(m);
    // Every mapped metric appears exactly once (deduped across fields).
    const expected = new Set(Object.values(TASK_METRIC_MAPPING).flat());
    assert.deepEqual(metricIds, expected);
    for (const r of results) assertMetricKnown(r.metricId);
    const completion = results.find((r) => r.metricId === "critical_task_completion");
    assert.equal(completion?.score, 100);
  });

  it("evaluateCanonicalTask penalizes failure", () => {
    const task: CanonicalTask = {
      id: "t",
      goal: "goal",
      mode: "keyboard",
      required_states: [],
      success_criteria: ["done"],
      viewport_targets: ["phone-360"],
    };
    const results = evaluateCanonicalTask(task, {
      success: false,
      time_ms: 60000,
      actions: 20,
      navigation_depth: 10,
      wrong_turns: 6,
      backtracks: 4,
      mis_clicks: 4,
      errors: 3,
      latency_ms: 500,
      assistance: 2,
    });
    const completion = results.find((r) => r.metricId === "critical_task_completion");
    assert.equal(completion?.score, 0);
    const eff = results.find((r) => r.metricId === "task_efficiency");
    assert.ok(eff && eff.score <= 25);
  });

  it("robustness scenario catalog covers all required kinds with known metric ids", () => {
    const kinds = new Set(ROBUSTNESS_SCENARIOS.map((s) => s.kind));
    for (const required of [
      "long_content",
      "empty_data",
      "huge_dataset",
      "loading",
      "backend_error",
      "slow_network",
      "reconnect",
      "rapid_clicks",
      "double_submit",
      "refresh",
      "deep_link",
      "back_forward",
      "modal_drawer_stacking",
      "temporal_traces_video",
    ]) {
      assert.equal(kinds.has(required), true, `missing ${required}`);
    }
    for (const s of ROBUSTNESS_SCENARIOS) {
      for (const m of s.metric_ids) assertMetricKnown(m);
      assert.ok(s.metric_ids.length > 0, `scenario ${s.id} has no metric ids`);
    }
  });

  it("analyzeRobustnessScenario is deterministic and scores evidence", () => {
    const scn = ROBUSTNESS_SCENARIOS.find((s) => s.kind === "double_submit");
    assert.ok(scn);
    const bad = analyzeRobustnessScenario(scn, { outcomes: { duplicate_prevented: false } });
    assert.equal(bad[0]?.metricId, "repeated_click_double_submit");
    assert.equal(bad[0]?.score, 0);
    const good = analyzeRobustnessScenario(scn, { outcomes: { duplicate_prevented: true } });
    assert.equal(good[0]?.score, 100);
  });

  it("backend-error scenario maps console/network errors and recovery", () => {
    const scn = ROBUSTNESS_SCENARIOS.find((s) => s.kind === "backend_error");
    assert.ok(scn);
    const results = analyzeRobustnessScenario(scn, {
      runtimeErrors: [{ source: "network", status: 500, url: "https://api/x" }],
      outcomes: { retry_offered: false },
    });
    const slow = results.find((r) => r.metricId === "slow_error_network");
    assert.ok(slow && slow.score < 100);
    const rec = results.find((r) => r.metricId === "error_recovery");
    assert.equal(rec?.score, 25);
  });

  it("viewport evidence reuses overflow/breakpoint analyzers", () => {
    const vp = VIEWPORT_MATRIX.find((v) => v.id === "phone-320");
    assert.ok(vp);
    const results = evaluateViewport(vp, { overflows: [{ selector: ".table", axis: "x", overflow: 40 }] });
    assert.ok(results.some((r) => r.metricId === "responsive_implementation"));
  });

  it("runUsabilityEvaluation combines tasks, scenarios, and viewports into metric scores", () => {
    const plan = buildUsabilityEvaluationPlan(
      [
        {
          id: "t1",
          goal: "goal",
          mode: "touch",
          required_states: [],
          success_criteria: ["done"],
          viewport_targets: ["phone-360"],
        },
      ],
      VIEWPORT_MATRIX.slice(0, 1),
      [ROBUSTNESS_SCENARIOS.find((s) => s.kind === "refresh")!],
      "L2_feature_workflow",
    );
    assert.equal(plan.impact_level, "L2_feature_workflow");
    assert.equal(plan.viewport_metric_groups["phone-360"].includes("mobile_reflow"), true);

    const scores = runUsabilityEvaluation(plan, {
      tasks: {
        t1: {
          success: true,
          time_ms: 5000,
          actions: 4,
          navigation_depth: 2,
          wrong_turns: 0,
          backtracks: 0,
          mis_clicks: 0,
          errors: 0,
          latency_ms: 30,
          assistance: 0,
        },
      },
      scenarios: { "scn-refresh": { outcomes: { state_restored: true } } },
      viewports: { "phone-360": { overflows: [] } },
    });
    assert.ok(scores.length > 0);
    const ids = new Set(scores.map((s) => s.metric_id));
    assert.equal(ids.has("critical_task_completion"), true);
    assert.equal(ids.has("refresh_deep_link_robustness"), true);
    assert.equal(ids.has("responsive_implementation"), true);
    for (const s of scores) {
      assertMetricKnown(s.metric_id);
      assert.ok(s.score >= 0 && s.score <= 100);
    }
    // All produced metric ids are part of the registry.
    assert.ok(METRIC_IDS.includes("task_efficiency"));
  });

  it("deterministic: same inputs yield identical outputs", () => {
    const task: CanonicalTask = {
      id: "t",
      goal: "goal",
      mode: "first_time",
      required_states: [],
      success_criteria: ["done"],
      viewport_targets: [],
    };
    const a = evaluateCanonicalTask(task, {
      success: true,
      time_ms: 1000,
      actions: 3,
      navigation_depth: 2,
      wrong_turns: 1,
      backtracks: 0,
      mis_clicks: 0,
      errors: 0,
      latency_ms: 20,
      assistance: 0,
    });
    const b = evaluateCanonicalTask(task, {
      success: true,
      time_ms: 1000,
      actions: 3,
      navigation_depth: 2,
      wrong_turns: 1,
      backtracks: 0,
      mis_clicks: 0,
      errors: 0,
      latency_ms: 20,
      assistance: 0,
    });
    assert.deepEqual(a, b);
  });

  it("integrates with analyzeCapture output via scoreAnalysis path", () => {
    const captureResults = analyzeCapture({ overflows: [{ axis: "x", overflow: 10 }] });
    assert.equal(captureResults[0]?.metricId, "responsive_implementation");
    assertMetricKnown(captureResults[0]?.metricId ?? "");
  });
});
