/**
 * Retry-delay resolution (spec 02 §2).
 *
 * Precedence, first hit wins:
 *   1. `retry-after-ms` response header (milliseconds)
 *   2. `Retry-After` response header (delta-seconds or HTTP date)
 *   3. structured body field `retry_after_ms`
 *   4. local exponential backoff
 *
 * Every returned delay is clamped into `[minDelayMs, maxDelayMs]` and may carry
 * bounded positive jitter. Nothing here waits; it only computes.
 */

import { type AdmissionHeaders, headerGetter } from "./admissionContract.ts";

/** Where a resolved delay came from. */
export type RetryDelaySource = "retry-after-ms" | "retry-after-seconds" | "retry-after-date" | "body" | "backoff";

/** A resolved wait, with provenance. */
export interface RetryDelay {
  /** Final delay to sleep, after clamping and jitter. */
  delayMs: number;
  /** Which rule produced the delay. */
  source: RetryDelaySource;
  /** Server-directed delay before clamping/jitter, when one was supplied. */
  serverDelayMs?: number;
  /** True when a server-directed delay had to be clamped into policy bounds. */
  clamped?: boolean;
}

/** Bounds and backoff shape used to resolve a delay. */
export interface RetryDelayBounds {
  minDelayMs: number;
  maxDelayMs: number;
  baseBackoffMs: number;
  /** Ceiling for locally computed backoff (defaults to `maxDelayMs`). */
  maxBackoffMs?: number;
  /** Fraction of the delay added as positive jitter, 0..1. */
  jitterRatio: number;
  /** When false, server-directed hints are ignored in favour of backoff. */
  honorRetryAfter?: boolean;
}

/** Parse a `retry-after-ms` value: integer milliseconds, >= 0. */
export function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const ms = Number(trimmed);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** Parse a `Retry-After` value: delta-seconds or an HTTP date. */
export function parseRetryAfterHeader(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  // An HTTP date in the past means "retry now"; the caller clamps to minDelayMs.
  return Math.max(0, timestamp - nowMs);
}

/** The structured body field, when present and valid. */
export function bodyRetryAfterMs(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const raw = record.retry_after_ms ?? record.retryAfterMs;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Exponential backoff for `attempt` (1-based): base * 2^(attempt-1), capped. */
export function exponentialBackoffMs(attempt: number, baseBackoffMs: number, maxBackoffMs: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const raw = baseBackoffMs * 2 ** Math.min(exponent, 30);
  if (!Number.isFinite(raw)) return maxBackoffMs;
  return Math.min(Math.max(raw, 0), maxBackoffMs);
}

/** Clamp a delay into `[min, max]`, tolerating inverted bounds defensively. */
export function clampDelay(ms: number, minMs: number, maxMs: number): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(lo, maxMs);
  if (!Number.isFinite(ms)) return lo;
  return Math.min(Math.max(ms, lo), hi);
}

/**
 * Add bounded positive jitter: the result is in `[delayMs, delayMs*(1+ratio)]`.
 *
 * Jitter is positive-only so a server-directed wait is never shortened below
 * what the server asked for.
 */
export function addBoundedJitter(delayMs: number, jitterRatio: number, random: () => number = Math.random): number {
  if (!(jitterRatio > 0)) return delayMs;
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(delayMs * (1 + jitterRatio * r));
}

/** Input for one delay resolution. */
export interface ResolveRetryDelayInput {
  headers?: AdmissionHeaders;
  /** Parsed structured body (typically the admission payload object). */
  body?: unknown;
  /** 1-based attempt number that produced the rejection. */
  attempt: number;
  bounds: RetryDelayBounds;
  /** Clock used for HTTP-date `Retry-After` values. */
  nowMs?: number;
  /** Jitter source (injectable for deterministic tests). */
  random?: () => number;
}

function fromServer(
  source: RetryDelaySource,
  serverDelayMs: number,
  bounds: RetryDelayBounds,
  input: ResolveRetryDelayInput,
): RetryDelay {
  const clampedMs = clampDelay(serverDelayMs, bounds.minDelayMs, bounds.maxDelayMs);
  return {
    delayMs: addBoundedJitter(clampedMs, bounds.jitterRatio, input.random ?? Math.random),
    source,
    serverDelayMs,
    ...(clampedMs !== serverDelayMs ? { clamped: true } : {}),
  };
}

/**
 * Resolve the wait before the next attempt, following the precedence chain.
 *
 * A server-directed delay outside `[minDelayMs, maxDelayMs]` is clamped rather
 * than dropped, and the result is flagged so telemetry can report the
 * disagreement with the server.
 */
export function resolveRetryDelay(input: ResolveRetryDelayInput): RetryDelay {
  const { bounds } = input;
  if (bounds.honorRetryAfter !== false) {
    const get = headerGetter(input.headers);

    const msHeader = parseRetryAfterMsHeader(get("retry-after-ms"));
    if (msHeader !== undefined) return fromServer("retry-after-ms", msHeader, bounds, input);

    const retryAfter = get("retry-after");
    if (retryAfter !== undefined) {
      const seconds = parseRetryAfterMsHeader(retryAfter);
      if (seconds !== undefined) return fromServer("retry-after-seconds", seconds * 1000, bounds, input);
      const dateMs = parseRetryAfterHeader(retryAfter, input.nowMs ?? Date.now());
      if (dateMs !== undefined) return fromServer("retry-after-date", dateMs, bounds, input);
    }

    const fromBody = bodyRetryAfterMs(input.body);
    if (fromBody !== undefined) return fromServer("body", fromBody, bounds, input);
  }

  const backoff = exponentialBackoffMs(input.attempt, bounds.baseBackoffMs, bounds.maxBackoffMs ?? bounds.maxDelayMs);
  return {
    delayMs: addBoundedJitter(
      clampDelay(backoff, bounds.minDelayMs, bounds.maxDelayMs),
      bounds.jitterRatio,
      input.random ?? Math.random,
    ),
    source: "backoff",
  };
}
