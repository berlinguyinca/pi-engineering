/**
 * Mission-level resilience configuration.
 *
 * Defaults are time-based (wall-clock retry window), NOT attempt-count-based.
 * Environment variables override individual knobs so an operator can tune
 * behaviour per environment without recompiling:
 *
 *   PI_GATEWAY_RETRY_WINDOW     total wall-clock retry budget (ms or "12h"; default 12h)
 *   PI_GATEWAY_MAX_BACKOFF      cap between worker relaunches (ms or "3m"; default 3m)
 *   PI_GATEWAY_MAX_RELAUNCHES   worker relaunches per task through one outage (default 100)
 *   PI_GATEWAY_MAX_OUTAGE       total ceiling across pause + resume, then FAIL (default 36h)
 *   PI_GATEWAY_AUTO_RESUME_HORIZON  how long a paused mission watches the recovery
 *                               probe to resume itself (ms or "24h"; default 24h)
 *   PI_GATEWAY_PROBE_INTERVAL   recovery probe cadence in ms (default 10_000)
 *   PI_GATEWAY_REQUEST_TIMEOUT  per-request timeout in ms (default 120_000)
 *   PI_GATEWAY_AUTO_RESUME      auto-resume from PAUSED_INFRASTRUCTURE ("1"/"true")
 *
 * Durations parse as plain milliseconds, or human strings like "90m", "10s".
 */

import { parseDurationMs } from "./duration.ts";

export interface GatewayResilienceConfig {
  /**
   * Wall-clock retry budget for one logical mission step, ms. Default 12h:
   * a model reload, a GPU move or capacity_unavailable can last hours.
   */
  retry_window_ms: number;
  /**
   * Cap on the capped-exponential wait between worker relaunches when no real
   * recovery probe is configured (with one, the probe interval paces instead,
   * so recovery is noticed promptly). Default 3 min.
   */
  max_backoff_ms?: number;
  /**
   * After the window is exhausted the mission PAUSES; with a real recovery
   * probe it keeps probing this long and resumes itself on the first healthy
   * answer. Default 24h. 0 disables auto-resume inside orchestrate().
   */
  auto_resume_horizon_ms?: number;
  /**
   * Worker relaunches one task may spend on a single outage. Relaunches only
   * happen while the recovery probe says healthy, so reaching this means the
   * gateway looks fine and the task still fails: FAIL with the reason rather
   * than replaying a full session every few minutes for hours. Default 100.
   */
  max_relaunches?: number;
  /**
   * Total ceiling on one outage for a task, across pause and auto-resume.
   * Past it the task FAILS with a clear reason. Default 36h (12h window +
   * 24h auto-resume).
   */
  max_outage_ms?: number;
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
  retry_window_ms: 12 * 3_600_000,
  max_backoff_ms: 180_000,
  auto_resume_horizon_ms: 24 * 3_600_000,
  max_relaunches: 100,
  max_outage_ms: 36 * 3_600_000,
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
  const maxBackoff = dur("PI_GATEWAY_MAX_BACKOFF");
  const autoResumeHorizon = dur("PI_GATEWAY_AUTO_RESUME_HORIZON");
  const maxRelaunches = num("PI_GATEWAY_MAX_RELAUNCHES");
  const maxOutage = dur("PI_GATEWAY_MAX_OUTAGE");
  const probe = num("PI_GATEWAY_PROBE_INTERVAL");
  const requestTimeout = num("PI_GATEWAY_REQUEST_TIMEOUT");
  const connectTimeout = num("PI_GATEWAY_CONNECT_TIMEOUT");
  const jitter = num("PI_GATEWAY_JITTER_MS");
  const threshold = num("PI_GATEWAY_CIRCUIT_BREAKER_THRESHOLD");
  const autoResume = bool("PI_GATEWAY_AUTO_RESUME");
  const preserve = bool("PI_GATEWAY_PRESERVE_MISSION");
  const retryTransient = bool("PI_GATEWAY_RETRY_TRANSIENT");

  if (retryWindow != null) cfg.retry_window_ms = retryWindow;
  if (maxBackoff != null) cfg.max_backoff_ms = maxBackoff;
  if (autoResumeHorizon != null) cfg.auto_resume_horizon_ms = autoResumeHorizon;
  if (maxRelaunches != null) cfg.max_relaunches = Math.floor(maxRelaunches);
  if (maxOutage != null) cfg.max_outage_ms = maxOutage;
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
