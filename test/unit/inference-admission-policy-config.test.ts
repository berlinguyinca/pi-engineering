/**
 * Admission-retry configuration + policy resolution (spec 03).
 *
 * Covers defaults, environment overrides, scope resolution, reason decisions
 * (with HTTP status outranking the reason token), validation, and the
 * provider-wrap gate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ADMISSION_RETRY_CONFIG,
  admissionConfigFromEnv,
  decideAdmission,
  normalizeAdmissionConfig,
  resolveAdmissionScope,
  shouldWrapProvider,
  validateAdmissionConfig,
} from "../../src/inference/admissionConfig.ts";

/** A config that bypasses normalization so validation sees raw (possibly bad) values. */
function rawConfig(overrides: Record<string, unknown> = {}): Parameters<typeof validateAdmissionConfig>[0] {
  return {
    ...DEFAULT_ADMISSION_RETRY_CONFIG,
    ...overrides,
    unknown_reason: {
      ...DEFAULT_ADMISSION_RETRY_CONFIG.unknown_reason,
      ...(overrides.unknown_reason as object | undefined),
    },
  } as Parameters<typeof validateAdmissionConfig>[0];
}

test("defaults match the documented policy", () => {
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.enabled, true);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.max_attempts, 50);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.max_elapsed_ms, 900_000);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.min_delay_ms, 500);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.max_delay_ms, 120_000);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.base_backoff_ms, 2_000);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.honor_retry_after, true);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.own_transport_retries, true);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.report_saturation, true);
  assert.equal(DEFAULT_ADMISSION_RETRY_CONFIG.unknown_reason.mode, "retry_if_server_delay_present");
});

test("normalizeAdmissionConfig fills defaults and coerces partial overrides", () => {
  const cfg = normalizeAdmissionConfig({ max_attempts: 3, max_elapsed_ms: 60_000 });
  assert.equal(cfg.max_attempts, 3);
  assert.equal(cfg.max_elapsed_ms, 60_000);
  assert.equal(cfg.enabled, true); // default preserved
  assert.equal(cfg.min_delay_ms, 500); // default preserved
  assert.equal(cfg.unknown_reason.mode, "retry_if_server_delay_present");
});

test("normalizeAdmissionConfig coerces strings, arrays, and unknown_reason", () => {
  const cfg = normalizeAdmissionConfig({
    max_attempts: "5",
    wrap_providers: "a,b,c",
    unknown_reason: { mode: "fail" },
    reasons: { queue_timeout: { action: "fallback", max_elapsed_ms: 10_000 } },
  });
  assert.equal(cfg.max_attempts, 5);
  assert.deepEqual(cfg.wrap_providers, ["a", "b", "c"]);
  assert.equal(cfg.unknown_reason.mode, "fail");
  assert.equal(cfg.reasons.queue_timeout?.action, "fallback");
  assert.equal(cfg.reasons.queue_timeout?.max_elapsed_ms, 10_000);
});

test("normalizeAdmissionConfig rejects a non-object input gracefully", () => {
  const cfg = normalizeAdmissionConfig(null);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.max_attempts, 50);
});

test("environment overrides apply flags, numbers, mode, and wrap list", () => {
  const cfg = admissionConfigFromEnv(DEFAULT_ADMISSION_RETRY_CONFIG, {
    PI_HARNESS_ADMISSION_MAX_ATTEMPTS: "7",
    PI_HARNESS_ADMISSION_OBSERVE_ONLY: "1",
    PI_HARNESS_ADMISSION_UNKNOWN_REASON_MODE: "retry",
    PI_HARNESS_ADMISSION_WRAP_PROVIDERS: "inferweave,qwen",
  });
  assert.equal(cfg.max_attempts, 7);
  assert.equal(cfg.observe_only, true);
  assert.equal(cfg.unknown_reason.mode, "retry");
  assert.deepEqual(cfg.wrap_providers, ["inferweave", "qwen"]);
});

test("environment ignores malformed numbers", () => {
  const cfg = admissionConfigFromEnv(DEFAULT_ADMISSION_RETRY_CONFIG, {
    PI_HARNESS_ADMISSION_MAX_ATTEMPTS: "not-a-number",
    PI_HARNESS_ADMISSION_ENABLED: "false",
  });
  assert.equal(cfg.max_attempts, 50); // unchanged
  assert.equal(cfg.enabled, false); // boolean still honoured
});

test("resolveAdmissionScope applies provider then provider/model overrides", () => {
  const cfg = normalizeAdmissionConfig({
    providers: { inferweave: { max_attempts: 10 } },
    models: { "inferweave/qwen": { max_attempts: 20, min_delay_ms: 1000 } },
  });
  const providerOnly = resolveAdmissionScope(cfg, "inferweave", "other-model");
  assert.equal(providerOnly.max_attempts, 10);
  assert.equal(providerOnly.min_delay_ms, 500); // not overridden for provider
  const model = resolveAdmissionScope(cfg, "inferweave", "qwen");
  assert.equal(model.max_attempts, 20);
  assert.equal(model.min_delay_ms, 1000);
});

test("decideAdmission maps the taxonomy to actions", () => {
  const cfg = normalizeAdmissionConfig({});
  assert.equal(decideAdmission(cfg, { reason: "queue_timeout", status: 429 }).action, "retry");
  assert.equal(decideAdmission(cfg, { reason: "worker_saturated", status: 503 }).action, "retry");
  assert.equal(decideAdmission(cfg, { reason: "capacity_unavailable", status: 503 }).action, "retry_then_fallback");
  assert.equal(decideAdmission(cfg, { reason: "quota_exhausted", status: 429 }).action, "fallback");
  assert.equal(decideAdmission(cfg, { reason: "auth_failed", status: 429 }).action, "fail");
});

test("HTTP status outranks replay flags: permanent statuses always fail", () => {
  const cfg = normalizeAdmissionConfig({});
  for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    // Even a retryable reason token on a permanent status is a hard fail.
    assert.equal(
      decideAdmission(cfg, {
        reason: "queue_timeout",
        status,
        serverDelayMs: 1_000,
        explicitReplayContract: true,
      }).action,
      "fail",
      `status ${status}`,
    );
  }
  // A retryable reason on a non-permanent 4xx/5xx is still retried.
  assert.equal(decideAdmission(cfg, { reason: "queue_timeout", status: 503 }).action, "retry");
});

test("unknown reasons retry only when a server delay is present in the default mode", () => {
  const cfg = normalizeAdmissionConfig({});
  const withDelay = decideAdmission(cfg, { reason: "mystery", status: 429, serverDelayMs: 5000 });
  assert.equal(withDelay.action, "retry");
  assert.equal(withDelay.unknownReason, true);
  const withoutDelay = decideAdmission(cfg, { reason: "mystery", status: 429 });
  assert.equal(withoutDelay.action, "fail");
});

test("unknown_reason.mode=retry waits even without a server delay; fail never waits", () => {
  const retry = normalizeAdmissionConfig({ unknown_reason: { mode: "retry" } });
  assert.equal(decideAdmission(retry, { reason: "mystery", status: 429 }).action, "retry");

  const fail = normalizeAdmissionConfig({ unknown_reason: { mode: "fail" } });
  assert.equal(decideAdmission(fail, { reason: "mystery", status: 429, serverDelayMs: 5000 }).action, "fail");
});

test("per-reason overrides replace the taxonomy action and budget", () => {
  const cfg = normalizeAdmissionConfig({
    reasons: { queue_timeout: { action: "fallback" }, quota_exhausted: { max_elapsed_ms: 5000 } },
  });
  assert.equal(decideAdmission(cfg, { reason: "queue_timeout", status: 429 }).action, "fallback");
  const quota = decideAdmission(cfg, { reason: "quota_exhausted", status: 429 });
  assert.equal(quota.action, "fallback");
  assert.equal(quota.maxElapsedMs, 5000);
});

test("validateAdmissionConfig flags out-of-range and contradictory settings", () => {
  const issues = validateAdmissionConfig(
    rawConfig({
      max_attempts: 0,
      min_delay_ms: 10_000,
      max_delay_ms: 100,
      unknown_reason: { mode: "bogus" },
    }),
  );
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes("inference.retry.admission.max_attempts"));
  assert.ok(paths.includes("inference.retry.admission.min_delay_ms"));
  assert.ok(paths.includes("inference.retry.admission.unknown_reason.mode"));
  assert.ok(issues.some((i) => i.severity === "error"));
});

test("validateAdmissionConfig flags a jitter ratio outside 0..0.5", () => {
  const issues = validateAdmissionConfig(rawConfig({ jitter_ratio: 0.9 }));
  assert.ok(issues.some((i) => i.path === "inference.retry.admission.jitter_ratio" && i.severity === "error"));
});

test("shouldWrapProvider respects enabled and the allowlist", () => {
  const all = normalizeAdmissionConfig({});
  assert.ok(shouldWrapProvider(all, "inferweave"));
  assert.ok(shouldWrapProvider(all, "any"));

  const list = normalizeAdmissionConfig({ wrap_providers: ["inferweave"] });
  assert.ok(shouldWrapProvider(list, "inferweave"));
  assert.ok(!shouldWrapProvider(list, "other"));

  const disabled = normalizeAdmissionConfig({ enabled: false });
  assert.ok(!shouldWrapProvider(disabled, "inferweave"));
});
