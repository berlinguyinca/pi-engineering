/**
 * Backpressure signal classifier (MODEL-003, MODEL-007).
 *
 * InferWeave and the gateways in front of it answer with backpressure codes
 * that split into three distinct recovery families:
 *
 *   quota    — the CALLER is over their fair share (caller_concurrency,
 *              caller_queue_full, or a bare 429 with no code). Waiting on the
 *              same endpoint is correct, so we must NOT be rerouted.
 *   capacity — the INFRASTRUCTURE is saturated (capacity_unavailable,
 *              backend_saturated, or the gateway explicitly asks for
 *              action=retry_alternate). The request may be served elsewhere,
 *              so an alternate backend is the right move.
 *   context  — the request's context is too big / no backend can hold it
 *              (context_capacity, model_context_exceeded,
 *              no_context_capable_backend). Shrinking the context is the only
 *              productive recovery.
 *
 * Observed real sample (see reports/logs/02-baseline-real-attempt1 stderr):
 *   {status:429, reason:"capacity_unavailable", retryAfterMs:20000,
 *    retryable:true, action:"retry_alternate", replaySafe:true}
 *
 * This module is pure: it turns a status/header/body triple into a structured
 * signal and never sleeps, throws, or touches the network.
 */

import { parseRetryAfterHeader } from "../inference/retryDelay.ts";

/** Recovery family the backpressure signal belongs to. */
export type BackpressureKind = "quota" | "capacity" | "context" | "unknown";

/** What the caller should do next. */
export type BackpressureAction = "wait_same" | "retry_alternate" | "shrink_context" | "block" | "none";

/** Structured classification of a gateway backpressure response. */
export interface BackpressureSignal {
  kind: BackpressureKind;
  action: BackpressureAction;
  /** How long to wait before retrying, in milliseconds (null when unknown). */
  waitMs: number | null;
  /** Whether replaying the request is safe (no partial output committed). */
  replaySafe: boolean;
  /** The gateway-reported reason/code token, e.g. "capacity_unavailable". */
  reason: string;
}

export interface ClassifyBackpressureInput {
  status: number | string;
  headers?: Record<string, string> | Headers;
  body?: unknown;
}

const CAPACITY_CODES = new Set(["capacity_unavailable", "backend_saturated"]);

/** Ceiling for any computed wait hint, in milliseconds. */
export const MAX_WAIT_MS = 600000;
const QUOTA_CODES = new Set(["caller_concurrency", "caller_queue_full"]);
const CONTEXT_CODES = new Set(["context_capacity", "model_context_exceeded", "no_context_capable_backend"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The machine code/reason token carried by the body (code, else reason). */
function codeOf(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  return nonEmptyString(record.code) ?? nonEmptyString(record.reason);
}

/** The gateway-directed action token (e.g. "retry_alternate"). */
function actionOf(body: unknown): string | undefined {
  const record = asRecord(body);
  return record ? nonEmptyString(record.action) : undefined;
}

/**
 * Read the `Retry-After` header case-insensitively from either a plain object
 * or a `Headers` instance.
 */
function retryAfterFrom(headers?: Record<string, string> | Headers): string | undefined {
  if (headers == null || typeof headers !== "object") return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("retry-after") ?? undefined;
  }
  const record = headers as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "retry-after") return value;
  }
  return undefined;
}

/**
 * Wait hint: body field, else Retry-After header seconds, else null.
 *
 * The result is always a finite non-negative integer capped at MAX_WAIT_MS,
 * or null when no valid hint is present (blank or non-numeric body fields,
 * negative values, and unparseable headers all yield null).
 */
function waitMsOf(body: unknown, headers?: Record<string, string> | Headers): number | null {
  const record = asRecord(body);
  if (record) {
    const raw = record.retry_after_ms ?? record.retryAfterMs;
    const value = typeof raw === "string" ? Number(raw) : raw;
    // Number("") is 0, which is not a valid hint here; only accept non-blank
    // numeric strings (and numeric values).
    const blankString = typeof raw === "string" && raw.trim() === "";
    if (!blankString && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.min(Math.floor(value), MAX_WAIT_MS);
    }
  }
  const retryAfter = retryAfterFrom(headers);
  if (retryAfter !== undefined) {
    const ms = parseRetryAfterHeader(retryAfter);
    if (ms !== undefined) {
      return Math.min(Math.floor(ms), MAX_WAIT_MS);
    }
  }
  return null;
}

/**
 * Normalise the status: accept a numeric string, and treat NaN, negative or
 * non-finite values as absent (so the signal is classified as unknown).
 */
function normalizedStatus(status: number | string): number | undefined {
  const value = typeof status === "string" ? Number(status) : status;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Whether replaying the request is safe. Explicit `replaySafe` wins; absent
 * that, `requestState === "not_started"` means nothing was committed.
 */
function replaySafeOf(body: unknown): boolean {
  const record = asRecord(body);
  if (!record) return false;
  const replaySafe = record.replay_safe ?? record.replaySafe;
  if (typeof replaySafe === "boolean") return replaySafe;
  return record.request_state === "not_started" || record.requestState === "not_started";
}

/** Classify a backpressure response into a recovery signal. */
export function classifyBackpressure(input: unknown): BackpressureSignal {
  // Non-object inputs (null, undefined, primitives) are unrecognised signals.
  if (typeof input !== "object" || input === null) {
    return { kind: "unknown", action: "none", waitMs: null, replaySafe: false, reason: "unknown" };
  }
  const { status: statusInput, body, headers } = input as ClassifyBackpressureInput;
  const status = normalizedStatus(statusInput);
  const code = codeOf(body);
  const action = actionOf(body);
  const reason = code ?? "unknown";

  // Context problems are terminal for the current context: only shrinking it
  // can help, and no amount of rerouting or waiting will.
  if ((status === 429 || status === 503) && code !== undefined && CONTEXT_CODES.has(code)) {
    return {
      kind: "context",
      action: "shrink_context",
      waitMs: waitMsOf(body, headers),
      replaySafe: replaySafeOf(body),
      reason,
    };
  }

  // Infrastructure capacity: reroutable, and the gateway may say so explicitly.
  if (
    (status === 429 || status === 503) &&
    ((code !== undefined && CAPACITY_CODES.has(code)) || action === "retry_alternate")
  ) {
    return {
      kind: "capacity",
      action: "retry_alternate",
      waitMs: waitMsOf(body, headers),
      replaySafe: replaySafeOf(body),
      reason,
    };
  }

  // Caller quota / fair-share: must NOT be rerouted; wait on the same endpoint.
  if (status === 429 && (code === undefined || QUOTA_CODES.has(code))) {
    return {
      kind: "quota",
      action: "wait_same",
      waitMs: waitMsOf(body, headers),
      replaySafe: replaySafeOf(body),
      reason,
    };
  }

  return {
    kind: "unknown",
    action: "none",
    waitMs: waitMsOf(body, headers),
    replaySafe: replaySafeOf(body),
    reason,
  };
}
