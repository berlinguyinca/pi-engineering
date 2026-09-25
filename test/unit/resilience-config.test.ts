import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GATEWAY_RESILIENCE, resolveGatewayResilienceConfig } from "../../src/resilience/config.ts";

describe("resolveGatewayResilienceConfig", () => {
  it("uses the 12-hour time-based defaults (not attempt counts)", () => {
    // A model reload, GPU move or capacity outage can last hours.
    const cfg = resolveGatewayResilienceConfig({});
    assert.equal(cfg.retry_window_ms, 12 * 3_600_000);
    assert.equal(cfg.probe_interval_ms, 10_000);
    assert.equal(cfg.request_timeout_ms, 120_000);
    assert.equal(cfg.preserve_mission_on_exhaustion, true);
    assert.equal(cfg.auto_resume_on_recovery, true);
  });

  it("applies environment overrides", () => {
    const cfg = resolveGatewayResilienceConfig({
      PI_GATEWAY_RETRY_WINDOW: "45m",
      PI_GATEWAY_PROBE_INTERVAL: "5000",
      PI_GATEWAY_REQUEST_TIMEOUT: "60000",
      PI_GATEWAY_AUTO_RESUME: "0",
    });
    assert.equal(cfg.retry_window_ms, 45 * 60_000);
    assert.equal(cfg.probe_interval_ms, 5_000);
    assert.equal(cfg.request_timeout_ms, 60_000);
    assert.equal(cfg.auto_resume_on_recovery, false);
  });

  it("keeps defaults when env values are invalid", () => {
    const cfg = resolveGatewayResilienceConfig({
      PI_GATEWAY_RETRY_WINDOW: "not-a-duration",
      PI_GATEWAY_PROBE_INTERVAL: "-3",
    });
    assert.equal(cfg.retry_window_ms, DEFAULT_GATEWAY_RESILIENCE.retry_window_ms);
    assert.equal(cfg.probe_interval_ms, DEFAULT_GATEWAY_RESILIENCE.probe_interval_ms);
  });
});
