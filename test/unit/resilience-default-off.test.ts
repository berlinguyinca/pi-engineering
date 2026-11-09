import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_INFERENCE_RESILIENCE,
  resolveInferenceResilienceConfig,
} from "../../src/inference/resilienceConfig.ts";

// 05-IMPLEMENTATION-SECURITY.md:13 - "Feature flags default OFF for intervention".
describe("PI_INFERENCE_RESILIENCE_ENABLED", () => {
  it("is off with no environment at all", () => {
    assert.equal(DEFAULT_INFERENCE_RESILIENCE.enabled, false);
    assert.equal(resolveInferenceResilienceConfig({}).enabled, false);
  });

  it("arms only on an affirmative value, so a typo cannot arm intervention silently", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
      assert.equal(resolveInferenceResilienceConfig({ PI_INFERENCE_RESILIENCE_ENABLED: value }).enabled, true, value);
    }
    for (const value of ["", "  ", "false", "0", "off", "ture", "1x", "enabled"]) {
      assert.equal(resolveInferenceResilienceConfig({ PI_INFERENCE_RESILIENCE_ENABLED: value }).enabled, false, value);
    }
  });

  it("still lets a caller arm it programmatically, and leaves the other tunables alone", () => {
    assert.equal(resolveInferenceResilienceConfig({}, { enabled: true }).enabled, true);
    const cfg = resolveInferenceResilienceConfig({});
    assert.equal(cfg.streamRetryEnabled, DEFAULT_INFERENCE_RESILIENCE.streamRetryEnabled); // gated by cfg.enabled downstream
    assert.equal(cfg.modelFallbackForWorkers, DEFAULT_INFERENCE_RESILIENCE.modelFallbackForWorkers);
  });
});
