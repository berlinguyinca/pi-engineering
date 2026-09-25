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

import { isFlattenedInferWeaveRefusal, isGatewayAdmissionRefusal, isGatewayLinkCut } from "../gateway/signals.ts";
import { PERMANENT_ADMISSION_STATUSES } from "../inference/admissionContract.ts";

export type TransientErrorCategory =
  | "rate_limit" // 429 — too many requests / caller_concurrency admission
  | "server_unavailable" // 503 — no worker for model / service unavailable
  | "server_error" // other 5xx — transient upstream failure
  | "network" // ECONNRESET / ECONNREFUSED / fetch failed / DNS
  | "timeout" // wall-clock / provider deadline exceeded
  | "compaction" // summarization/context-overflow/compaction failure
  | "model_unavailable" // model_not_found / invalid model name — one resync retry, never the infra window
  | "permanent"; // NOT retryable — do not auto-retry

export interface ErrorClass {
  category: TransientErrorCategory;
  /** Whether this error should be retried automatically. */
  retryable: boolean;
  /** Provider-supplied Retry-After hint, if any (used in preference to backoff). */
  retryAfterMs?: number;
  /** Human-readable reason (first matching signal). */
  reason?: string;
  /**
   * Retry cap for this error, below the configured budget. Used where one
   * retry can help but more only hide the cause (an unknown model).
   */
  maxRetries?: number;
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

  // A gateway admission refusal that advertises its own wait belongs to the
  // admission controller, not here. Backing off exponentially against a 30s ask
  // — which is what this layer would do, since extractRetryAfterMs reads only a
  // header and this gateway puts `retry_after_ms` in the BODY — walks straight
  // back into the queue that just refused us, and gives up after maxAttempts.
  // Handing it over as non-retryable lets the worker loop honour the exact wait,
  // process-wide and without a ceiling. See src/gateway/signals.ts.
  if (isGatewayAdmissionRefusal(raw)) {
    return {
      category: "permanent",
      retryable: false,
      reason: "gateway admission refusal — handled by the admission controller",
    };
  }

  // 429 / rate limiting / concurrency admission (the user's "caller_concurrency").
  // Still ours: a rate limit with no gateway envelope advertises no wait, so
  // exponential backoff is the right answer.
  if (
    status === 429 ||
    has("too many requests", "rate limit", "rate limited", "caller_concurrency", "inference admission")
  ) {
    return { category: "rate_limit", retryable: true, retryAfterMs, reason: "rate-limit / concurrency admission" };
  }

  // Truncated streams: the provider closed the SSE stream before any
  // finish_reason arrived (observed on the metabolomics gateway under
  // momentary load — zero tokens, sub-second worker death). A fresh request
  // succeeds seconds later, so treat it as transient, not permanent. Checked
  // BEFORE the 503 branch because the executor's composite failure text
  // ("Worker returned no worker_result. Stream ended without finish_reason")
  // would otherwise false-match the "no worker" pattern.
  if (isTruncatedStream(raw) && !(status != null && PERMANENT_ADMISSION_STATUSES.includes(status))) {
    return {
      category: "server_error",
      retryable: true,
      retryAfterMs,
      reason: "truncated stream (no finish_reason)",
    };
  }

  // Text carrying an admission envelope is NOT ours for the rules below: the
  // structural admission contract decides it (a malformed or replay-unsafe
  // envelope is terminal), so re-reading its rendered text here would override
  // that fail-closed decision. A link cut ("…the response is incomplete…") is
  // not matched here either: the network branch owns it, behind
  // isGatewayLinkCut's guards.
  const carriesEnvelope = has("inferweave_backpressure", "inference_admission");

  // An unknown model: 404 model_not_found after a catalog shrink, or an
  // invalid-model-name 400 on the multimodal route. One retry covers a catalog
  // that has not resynced yet; a configuration typo never clears, so this is
  // NOT an infrastructure category — the mission scheduler would otherwise park
  // the task in its gateway window while the gateway answers perfectly well.
  if (!carriesEnvelope && has("model_not_found", "invalid model name")) {
    return {
      category: "model_unavailable",
      retryable: true,
      retryAfterMs,
      maxRetries: 1,
      reason: "unknown model (catalog resync or misconfiguration)",
    };
  }

  // Gateway routing failures (metabolomics/inferweave): expired routing
  // snapshots and flattened capacity backpressure (capacity_unavailable /
  // retry_alternate). Each clears on the next request (re-routed afresh /
  // alternate deployment) — retryable, bounded by the transient budget.
  // isFlattenedInferWeaveRefusal covers the remaining retryable pre-dispatch
  // codes (model_activating, queue_*) in the same shapes the interactive pump
  // recognises, so both layers agree on what is retryable.
  if (
    (!carriesEnvelope &&
      has("routing_snapshot_expired", "capacity_unavailable", "retry_alternate", "try another eligible deployment")) ||
    (isFlattenedInferWeaveRefusal(raw) && !(status != null && PERMANENT_ADMISSION_STATUSES.includes(status)))
  ) {
    return {
      category: "server_unavailable",
      retryable: true,
      retryAfterMs,
      reason: "gateway routing failure (snapshot/backpressure)",
    };
  }

  // 503 no worker for model / service unavailable / provider overload.
  //
  // "overloaded" is Anthropic's 529 wording and appears in pi-ai's own
  // retryable pattern list; without it here a text-only overload error fell
  // through every branch and was classified PERMANENT, so a worker gave up on a
  // failure that clears itself in seconds. Found by a boundary test written
  // after a fresh-context review.
  if (
    status === 503 ||
    status === 529 ||
    has("no worker", "service unavailable", "no available worker", "worker for model", "overloaded")
  ) {
    return { category: "server_unavailable", retryable: true, retryAfterMs, reason: "503 / overloaded / no worker" };
  }

  // Other 5xx.
  if (status != null && status >= 500 && status < 600) {
    return { category: "server_error", retryable: true, retryAfterMs, reason: `5xx (${status})` };
  }

  // Network-level failures, including a gateway link cut: a peer route that
  // ended before the response did. It carries no status (it arrives after a 200
  // head), so without this it fell through to "permanent" and workers gave up.
  if (
    (status == null && isGatewayLinkCut(raw)) ||
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

/**
 * pi-ai's openai-completions error when the SSE stream closes before any
 * finish_reason, verbatim. Anchored: at the start of the text (optionally
 * "Error: "-prefixed) or as the final sentence of the executor's composite
 * "Worker returned no worker_result. <error>" — never a phrase inside prose.
 */
const TRUNCATED_STREAM = /(?:^|\.\s+)(?:error:\s*)?stream ended without finish_reason\.?\s*$/i;

/**
 * True when a provider error is pi-ai's truncated-stream error. Shared by the
 * classifier and the executor, which sees it as an assistant-message error
 * rather than a throw. Fails closed like the link-cut rule: text carrying an
 * admission envelope or a leading permanent status is never a truncation.
 */
export function isTruncatedStream(text: string | undefined): boolean {
  if (!text || !TRUNCATED_STREAM.test(text.trim())) return false;
  if (/inferweave_backpressure|inference_admission/i.test(text)) return false;
  const lead = /^\s*(?:HTTP\s*)?(\d{3})\b/.exec(text);
  return !(lead && PERMANENT_ADMISSION_STATUSES.includes(Number.parseInt(lead[1]!, 10)));
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
      if (attempt >= Math.min(config.maxAttempts, cls.maxRetries ?? config.maxAttempts) + 1) {
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
