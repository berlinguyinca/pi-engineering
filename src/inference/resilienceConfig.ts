/**
 * Resilient-inference configuration (fault-tolerance spec §21/§25).
 *
 * Normalizes the PI_INFERENCE_* variables and reuses the existing
 * PI_GATEWAY_* variables for long-duration outages instead of duplicating
 * their semantics:
 *
 *   PI_INFERENCE_RESILIENCE_ENABLED         master switch (default true; "false"/"0" off)
 *   PI_INFERENCE_STREAM_RETRY_ENABLED       same-model stream retry (default true)
 *   PI_INFERENCE_STREAM_RETRY_INITIAL       first stream-retry wait (default "30s")
 *   PI_INFERENCE_STREAM_RETRY_MAX           local stream-retry ceiling (default "2m")
 *   PI_INFERENCE_STREAM_RETRY_ATTEMPTS      attempts per logical model (default 4)
 *   PI_INFERENCE_CIRCUIT_FAILURES           model failures that open a circuit (default 3)
 *   PI_INFERENCE_CIRCUIT_WINDOW             sliding failure window (default "5m")
 *   PI_INFERENCE_CIRCUIT_COOLDOWN           OPEN → HALF_OPEN cooldown (default "2m")
 *   PI_INFERENCE_MODEL_FALLBACK             capability-based fallback for AUTONOMOUS
 *                                           workers (default on; see PI_GATEWAY_MODEL_FALLBACK_ENABLED)
 *   PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE fallback for the interactive session
 *                                           (configurable policy; opt-in, default off)
 *   PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS  refresh the catalog before falling
 *                                           back on no_workers (default true)
 *   PI_INFERENCE_ACTIVATION_FALLBACK_AFTER  how long model_activating may wait before a
 *                                           capability-based fallback is considered (default "10m")
 *   PI_INFERENCE_UNAVAILABLE_PENALTY        TTL of a temporary unavailability penalty when
 *                                           the server supplies no timing (default "2m")
 *
 * Long-duration outage pacing (retry window, backoff cap, auto-resume) stays in
 * PI_GATEWAY_RETRY_WINDOW / PI_GATEWAY_MAX_BACKOFF / PI_GATEWAY_MAX_ELAPSED_MS /
 * PI_GATEWAY_AUTO_RESUME — resolved by resolveGatewayResilienceConfig. This
 * module deliberately does not re-parse those variables.
 */

import { parseRetryDurationMs } from "./retryPolicy.ts";

export interface InferenceResilienceConfig {
  /** Master switch for the resilient layer. When false, requests pass through. */
  enabled: boolean;
  /** Same-model retry for interrupted streams / link cuts. */
  streamRetryEnabled: boolean;
  /** Wait before the first stream retry (default 30s). */
  streamRetryInitialMs: number;
  /** Local backoff ceiling for stream retries (default 2m). */
  streamRetryMaxMs: number;
  /** Total attempts per logical model before the ladder escalates (default 4). */
  streamRetryMaxAttempts: number;
  /** Model-scoped failures within the window that open a circuit (default 3). */
  circuitFailures: number;
  /** Sliding window over which circuit failures count (default 5m). */
  circuitWindowMs: number;
  /** How long an OPEN circuit stays open before HALF_OPEN (default 2m). */
  circuitCooldownMs: number;
  /** Capability-based fallback for autonomous workers (default: on). */
  modelFallbackForWorkers: boolean;
  /** Capability-based fallback for the interactive session (opt-in, default: off). */
  modelFallbackInteractive: boolean;
  /**
   * A fallback may only move within the failing model's provider (default: on),
   * so a session on metabolomics/* never lands on development/* when busy.
   */
  fallbackSameProviderOnly: boolean;
  /** Refresh the capability catalog before a no_workers fallback (default: on). */
  catalogRefreshOnNoWorkers: boolean;
  /** model_activating wait budget before a fallback may be considered (default 10m). */
  activationFallbackAfterMs: number;
  /** TTL of a temporary unavailability penalty without a server-provided timing (default 2m). */
  unavailabilityPenaltyMs: number;
}

export const DEFAULT_INFERENCE_RESILIENCE: InferenceResilienceConfig = {
  enabled: true,
  streamRetryEnabled: true,
  streamRetryInitialMs: 30_000,
  streamRetryMaxMs: 120_000,
  streamRetryMaxAttempts: 4,
  circuitFailures: 3,
  circuitWindowMs: 5 * 60_000,
  circuitCooldownMs: 2 * 60_000,
  modelFallbackForWorkers: true,
  modelFallbackInteractive: false,
  fallbackSameProviderOnly: true,
  catalogRefreshOnNoWorkers: true,
  activationFallbackAfterMs: 10 * 60_000,
  unavailabilityPenaltyMs: 2 * 60_000,
};

type Env = Record<string, string | undefined>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return (
    value.trim().toLowerCase() !== "false" && value.trim().toLowerCase() !== "0" && value.trim().toLowerCase() !== "off"
  );
}

/**
 * Affirmative-only switch (1/true/yes/on, any case); anything else is off.
 * Used for the interactive fallback: interactive behaviour changes only on
 * explicit opt-in.
 */
function optIn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the resilient-inference configuration from the environment.
 *
 * Fallback policy (spec §21): `PI_GATEWAY_MODEL_FALLBACK_ENABLED=true` is
 * effective for AUTONOMOUS workers, which are the default here (fallback on
 * for workers). Interactive sessions keep their own configurable policy
 * (opt-in only). Fallback applies to model-scoped availability failures only;
 * the scope decision itself is made by the failure classifier, not by this
 * config.
 */
export function resolveInferenceResilienceConfig(
  env: Env = typeof process !== "undefined" && process.env ? process.env : {},
  overrides?: Partial<InferenceResilienceConfig>,
): InferenceResilienceConfig {
  const cfg: InferenceResilienceConfig = { ...DEFAULT_INFERENCE_RESILIENCE };
  cfg.enabled = bool(env.PI_INFERENCE_RESILIENCE_ENABLED, cfg.enabled);
  cfg.streamRetryEnabled = bool(env.PI_INFERENCE_STREAM_RETRY_ENABLED, cfg.streamRetryEnabled);
  cfg.streamRetryInitialMs = parseRetryDurationMs(env.PI_INFERENCE_STREAM_RETRY_INITIAL, cfg.streamRetryInitialMs);
  cfg.streamRetryMaxMs = parseRetryDurationMs(env.PI_INFERENCE_STREAM_RETRY_MAX, cfg.streamRetryMaxMs);
  cfg.streamRetryMaxAttempts = int(env.PI_INFERENCE_STREAM_RETRY_ATTEMPTS, cfg.streamRetryMaxAttempts);
  cfg.circuitFailures = int(env.PI_INFERENCE_CIRCUIT_FAILURES, cfg.circuitFailures);
  cfg.circuitWindowMs = parseRetryDurationMs(env.PI_INFERENCE_CIRCUIT_WINDOW, cfg.circuitWindowMs);
  cfg.circuitCooldownMs = parseRetryDurationMs(env.PI_INFERENCE_CIRCUIT_COOLDOWN, cfg.circuitCooldownMs);
  const workerFallback = env.PI_INFERENCE_MODEL_FALLBACK ?? env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
  cfg.modelFallbackForWorkers = bool(workerFallback, cfg.modelFallbackForWorkers);
  cfg.modelFallbackInteractive = optIn(env.PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE);
  cfg.fallbackSameProviderOnly = bool(env.PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY, cfg.fallbackSameProviderOnly);
  cfg.catalogRefreshOnNoWorkers = bool(env.PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS, cfg.catalogRefreshOnNoWorkers);
  cfg.activationFallbackAfterMs = parseRetryDurationMs(
    env.PI_INFERENCE_ACTIVATION_FALLBACK_AFTER,
    cfg.activationFallbackAfterMs,
  );
  cfg.unavailabilityPenaltyMs = parseRetryDurationMs(env.PI_INFERENCE_UNAVAILABLE_PENALTY, cfg.unavailabilityPenaltyMs);

  if (overrides) Object.assign(cfg, overrides);
  // Sanity: the ceiling must not sit below the first rung of the ladder.
  if (cfg.streamRetryMaxMs < cfg.streamRetryInitialMs) cfg.streamRetryMaxMs = cfg.streamRetryInitialMs;
  if (cfg.streamRetryMaxAttempts < 1) cfg.streamRetryMaxAttempts = 1;
  if (cfg.circuitFailures < 1) cfg.circuitFailures = 1;
  return cfg;
}
