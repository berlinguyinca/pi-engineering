/**
 * Transient error recovery — automatic retry with backoff for infrastructure
 * failures that are NOT model degeneration.
 *
 * The GenerationGuard / RecoveryController ladder handles a *degenerate model*
 * (repetition, no progress, excessive narration). This module handles the
 * orthogonal failure class: the model/provider being temporarily unavailable or
 * rate-limited — 503 "no worker for model", 429 "inference admission:
 * caller_concurrency", network errors, wall-clock timeouts, and
 * context/compaction failures. These are transient by nature and are recovered
 * automatically with bounded exponential backoff + jitter, never by failing a
 * worker outright.
 *
 * Pure and deterministic: every function takes an injectable clock / RNG /
 * sleep so tests can exercise backoff and retry loops without sleeping.
 */

export type TransientErrorCategory =
  | "rate_limit" // 429 — too many requests / caller_concurrency admission
  | "server_unavailable" // 503 — no worker for model / service unavailable
  | "server_error" // other 5xx — transient upstream failure
  | "network" // ECONNRESET / ECONNREFUSED / fetch failed / DNS
  | "timeout" // wall-clock / provider deadline exceeded
  | "compaction" // summarization/context-overflow/compaction failure
  | "permanent"; // NOT retryable — do not auto-retry

export interface ErrorClass {
  category: TransientErrorCategory;
  /** Whether this error should be retried automatically. */
  retryable: boolean;
  /** Provider-supplied Retry-After hint, if any (used in preference to backoff). */
  retryAfterMs?: number;
  /** Human-readable reason (first matching signal). */
  reason?: string;
}

/** A structured error wrapper carrying the classified category. */
export class TransientError extends Error {
  readonly category: TransientErrorCategory;
  readonly attempts: number;
  constructor(category: TransientErrorCategory, message: string, attempts: number, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "TransientError";
    this.category = category;
    this.attempts = attempts;
  }
}

/**
 * Classify an arbitrary thrown value into a transient-error class.
 * Message/status-based and host-agnostic: it does not depend on a particular
 * provider SDK, so the same classifier works across the model runtime, HTTP
 * clients, and provider error objects.
 */
export function classifyError(error: unknown): ErrorClass {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const msg = raw.toLowerCase();
  const status = extractStatus(error);

  // Provider-supplied Retry-After header (seconds).
  const retryAfterMs = extractRetryAfterMs(error);

  const has = (...needles: string[]) => needles.some((n) => msg.includes(n));

  // 429 / rate limiting / concurrency admission (the user's "caller_concurrency").
  if (
    status === 429 ||
    has("too many requests", "rate limit", "rate limited", "caller_concurrency", "inference admission")
  ) {
    return { category: "rate_limit", retryable: true, retryAfterMs, reason: "rate-limit / concurrency admission" };
  }

  // 503 no worker for model / service unavailable.
  if (status === 503 || has("no worker", "service unavailable", "no available worker", "worker for model")) {
    return { category: "server_unavailable", retryable: true, retryAfterMs, reason: "503 / no worker" };
  }

  // Other 5xx.
  if (status != null && status >= 500 && status < 600) {
    return { category: "server_error", retryable: true, retryAfterMs, reason: `5xx (${status})` };
  }

  // Network-level failures.
  if (
    has(
      "econnreset",
      "econnrefused",
      "enotfound",
      "enetunreach",
      "eai_again",
      "fetch failed",
      "socket hang up",
      "network",
      "undici",
    )
  ) {
    return { category: "network", retryable: true, retryAfterMs, reason: "network failure" };
  }

  // Timeouts.
  if (has("timed out", "timeout", "deadline exceeded", "etimedout", "aborted due to timeout")) {
    return { category: "timeout", retryable: true, retryAfterMs, reason: "timeout" };
  }

  // Compaction / context-overflow / summarization failure.
  if (
    has("summariz", "compaction", "compacted", "token cap", "context overflow", "context limit", "incomplete summary")
  ) {
    return { category: "compaction", retryable: true, retryAfterMs, reason: "compaction / context-overflow" };
  }

  return { category: "permanent", retryable: false, reason: "permanent error" };
}

function extractStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const s = e.status ?? e.statusCode ?? e.response?.status;
    if (typeof s === "number") return s;
    if (typeof s === "string" && /^\d{3}$/.test(s)) return Number.parseInt(s, 10);
  }
  return null;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as {
    retryAfter?: unknown;
    headers?: Record<string, unknown> | { get?: (k: string) => unknown };
  };
  const ra = e.retryAfter;
  if (typeof ra === "number") return ra * 1000;
  if (typeof ra === "string") {
    const n = Number.parseFloat(ra);
    if (Number.isFinite(n)) return n * 1000;
  }
  const h = e.headers;
  const val =
    typeof h?.get === "function" ? h.get("retry-after") : (h as Record<string, unknown> | undefined)?.["retry-after"];
  if (typeof val === "string") {
    const n = Number.parseFloat(val);
    if (Number.isFinite(n)) return n * 1000;
  }
  return undefined;
}

// ─── Backoff schedule ────────────────────────────────────────────────────────

export interface BackoffConfig {
  /** Base delay for the first retry, ms. */
  baseMs: number;
  /** Maximum delay cap, ms. */
  maxMs: number;
  /** Exponential factor per attempt. */
  factor: number;
  /** Jitter fraction (0..1) of the nominal delay to add. 0 = deterministic. */
  jitter: number;
  /** Maximum number of retry attempts (beyond the initial call). */
  maxAttempts: number;
}

export const DEFAULT_TRANSIENT_RETRY_CONFIG: BackoffConfig = {
  baseMs: 1000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 4,
};

/** Resolve backoff config from environment (PI_GUARD_TRANSIENT_*). */
export function resolveTransientRetryConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): BackoffConfig {
  const cfg: BackoffConfig = { ...DEFAULT_TRANSIENT_RETRY_CONFIG };
  const num = (k: string): number | undefined => {
    const v = env[k];
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const base = num("PI_GUARD_TRANSIENT_BASE_MS");
  const max = num("PI_GUARD_TRANSIENT_MAX_MS");
  const factor = num("PI_GUARD_TRANSIENT_FACTOR");
  const jitter = num("PI_GUARD_TRANSIENT_JITTER");
  const attempts = num("PI_GUARD_TRANSIENT_MAX_ATTEMPTS");
  if (base != null) cfg.baseMs = base;
  if (max != null) cfg.maxMs = max;
  if (factor != null && factor >= 1) cfg.factor = factor;
  if (jitter != null && jitter <= 1) cfg.jitter = jitter;
  if (attempts != null) cfg.maxAttempts = attempts;
  return cfg;
}

/**
 * Exponential backoff delay for the Nth retry (attempt is 1-based: the first
 * retry uses attempt=1). Full jitter is applied when jitter > 0, scaled by the
 * configured fraction, then clamped to `maxMs`.
 */
export function backoffDelayMs(attempt: number, config: BackoffConfig, rand: () => number = Math.random): number {
  const n = attempt < 1 ? 1 : attempt;
  const nominal = config.baseMs * config.factor ** (n - 1);
  let delay = nominal;
  if (config.jitter > 0) {
    const jitterAmount = nominal * config.jitter * rand();
    delay += jitterAmount;
  }
  return Math.min(config.maxMs, delay);
}

// ─── Retry loop ──────────────────────────────────────────────────────────────

export interface RetryOutcome<T> {
  /** The value returned by fn, if it eventually succeeded. */
  value: T | undefined;
  /** The last error thrown, if attempts were exhausted. */
  error: unknown;
  /** Total attempts performed (1 = initial call only). */
  attempts: number;
  /** The classified category of the error that exhausted retries (if any). */
  category?: TransientErrorCategory;
}

export interface RetryOptions<T> {
  fn: (attempt: number) => Promise<T>;
  config?: BackoffConfig;
  classify?: (error: unknown) => ErrorClass;
  /** Injectable sleep; defaults to real setTimeout. Deterministic in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG; deterministic in tests. */
  rand?: () => number;
}

/**
 * Run `fn` and retry with bounded exponential backoff + jitter while it throws
 * a *retryable* error (rate limit, no-worker, network, timeout, compaction).
 * Non-retryable errors (permanent) fail immediately without retrying. A
 * provider `retryAfterMs` hint overrides the computed backoff delay.
 *
 * Never throws: returns a `RetryOutcome` describing the result.
 */
export async function withTransientRetry<T>(opts: RetryOptions<T>): Promise<RetryOutcome<T>> {
  const config = opts.config ?? DEFAULT_TRANSIENT_RETRY_CONFIG;
  const classify = opts.classify ?? classifyError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = opts.rand ?? Math.random;

  let lastError: unknown;
  let attempts = 0;
  let lastCategory: TransientErrorCategory | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts + 1; attempt++) {
    attempts = attempt;
    try {
      const value = await opts.fn(attempt);
      return { value, error: undefined, attempts };
    } catch (err) {
      lastError = err;
      const cls = classify(err);
      lastCategory = cls.category;
      if (!cls.retryable) {
        // Permanent error: do not retry.
        return { value: undefined, error: err, attempts, category: cls.category };
      }
      if (attempt >= config.maxAttempts + 1) {
        // Exhausted retries.
        return { value: undefined, error: err, attempts, category: cls.category };
      }
      const delay = cls.retryAfterMs ?? backoffDelayMs(attempt, config, rand);
      await sleep(delay);
    }
  }

  return { value: undefined, error: lastError, attempts, category: lastCategory };
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

export interface TransientTelemetry {
  /** Total transient errors encountered. */
  errors: number;
  /** Total successful recoveries after one or more retries. */
  recovered: number;
  /** Total exhausted (gave up after maxAttempts). */
  exhausted: number;
  /** Per-category error counts. */
  byCategory: Record<string, number>;
}

export function initialTransientTelemetry(): TransientTelemetry {
  return { errors: 0, recovered: 0, exhausted: 0, byCategory: {} };
}

export function recordTransientError(t: TransientTelemetry, category: TransientErrorCategory): void {
  t.errors++;
  t.byCategory[category] = (t.byCategory[category] ?? 0) + 1;
}

export function recordTransientOutcome(
  t: TransientTelemetry,
  recovered: boolean,
  category: TransientErrorCategory,
): void {
  if (recovered) t.recovered++;
  else t.exhausted++;
  t.byCategory[category] = (t.byCategory[category] ?? 0) + 1;
}
