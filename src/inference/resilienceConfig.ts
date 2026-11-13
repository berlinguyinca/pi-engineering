/**
 * Resilient-inference configuration (fault-tolerance spec §21/§25).
 *
 * Normalizes the PI_INFERENCE_* variables and reuses the existing
 * PI_GATEWAY_* variables for long-duration outages instead of duplicating
 * their semantics:
 *
 *   PI_INFERENCE_RESILIENCE_ENABLED         master switch (default off; affirmative 1/true/yes/on arms it)
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
 * Boolean switches are tri-state: `1/true/yes/on` is on, `false/0/off` is off
 * (any case, surrounding space ignored), unset is the documented default, and a
 * value that is neither — `diable`, `ture`, `no` — is also the documented default
 * and is listed in `unparseableSwitches`. A value we cannot read is never read as
 * "on", so a mistyped disable cannot leave an intervention armed unnoticed.
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
  /**
   * Switch values that were set but are neither canonical-affirmative nor
   * canonical-negative — e.g. `PI_INFERENCE_STREAM_RETRY_ENABLED=diable`. Each
   * entry is `NAME=value`. The resolved value for such a switch is its default,
   * never a guess: a mistyped disable must not silently leave an intervention
   * armed and a mistyped enable must not silently arm one. Optional so every
   * existing literal of this type keeps compiling; absent means "nothing was
   * mistyped".
   */
  unparseableSwitches?: string[];
}

export const DEFAULT_INFERENCE_RESILIENCE: InferenceResilienceConfig = {
  enabled: false,
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

/** Canonical on spellings. */
const AFFIRMATIVE = /^(1|true|yes|on)$/i;
/** Canonical off spellings — deliberately the same narrow set the parser has always used. */
const NEGATIVE = /^(false|0|off)$/i;

/** A token that is neither AFFIRMATIVE nor NEGATIVE; recorded, never guessed at. */
type SwitchProblems = string[];

function report(problems: SwitchProblems | undefined, name: string, value: string): void {
  problems?.push(`${name}=${value}`);
}

/**
 * Tri-state boolean switch: `1/true/yes/on` is on, `false/0/off` is off (any
 * case, surrounding space ignored), unset or empty is `fallback`, and anything
 * else — `diable`, `ture`, `no` — is also `fallback`, plus a note in `problems`.
 *
 * Resolving an unrecognised token to `fallback` rather than to `true` is the
 * point: the previous parser returned true for every value outside its negative
 * set, so a mistyped disable left the intervention on and nothing said so. For
 * the switches that default to true the resolved value is unchanged; the gain is
 * that the mistake becomes visible, and a default-off switch can no longer be
 * armed by a typo.
 */
function bool(value: string | undefined, fallback: boolean, name: string, problems?: SwitchProblems): boolean {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return fallback;
  if (AFFIRMATIVE.test(trimmed)) return true;
  if (NEGATIVE.test(trimmed)) return false;
  report(problems, name, trimmed);
  return fallback;
}

/**
 * Affirmative-only switch (1/true/yes/on, any case); anything else is off.
 * Used where behaviour changes only on explicit opt-in: the master switch and
 * the interactive fallback. A token that is not even affirmative is reported,
 * so an operator who meant to arm it learns the arm did not take.
 */
function optIn(value: string | undefined, name: string, problems?: SwitchProblems): boolean {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return false;
  if (AFFIRMATIVE.test(trimmed)) return true;
  if (!NEGATIVE.test(trimmed)) report(problems, name, trimmed);
  return false;
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
  const problems: SwitchProblems = [];
  // Intervention stays off until the operator asks for it (05-IMPLEMENTATION-SECURITY.md:13), and
  // only an affirmative value arms it: a typo such as "ture" must not arm resilience silently.
  cfg.enabled = optIn(env.PI_INFERENCE_RESILIENCE_ENABLED, "PI_INFERENCE_RESILIENCE_ENABLED", problems);
  cfg.streamRetryEnabled = bool(
    env.PI_INFERENCE_STREAM_RETRY_ENABLED,
    cfg.streamRetryEnabled,
    "PI_INFERENCE_STREAM_RETRY_ENABLED",
    problems,
  );
  cfg.streamRetryInitialMs = parseRetryDurationMs(env.PI_INFERENCE_STREAM_RETRY_INITIAL, cfg.streamRetryInitialMs);
  cfg.streamRetryMaxMs = parseRetryDurationMs(env.PI_INFERENCE_STREAM_RETRY_MAX, cfg.streamRetryMaxMs);
  cfg.streamRetryMaxAttempts = int(env.PI_INFERENCE_STREAM_RETRY_ATTEMPTS, cfg.streamRetryMaxAttempts);
  cfg.circuitFailures = int(env.PI_INFERENCE_CIRCUIT_FAILURES, cfg.circuitFailures);
  cfg.circuitWindowMs = parseRetryDurationMs(env.PI_INFERENCE_CIRCUIT_WINDOW, cfg.circuitWindowMs);
  cfg.circuitCooldownMs = parseRetryDurationMs(env.PI_INFERENCE_CIRCUIT_COOLDOWN, cfg.circuitCooldownMs);
  const workerFallback = env.PI_INFERENCE_MODEL_FALLBACK ?? env.PI_GATEWAY_MODEL_FALLBACK_ENABLED;
  const workerFallbackName =
    env.PI_INFERENCE_MODEL_FALLBACK !== undefined ? "PI_INFERENCE_MODEL_FALLBACK" : "PI_GATEWAY_MODEL_FALLBACK_ENABLED";
  cfg.modelFallbackForWorkers = bool(workerFallback, cfg.modelFallbackForWorkers, workerFallbackName, problems);
  cfg.modelFallbackInteractive = optIn(
    env.PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE,
    "PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE",
    problems,
  );
  cfg.fallbackSameProviderOnly = bool(
    env.PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY,
    cfg.fallbackSameProviderOnly,
    "PI_INFERENCE_FALLBACK_SAME_PROVIDER_ONLY",
    problems,
  );
  cfg.catalogRefreshOnNoWorkers = bool(
    env.PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS,
    cfg.catalogRefreshOnNoWorkers,
    "PI_INFERENCE_CATALOG_REFRESH_ON_NO_WORKERS",
    problems,
  );
  cfg.activationFallbackAfterMs = parseRetryDurationMs(
    env.PI_INFERENCE_ACTIVATION_FALLBACK_AFTER,
    cfg.activationFallbackAfterMs,
  );
  cfg.unavailabilityPenaltyMs = parseRetryDurationMs(env.PI_INFERENCE_UNAVAILABLE_PENALTY, cfg.unavailabilityPenaltyMs);

  if (problems.length > 0) cfg.unparseableSwitches = problems;

  if (overrides) Object.assign(cfg, overrides);
  // Sanity: the ceiling must not sit below the first rung of the ladder.
  if (cfg.streamRetryMaxMs < cfg.streamRetryInitialMs) cfg.streamRetryMaxMs = cfg.streamRetryInitialMs;
  if (cfg.streamRetryMaxAttempts < 1) cfg.streamRetryMaxAttempts = 1;
  if (cfg.circuitFailures < 1) cfg.circuitFailures = 1;
  return cfg;
}

/**
 * Status lines for the switches whose value could not be read.
 *
 * A mistyped disable resolves to the documented default, which is safe but
 * silent, and silence is how an operator ends up believing `diable` armed
 * something when it armed nothing. Every entry point that resolves this config
 * renders through this one function so the wording is identical wherever it
 * surfaces.
 */
export function describeUnparseableSwitches(config: InferenceResilienceConfig): string[] {
  return (config.unparseableSwitches ?? []).map(
    (entry) => `unrecognized inference-resilience switch ${entry} · the default is in force`,
  );
}
