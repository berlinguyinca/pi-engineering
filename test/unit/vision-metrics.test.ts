import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VISION_METRIC_NAMES,
  VisionMetricsRegistry,
  alertThresholds,
  exportMetrics,
  shouldWarnFor,
} from "../../src/vision/metrics.ts";
import type { VisionMetricName } from "../../src/vision/metrics.ts";

test("VISION_METRIC_NAMES lists the full spec §45 union", () => {
  const expected: VisionMetricName[] = [
    "pi_vision_assets_total",
    "pi_vision_asset_original_bytes",
    "pi_vision_asset_derivative_bytes",
    "pi_vision_analysis_requests_total",
    "pi_vision_cache_hits_total",
    "pi_request_estimated_bytes",
    "pi_request_payload_utilization",
    "pi_http_413_total",
    "pi_http_413_recovered_total",
    "pi_context_compactions_total",
    "pi_context_compaction_byte_pressure_total",
  ];
  assert.deepEqual([...VISION_METRIC_NAMES].sort(), expected.sort());
});

test("inc defaults to +1 and supports explicit delta", () => {
  const r = new VisionMetricsRegistry();
  assert.equal(r.get("pi_vision_assets_total"), 0);
  r.inc("pi_vision_assets_total");
  r.inc("pi_vision_assets_total");
  assert.equal(r.get("pi_vision_assets_total"), 2);
  r.inc("pi_http_413_total", 3);
  assert.equal(r.get("pi_http_413_total"), 3);
  r.inc("pi_http_413_total", 2, { region: "us" });
  assert.equal(r.get("pi_http_413_total", { region: "us" }), 2);
  assert.equal(r.get("pi_http_413_total"), 3);
});

test("add adds to existing counter (default 0)", () => {
  const r = new VisionMetricsRegistry();
  r.add("pi_vision_cache_hits_total", 5);
  assert.equal(r.get("pi_vision_cache_hits_total"), 5);
  r.add("pi_vision_cache_hits_total", 2);
  assert.equal(r.get("pi_vision_cache_hits_total"), 7);
});

test("observe records the latest value", () => {
  const r = new VisionMetricsRegistry();
  r.observe("pi_request_payload_utilization", 0.6);
  assert.equal(r.get("pi_request_payload_utilization"), 0.6);
  r.observe("pi_request_payload_utilization", 0.9);
  assert.equal(r.get("pi_request_payload_utilization"), 0.9);
});

test("same name with different labels are independent counters", () => {
  const r = new VisionMetricsRegistry();
  r.inc("pi_http_413_total", { region: "us" });
  r.inc("pi_http_413_total", { region: "eu" });
  r.inc("pi_http_413_total", { region: "us" });
  assert.equal(r.get("pi_http_413_total", { region: "us" }), 2);
  assert.equal(r.get("pi_http_413_total", { region: "eu" }), 1);
  // label key is order-insensitive
  assert.equal(r.get("pi_http_413_total", { region: "us", env: "prod" }), 0);
});

test("snapshot returns all recorded samples", () => {
  const r = new VisionMetricsRegistry();
  r.inc("pi_vision_assets_total");
  r.observe("pi_request_payload_utilization", 0.7, { asset: "a" });
  const snap = r.snapshot();
  assert.equal(snap.length, 2);
  const names = snap.map((s) => s.name).sort();
  assert.deepEqual(names, ["pi_request_payload_utilization", "pi_vision_assets_total"]);
});

test("reset clears all samples", () => {
  const r = new VisionMetricsRegistry();
  r.inc("pi_vision_assets_total");
  r.reset();
  assert.equal(r.get("pi_vision_assets_total"), 0);
  assert.deepEqual(r.snapshot(), []);
});

test("exportMetrics renders sorted Prometheus-style lines with labels", () => {
  const r = new VisionMetricsRegistry();
  r.inc("pi_vision_assets_total");
  r.inc("pi_http_413_total", { region: "eu" });
  r.inc("pi_http_413_total", { region: "us" });
  const out = exportMetrics(r);
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, [
    'pi_http_413_total{region="eu"} 1',
    'pi_http_413_total{region="us"} 1',
    "pi_vision_assets_total 1",
  ]);
});

test("alertThresholds returns defaults and honors overrides", () => {
  assert.deepEqual(alertThresholds(), {
    warn413Rate: 0.05,
    warnPayloadUtilization: 0.8,
    warnRepeatedReanalysis: 3,
  });
  assert.deepEqual(alertThresholds({ warn413Rate: 0.1 }), {
    warn413Rate: 0.1,
    warnPayloadUtilization: 0.8,
    warnRepeatedReanalysis: 3,
  });
});

test("shouldWarnFor applies thresholds per metric", () => {
  // 413 rate
  assert.equal(shouldWarnFor("pi_http_413_total", 0.04), false);
  assert.equal(shouldWarnFor("pi_http_413_total", 0.051), true);
  assert.equal(shouldWarnFor("pi_http_413_total", 0.051, { warn413Rate: 0.2 }), false);
  // payload utilization
  assert.equal(shouldWarnFor("pi_request_payload_utilization", 0.79), false);
  assert.equal(shouldWarnFor("pi_request_payload_utilization", 0.81), true);
  // repeated reanalysis proxy
  assert.equal(shouldWarnFor("pi_vision_analysis_requests_total", 3), false);
  assert.equal(shouldWarnFor("pi_vision_analysis_requests_total", 4), true);
  assert.equal(shouldWarnFor("pi_vision_analysis_requests_total", 4, { warnRepeatedReanalysis: 5 }), false);
  // unrelated metrics never warn
  assert.equal(shouldWarnFor("pi_vision_cache_hits_total", 999), false);
  assert.equal(shouldWarnFor("pi_http_413_recovered_total", 999), false);
});
