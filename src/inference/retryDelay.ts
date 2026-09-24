/**
 * Retry-delay resolution (spec 02 §2).
 *
 * All valid server hints are parsed and the largest is the minimum wait.
 * Local exponential backoff is used only when no valid server hint exists.
 *
 * Server minima are never clamped downward. Local backoff remains bounded.
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
  /** True when a server delay below the local minimum was raised. */
  clamped?: boolean;
}

export type WaitDecision = { action: "wait"; waitMs: number } | { action: "stop"; reason: "budget_elapsed" };

/** Preserve server minima: stop instead of shortening a wait that cannot fit. */
export function decideWait(input: {
  serverMinimumMs?: number;
  proposedMs: number;
  remainingMs: number;
}): WaitDecision {
  if (input.serverMinimumMs !== undefined && input.serverMinimumMs > input.remainingMs) {
    return { action: "stop", reason: "budget_elapsed" };
  }
  const waitMs = Math.min(input.proposedMs, input.remainingMs);
  return waitMs > 0 ? { action: "wait", waitMs } : { action: "stop", reason: "budget_elapsed" };
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
  // maxDelayMs bounds local policy, never a server-declared minimum.
  const clampedMs = Math.max(serverDelayMs, Math.max(0, bounds.minDelayMs));
  return {
    delayMs: addBoundedJitter(clampedMs, bounds.jitterRatio, input.random ?? Math.random),
    source,
    serverDelayMs,
    ...(clampedMs !== serverDelayMs ? { clamped: true } : {}),
  };
}

/**
 * Resolve the wait before the next attempt, choosing the largest valid server
 * minimum and otherwise using bounded local backoff.
 */
export function resolveRetryDelay(input: ResolveRetryDelayInput): RetryDelay {
  const { bounds } = input;
  if (bounds.honorRetryAfter !== false) {
    const get = headerGetter(input.headers);

    const candidates: Array<{ source: RetryDelaySource; ms: number }> = [];
    const msHeader = parseRetryAfterMsHeader(get("retry-after-ms"));
    if (msHeader !== undefined) candidates.push({ source: "retry-after-ms", ms: msHeader });
    const retryAfter = get("retry-after");
    if (retryAfter !== undefined) {
      const seconds = parseRetryAfterMsHeader(retryAfter);
      if (seconds !== undefined) candidates.push({ source: "retry-after-seconds", ms: seconds * 1000 });
      else {
        const dateMs = parseRetryAfterHeader(retryAfter, input.nowMs ?? Date.now());
        if (dateMs !== undefined) candidates.push({ source: "retry-after-date", ms: dateMs });
      }
    }
    const fromBody = bodyRetryAfterMs(input.body);
    if (fromBody !== undefined) candidates.push({ source: "body", ms: fromBody });
    const largest = candidates.reduce<{ source: RetryDelaySource; ms: number } | undefined>(
      (best, candidate) => (!best || candidate.ms > best.ms ? candidate : best),
      undefined,
    );
    if (largest) return fromServer(largest.source, largest.ms, bounds, input);
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
