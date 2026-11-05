import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_INFERENCE_RESILIENCE,
  resolveInferenceResilienceConfig,
} from "../../src/inference/resilienceConfig.ts";

// A switch value we cannot read used to resolve to `true` unconditionally, so a
// mistyped disable left an intervention armed and nothing said so. These cases
// pin the tri-state behaviour and, just as importantly, pin that no canonical
// spelling changes value: operators must not lose an intervention they set
// correctly.
describe("inference resilience switch parsing", () => {
  const BOOL_SWITCHES = [
    "PI_INFERENCE_STREAM_RETRY_ENABLED",
    "PI_INFERENCE_MODEL_FALLBACK",
    "PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY",
    "PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS",
  ] as const;

  it("reads every canonical affirmative as on and every canonical negative as off", () => {
    for (const name of BOOL_SWITCHES) {
      for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
        assert.equal(resolveInferenceResilienceConfig({ [name]: value })[switchField(name)], true, `${name}=${value}`);
      }
      for (const value of ["false", "0", "off", " OFF "]) {
        assert.equal(resolveInferenceResilienceConfig({ [name]: value })[switchField(name)], false, `${name}=${value}`);
      }
    }
  });

  it("resolves an unrecognised token to the default and records it", () => {
    for (const value of ["ture", "diable", "no", "1x", "enabled"]) {
      const cfg = resolveInferenceResilienceConfig({ PI_INFERENCE_STREAM_RETRY_ENABLED: value });
      assert.equal(cfg.streamRetryEnabled, DEFAULT_INFERENCE_RESILIENCE.streamRetryEnabled, value);
      assert.deepEqual(cfg.unparseableSwitches, [`PI_INFERENCE_STREAM_RETRY_ENABLED=${value}`], value);
    }
  });

  it("never arms a default-off switch with a typo", () => {
    // The master switch defaults off; the old negative-only parser could not do
    // this, which is why it was replaced.
    const cfg = resolveInferenceResilienceConfig({
      PI_INFERENCE_RESILIENCE_ENABLED: "ture",
      PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE: "alwayson",
    });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.modelFallbackInteractive, false);
    assert.deepEqual(cfg.unparseableSwitches, [
      "PI_INFERENCE_RESILIENCE_ENABLED=ture",
      "PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE=alwayson",
    ]);
  });

  it("records a canonical negative as nothing at all", () => {
    const cfg = resolveInferenceResilienceConfig({
      PI_INFERENCE_RESILIENCE_ENABLED: "off",
      PI_INFERENCE_STREAM_RETRY_ENABLED: "false",
    });
    assert.equal(cfg.streamRetryEnabled, false);
    assert.equal(cfg.unparseableSwitches, undefined);
  });

  it("attributes the fallback switch to the name actually set", () => {
    assert.deepEqual(resolveInferenceResilienceConfig({ PI_INFERENCE_MODEL_FALLBACK: "maybe" }).unparseableSwitches, [
      "PI_INFERENCE_MODEL_FALLBACK=maybe",
    ]);
    assert.deepEqual(
      resolveInferenceResilienceConfig({ PI_GATEWAY_MODEL_FALLBACK_ENABLED: "maybe" }).unparseableSwitches,
      ["PI_GATEWAY_MODEL_FALLBACK_ENABLED=maybe"],
    );
  });

  it("leaves every tunable at its default when nothing is set", () => {
    const cfg = resolveInferenceResilienceConfig({});
    assert.equal(cfg.unparseableSwitches, undefined);
    assert.equal(cfg.streamRetryEnabled, DEFAULT_INFERENCE_RESILIENCE.streamRetryEnabled);
    assert.equal(cfg.modelFallbackForWorkers, DEFAULT_INFERENCE_RESILIENCE.modelFallbackForWorkers);
    assert.equal(cfg.fallbackSameProviderOnly, DEFAULT_INFERENCE_RESILIENCE.fallbackSameProviderOnly);
    assert.equal(cfg.catalogRefreshOnNoWorkers, DEFAULT_INFERENCE_RESILIENCE.catalogRefreshOnNoWorkers);
  });
});

function switchField(
  name: string,
): "streamRetryEnabled" | "modelFallbackForWorkers" | "fallbackSameProviderOnly" | "catalogRefreshOnNoWorkers" {
  switch (name) {
    case "PI_INFERENCE_STREAM_RETRY_ENABLED":
      return "streamRetryEnabled";
    case "PI_INFERENCE_MODEL_FALLBACK":
      return "modelFallbackForWorkers";
    case "PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY":
      return "fallbackSameProviderOnly";
    default:
      return "catalogRefreshOnNoWorkers";
  }
}
