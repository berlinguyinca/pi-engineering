/**
 * Mission-level resilience configuration.
 *
 * Defaults are time-based (wall-clock retry window), NOT attempt-count-based.
 * Environment variables override individual knobs so an operator can tune
 * behaviour per environment without recompiling:
 *
 *   PI_GATEWAY_RETRY_WINDOW     total wall-clock retry budget (ms or "90m")
 *   PI_GATEWAY_PROBE_INTERVAL   recovery probe cadence in ms (default 10_000)
 *   PI_GATEWAY_REQUEST_TIMEOUT  per-request timeout in ms (default 120_000)
 *   PI_GATEWAY_AUTO_RESUME      auto-resume from PAUSED_INFRASTRUCTURE ("1"/"true")
 *
 * Durations parse as plain milliseconds, or human strings like "90m", "10s".
 */

import { parseDurationMs } from "./duration.ts";

export interface GatewayResilienceConfig {
  /** Wall-clock retry budget for one logical mission step, ms. Default 90 min. */
  retry_window_ms: number;
  /** Recovery-probe cadence, ms. Default 10s. */
  probe_interval_ms: number;
  /** Per-request timeout, ms. Default 120s. */
  request_timeout_ms: number;
  /** Connection timeout, ms. Default 10s. */
  connect_timeout_ms: number;
  /** Whether transient infrastructure errors are retried within the window. */
  retry_transient_errors: boolean;
  /** Whether retry exhaustion pauses the mission rather than failing it. */
  preserve_mission_on_exhaustion: boolean;
  /** Whether a paused mission auto-resumes when the gateway returns healthy. */
  auto_resume_on_recovery: boolean;
  /** Positive jitter (ms) added to each probe interval to avoid thundering herd. */
  jitter_ms: number;
  /** Consecutive failures before the circuit breaker opens. */
  circuit_breaker_threshold: number;
}

export const DEFAULT_GATEWAY_RESILIENCE: GatewayResilienceConfig = {
  retry_window_ms: 90 * 60_000,
  probe_interval_ms: 10_000,
  request_timeout_ms: 120_000,
  connect_timeout_ms: 10_000,
  retry_transient_errors: true,
  preserve_mission_on_exhaustion: true,
  auto_resume_on_recovery: true,
  jitter_ms: 1_000,
  circuit_breaker_threshold: 5,
};

function truthy(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve the gateway resilience config, applying environment overrides.
 * `env` is injectable for deterministic tests; defaults to `process.env`.
 */
export function resolveGatewayResilienceConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): GatewayResilienceConfig {
  const cfg: GatewayResilienceConfig = { ...DEFAULT_GATEWAY_RESILIENCE };
  const dur = (k: string): number | undefined => {
    const v = env[k];
    if (v === undefined) return undefined;
    const parsed = parseDurationMs(v);
    return parsed !== null ? parsed : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = env[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const bool = (k: string): boolean | undefined => truthy(env[k]);

  const retryWindow = dur("PI_GATEWAY_RETRY_WINDOW");
  const probe = num("PI_GATEWAY_PROBE_INTERVAL");
  const requestTimeout = num("PI_GATEWAY_REQUEST_TIMEOUT");
  const connectTimeout = num("PI_GATEWAY_CONNECT_TIMEOUT");
  const jitter = num("PI_GATEWAY_JITTER_MS");
  const threshold = num("PI_GATEWAY_CIRCUIT_BREAKER_THRESHOLD");
  const autoResume = bool("PI_GATEWAY_AUTO_RESUME");
  const preserve = bool("PI_GATEWAY_PRESERVE_MISSION");
  const retryTransient = bool("PI_GATEWAY_RETRY_TRANSIENT");

  if (retryWindow != null) cfg.retry_window_ms = retryWindow;
  if (probe != null) cfg.probe_interval_ms = probe;
  if (requestTimeout != null) cfg.request_timeout_ms = requestTimeout;
  if (connectTimeout != null) cfg.connect_timeout_ms = connectTimeout;
  if (jitter != null) cfg.jitter_ms = jitter;
  if (threshold != null) cfg.circuit_breaker_threshold = threshold;
  if (autoResume != null) cfg.auto_resume_on_recovery = autoResume;
  if (preserve != null) cfg.preserve_mission_on_exhaustion = preserve;
  if (retryTransient != null) cfg.retry_transient_errors = retryTransient;

  return cfg;
}
