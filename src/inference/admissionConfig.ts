/**
 * Admission-retry configuration (spec 03-configuration).
 *
 * Four layers with the same precedence the engineering policy uses: built-in
 * defaults, engineering-policy `inference.retry.admission`, then environment
 * overrides. Scope resolution applies provider then `provider/model` overrides.
 */

import type { PolicyIssue } from "../lifecycle/policy.ts";
import {
  type AdmissionAction,
  type AdmissionReasonPolicy,
  DEFAULT_ADMISSION_REASON_POLICY,
  PERMANENT_ADMISSION_STATUSES,
  mayCarryAdmission,
} from "./admissionContract.ts";

/** Per-reason override (YAML `reasons.<reason>`). */
export interface AdmissionReasonOverride {
  action?: AdmissionAction;
  max_elapsed_ms?: number;
  fallback_after_ms?: number;
}

/** Numeric/behavioural knobs that may be overridden per provider or model. */
export interface AdmissionScopeOverride {
  enabled?: boolean;
  observe_only?: boolean;
  max_attempts?: number;
  max_elapsed_ms?: number;
  min_delay_ms?: number;
  max_delay_ms?: number;
  base_backoff_ms?: number;
  max_backoff_ms?: number;
  jitter_ratio?: number;
  honor_retry_after?: boolean;
  reasons?: Record<string, AdmissionReasonOverride>;
}

/** How the harness treats an admission response whose reason it does not know. */
export type UnknownReasonMode = "retry_if_server_delay_present" | "retry" | "fail";

/** Fully resolved admission-retry configuration for one scope. */
export interface AdmissionRetryConfig {
  /** Master switch. When false, requests pass through untouched. */
  enabled: boolean;
  /** Parse and publish events without waiting or changing control flow. */
  observe_only: boolean;
  /** Attempt cap for one logical inference operation. */
  max_attempts: number;
  /** Wait budget for one logical inference operation. */
  max_elapsed_ms: number;
  min_delay_ms: number;
  max_delay_ms: number;
  base_backoff_ms: number;
  max_backoff_ms: number;
  /** Positive jitter fraction, 0..0.5. */
  jitter_ratio: number;
  honor_retry_after: boolean;
  /**
   * Additional cap on cumulative waiting per provider/model across logical
   * requests inside this window. Stops an outer layer (agent retry, scheduler
   * re-dispatch) from re-spending a budget that is already exhausted. 0 disables.
   */
  shared_budget_ms: number;
  /** Send `x-pi-logical-request-id` / `x-pi-attempt` headers on each attempt. */
  correlation_headers: boolean;
  /**
   * Take ownership of transport-class retries: the provider's own retry budget is
   * forced to zero so an admission wait is never retried at two layers at once.
   */
  own_transport_retries: boolean;
  /** Feed observed queue saturation back into the capability registry. */
  report_saturation: boolean;
  unknown_reason: {
    mode: UnknownReasonMode;
    max_elapsed_ms: number;
    fallback_after_ms: number;
  };
  reasons: Record<string, AdmissionReasonOverride>;
  /** Keyed by provider id. */
  providers: Record<string, AdmissionScopeOverride>;
  /** Keyed by `provider/model`. */
  models: Record<string, AdmissionScopeOverride>;
  /** Only wrap these provider ids; empty means every registered provider. */
  wrap_providers: string[];
}

/** YAML-facing shape: every field optional. */
export type AdmissionRetrySettings = {
  [K in keyof AdmissionRetryConfig]?: AdmissionRetryConfig[K];
};

export const DEFAULT_ADMISSION_RETRY_CONFIG: AdmissionRetryConfig = {
  enabled: true,
  observe_only: false,
  max_attempts: 50,
  max_elapsed_ms: 900_000,
  min_delay_ms: 500,
  max_delay_ms: 120_000,
  base_backoff_ms: 2_000,
  max_backoff_ms: 120_000,
  jitter_ratio: 0.1,
  honor_retry_after: true,
  shared_budget_ms: 0,
  correlation_headers: true,
  own_transport_retries: true,
  report_saturation: true,
  unknown_reason: {
    mode: "retry_if_server_delay_present",
    max_elapsed_ms: 60_000,
    fallback_after_ms: 60_000,
  },
  reasons: {},
  providers: {},
  models: {},
  wrap_providers: [],
};

const SCOPE_KEYS = [
  "enabled",
  "observe_only",
  "max_attempts",
  "max_elapsed_ms",
  "min_delay_ms",
  "max_delay_ms",
  "base_backoff_ms",
  "max_backoff_ms",
  "jitter_ratio",
  "honor_retry_after",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = source[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
}

function pickNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  const raw = source[key];
  const v = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function pickStringArray(source: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const raw = source[key];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return fallback;
}

function pickReasonOverrides(value: unknown): Record<string, AdmissionReasonOverride> {
  if (!isRecord(value)) return {};
  const out: Record<string, AdmissionReasonOverride> = {};
  for (const [reason, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const entry: AdmissionReasonOverride = {};
    const action = raw.action;
    if (action === "retry" || action === "retry_then_fallback" || action === "fallback" || action === "fail") {
      entry.action = action;
    }
    const maxElapsed = raw.max_elapsed_ms;
    if (typeof maxElapsed === "number" && Number.isFinite(maxElapsed)) entry.max_elapsed_ms = maxElapsed;
    const fallbackAfter = raw.fallback_after_ms;
    if (typeof fallbackAfter === "number" && Number.isFinite(fallbackAfter)) entry.fallback_after_ms = fallbackAfter;
    out[reason] = entry;
  }
  return out;
}

function pickScopeMap(value: unknown): Record<string, AdmissionScopeOverride> {
  if (!isRecord(value)) return {};
  const out: Record<string, AdmissionScopeOverride> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const scope: AdmissionScopeOverride = {};
    for (const field of SCOPE_KEYS) {
      const v = raw[field];
      if (field === "enabled" || field === "observe_only" || field === "honor_retry_after") {
        if (typeof v === "boolean") scope[field] = v;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        (scope as unknown as Record<string, number>)[field] = v;
      }
    }
    if (raw.reasons !== undefined) scope.reasons = pickReasonOverrides(raw.reasons);
    out[key] = scope;
  }
  return out;
}

/** Coerce an untrusted config block (YAML/JSON) into a complete config. */
export function normalizeAdmissionConfig(raw: unknown): AdmissionRetryConfig {
  const base = DEFAULT_ADMISSION_RETRY_CONFIG;
  if (!isRecord(raw)) return { ...base, reasons: {}, providers: {}, models: {}, wrap_providers: [] };
  const cfg: AdmissionRetryConfig = {
    enabled: pickBoolean(raw, "enabled", base.enabled),
    observe_only: pickBoolean(raw, "observe_only", base.observe_only),
    max_attempts: Math.floor(pickNumber(raw, "max_attempts", base.max_attempts)),
    max_elapsed_ms: pickNumber(raw, "max_elapsed_ms", base.max_elapsed_ms),
    min_delay_ms: pickNumber(raw, "min_delay_ms", base.min_delay_ms),
    max_delay_ms: pickNumber(raw, "max_delay_ms", base.max_delay_ms),
    base_backoff_ms: pickNumber(raw, "base_backoff_ms", base.base_backoff_ms),
    max_backoff_ms: pickNumber(raw, "max_backoff_ms", base.max_backoff_ms),
    jitter_ratio: pickNumber(raw, "jitter_ratio", base.jitter_ratio),
    honor_retry_after: pickBoolean(raw, "honor_retry_after", base.honor_retry_after),
    shared_budget_ms: pickNumber(raw, "shared_budget_ms", base.shared_budget_ms),
    correlation_headers: pickBoolean(raw, "correlation_headers", base.correlation_headers),
    own_transport_retries: pickBoolean(raw, "own_transport_retries", base.own_transport_retries),
    report_saturation: pickBoolean(raw, "report_saturation", base.report_saturation),
    unknown_reason: {
      mode: base.unknown_reason.mode,
      max_elapsed_ms: base.unknown_reason.max_elapsed_ms,
      fallback_after_ms: base.unknown_reason.fallback_after_ms,
    },
    reasons: pickReasonOverrides(raw.reasons),
    providers: pickScopeMap(raw.providers),
    models: pickScopeMap(raw.models),
    wrap_providers: pickStringArray(raw, "wrap_providers", []),
  };
  const unknown = isRecord(raw.unknown_reason) ? raw.unknown_reason : {};
  const mode = unknown.mode;
  if (mode === "retry" || mode === "fail" || mode === "retry_if_server_delay_present") {
    cfg.unknown_reason.mode = mode;
  }
  cfg.unknown_reason.max_elapsed_ms = pickNumber(unknown, "max_elapsed_ms", base.unknown_reason.max_elapsed_ms);
  cfg.unknown_reason.fallback_after_ms = pickNumber(
    unknown,
    "fallback_after_ms",
    base.unknown_reason.fallback_after_ms,
  );
  return cfg;
}

/** Apply `PI_HARNESS_ADMISSION_*` environment overrides (spec 03 §4). */
export function admissionConfigFromEnv(
  config: AdmissionRetryConfig,
  env: Record<string, string | undefined> = process.env,
): AdmissionRetryConfig {
  const out: AdmissionRetryConfig = { ...config, reasons: { ...config.reasons } };
  const flags: [string, keyof AdmissionRetryConfig][] = [
    ["PI_HARNESS_ADMISSION_ENABLED", "enabled"],
    ["PI_HARNESS_ADMISSION_OBSERVE_ONLY", "observe_only"],
    ["PI_HARNESS_ADMISSION_HONOR_RETRY_AFTER", "honor_retry_after"],
    ["PI_HARNESS_ADMISSION_CORRELATION_HEADERS", "correlation_headers"],
    ["PI_HARNESS_ADMISSION_OWN_TRANSPORT_RETRIES", "own_transport_retries"],
    ["PI_HARNESS_ADMISSION_REPORT_SATURATION", "report_saturation"],
  ];
  for (const [name, field] of flags) {
    const v = env[name];
    if (v === undefined) continue;
    if (v === "true" || v === "1") (out as unknown as Record<string, boolean>)[field] = true;
    else if (v === "false" || v === "0") (out as unknown as Record<string, boolean>)[field] = false;
  }
  const numbers: [string, keyof AdmissionRetryConfig][] = [
    ["PI_HARNESS_ADMISSION_MAX_ATTEMPTS", "max_attempts"],
    ["PI_HARNESS_ADMISSION_MAX_ELAPSED_MS", "max_elapsed_ms"],
    ["PI_HARNESS_ADMISSION_MIN_DELAY_MS", "min_delay_ms"],
    ["PI_HARNESS_ADMISSION_MAX_DELAY_MS", "max_delay_ms"],
    ["PI_HARNESS_ADMISSION_BASE_BACKOFF_MS", "base_backoff_ms"],
    ["PI_HARNESS_ADMISSION_MAX_BACKOFF_MS", "max_backoff_ms"],
    ["PI_HARNESS_ADMISSION_JITTER_RATIO", "jitter_ratio"],
    ["PI_HARNESS_ADMISSION_SHARED_BUDGET_MS", "shared_budget_ms"],
  ];
  for (const [name, field] of numbers) {
    const v = env[name];
    if (v === undefined || v.trim() === "") continue;
    const parsed = Number(v);
    if (Number.isFinite(parsed)) (out as unknown as Record<string, number>)[field] = parsed;
  }
  const mode = env.PI_HARNESS_ADMISSION_UNKNOWN_REASON_MODE;
  if (mode === "retry" || mode === "fail" || mode === "retry_if_server_delay_present") {
    out.unknown_reason = { ...out.unknown_reason, mode };
  }
  const providers = env.PI_HARNESS_ADMISSION_WRAP_PROVIDERS;
  if (providers !== undefined) {
    out.wrap_providers = providers
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return out;
}

/** Build the effective config for one provider/model scope. */
export function resolveAdmissionScope(
  config: AdmissionRetryConfig,
  provider: string,
  modelId: string,
): AdmissionRetryConfig {
  const overrides = [config.providers[provider], config.models[`${provider}/${modelId}`]];
  const out: AdmissionRetryConfig = { ...config, reasons: { ...config.reasons } };
  for (const override of overrides) {
    if (!override) continue;
    for (const field of SCOPE_KEYS) {
      const v = override[field];
      if (v !== undefined) (out as unknown as Record<string, typeof v>)[field] = v;
    }
    if (override.reasons) out.reasons = { ...out.reasons, ...override.reasons };
  }
  return out;
}

/** Resolved per-reason decision for one admission response. */
export interface AdmissionDecision {
  action: AdmissionAction;
  /** Wait budget for this reason (`max_elapsed_ms`). */
  maxElapsedMs: number;
  /** Elapsed wait after which routing takes over (`retry_then_fallback`). */
  fallbackAfterMs?: number;
  /** Reason actually used for the lookup (may be `unknown`). */
  reason: string;
  /** True when the reason is not in the taxonomy. */
  unknownReason: boolean;
}

/**
 * Decide what to do with an admission response.
 *
 * An unknown reason is only waited on when the server supplied a delay and the
 * configured mode permits it; otherwise it is surfaced, never retried blindly.
 */
export function decideAdmission(
  config: AdmissionRetryConfig,
  input: { reason: string; status: number; serverDelayMs?: number; explicitReplayContract?: boolean },
): AdmissionDecision {
  const fromTaxonomy = Object.hasOwn(DEFAULT_ADMISSION_REASON_POLICY, input.reason)
    ? DEFAULT_ADMISSION_REASON_POLICY[input.reason]
    : undefined;
  const override = Object.hasOwn(config.reasons, input.reason) ? config.reasons[input.reason] : undefined;
  const unknownReason = fromTaxonomy === undefined && override === undefined;

  // The HTTP status outranks the reason token: a rejection carrying an
  // auth/authorization/malformed status is permanent whatever the gateway
  // labelled it, and must never be waited on.
  if (PERMANENT_ADMISSION_STATUSES.includes(input.status)) {
    return {
      action: "fail",
      maxElapsedMs: config.max_elapsed_ms,
      reason: input.reason,
      unknownReason,
    };
  }

  // Explicit replay eligibility has already been checked by the shared pure
  // predicate. A future condition code is safe to execute when its action is a
  // known retry action; legacy unknown-reason heuristics remain below.
  if (input.explicitReplayContract === true) {
    return {
      action: "retry",
      maxElapsedMs: config.max_elapsed_ms,
      reason: input.reason,
      unknownReason,
    };
  }

  if (unknownReason) {
    const mode = config.unknown_reason.mode;
    const hasServerDelay = input.serverDelayMs !== undefined && input.serverDelayMs >= 0;
    let action: AdmissionAction = "fail";
    if (mode === "retry") action = "retry";
    else if (mode === "retry_if_server_delay_present" && hasServerDelay) action = "retry";
    return {
      action,
      maxElapsedMs: config.unknown_reason.max_elapsed_ms,
      fallbackAfterMs: config.unknown_reason.fallback_after_ms,
      reason: input.reason,
      unknownReason: true,
    };
  }

  const base: AdmissionReasonPolicy = fromTaxonomy ?? { action: "retry" };
  return {
    action: override?.action ?? base.action,
    maxElapsedMs: override?.max_elapsed_ms ?? base.maxElapsedMs ?? config.max_elapsed_ms,
    fallbackAfterMs: override?.fallback_after_ms ?? base.fallbackAfterMs,
    reason: input.reason,
    unknownReason: false,
  };
}

const RANGE_FIELDS: [keyof AdmissionRetryConfig, number, number][] = [
  ["max_attempts", 1, 1000],
  ["max_elapsed_ms", 1_000, 86_400_000],
  ["min_delay_ms", 0, 600_000],
  ["max_delay_ms", 100, 3_600_000],
  ["base_backoff_ms", 0, 600_000],
  ["max_backoff_ms", 100, 3_600_000],
  ["jitter_ratio", 0, 0.5],
  ["shared_budget_ms", 0, 86_400_000],
];

/** Validate an admission config block; used by engineering-policy validation. */
export function validateAdmissionConfig(config: AdmissionRetryConfig): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  for (const [field, min, max] of RANGE_FIELDS) {
    const v = config[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({ path: `inference.retry.admission.${field}`, message: "expected a number", severity: "error" });
      continue;
    }
    if (v < min || v > max) {
      issues.push({
        path: `inference.retry.admission.${field}`,
        message: `${v} is outside the allowed range ${min}..${max}`,
        severity: "error",
      });
    }
  }
  if (config.min_delay_ms > config.max_delay_ms) {
    issues.push({
      path: "inference.retry.admission.min_delay_ms",
      message: "min_delay_ms must not exceed max_delay_ms",
      severity: "error",
    });
  }
  if (
    config.unknown_reason.mode !== "retry" &&
    config.unknown_reason.mode !== "fail" &&
    config.unknown_reason.mode !== "retry_if_server_delay_present"
  ) {
    issues.push({
      path: "inference.retry.admission.unknown_reason.mode",
      message: 'must be "retry", "fail", or "retry_if_server_delay_present"',
      severity: "error",
    });
  }
  for (const [reason, override] of Object.entries(config.reasons)) {
    if (
      override.action === undefined &&
      override.max_elapsed_ms === undefined &&
      override.fallback_after_ms === undefined
    ) {
      issues.push({
        path: `inference.retry.admission.reasons.${reason}`,
        message: "override sets neither action nor budget",
        severity: "warning",
      });
    }
  }
  return issues;
}

/** True when `provider` should be wrapped by the admission transport. */
export function shouldWrapProvider(config: AdmissionRetryConfig, provider: string): boolean {
  if (!config.enabled) return false;
  if (config.wrap_providers.length === 0) return true;
  return config.wrap_providers.includes(provider);
}

/** Re-export so callers can test status gating without importing the contract. */
export { mayCarryAdmission };
