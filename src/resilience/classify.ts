/**
 * Error classification for mission-level resilience (resilience spec §4).
 *
 * Every LLM/gateway failure is classified into exactly one category so the
 * supervisor can choose the correct recovery path instead of blind-retrying:
 *
 *   TRANSIENT_INFRASTRUCTURE  -> WAITING_FOR_LLM (probe + retry within window)
 *   RATE_LIMITED              -> WAITING_FOR_CAPACITY (honour Retry-After)
 *   CONTEXT_RECOVERABLE       -> RECOVERING_CONTEXT (compact/summarize/externalize)
 *   AUTH_CONFIG               -> NEEDS_ATTENTION (no 90-min blind retry)
 *   INVALID_REQUEST           -> NEEDS_ATTENTION (no blind retry)
 *
 * Host-agnostic: classification inspects message text, HTTP status, and
 * structured error fields, so it works across the model runtime, HTTP clients,
 * and provider error objects.
 */

export type InfraErrorCategory =
  | "TRANSIENT_INFRASTRUCTURE"
  | "RATE_LIMITED"
  | "CONTEXT_RECOVERABLE"
  | "AUTH_CONFIG"
  | "INVALID_REQUEST";

/** Which mission state a category maps to (see spec §4). */
export const CATEGORY_TO_STATE: Record<InfraErrorCategory, string> = {
  TRANSIENT_INFRASTRUCTURE: "WAITING_FOR_LLM",
  RATE_LIMITED: "WAITING_FOR_CAPACITY",
  CONTEXT_RECOVERABLE: "RECOVERING_CONTEXT",
  AUTH_CONFIG: "NEEDS_ATTENTION",
  INVALID_REQUEST: "NEEDS_ATTENTION",
};

/** A classified error with the metadata the supervisor needs to recover. */
export interface InfraErrorClass {
  category: InfraErrorCategory;
  /** Whether the supervisor should retry within the retry window. */
  retryable: boolean;
  /** Provider-supplied wait hint, ms (honoured over the default probe interval). */
  retryAfterMs?: number;
  /** The gateway-reported scheduler state, when present (e.g. "relocating"). */
  scheduler_state?: string;
  /** The gateway request_id, when present. */
  request_id?: string;
  /** Human-readable reason. */
  reason?: string;
}

/** Statuses that indicate transient infrastructure unavailability. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

const AUTH_PATTERNS =
  /\b(unauthorized|forbidden|invalid[_ -]?api[_ -]?key|authentication|401|403|invalid[_ -]?credentials|api[_ -]?key[_ -]?invalid|permission[_ -]?denied|not[_ -]?authorized)\b/i;

const INVALID_PATTERNS =
  /\b(invalid[_ -]?request|malformed|unknown[_ -]?model|unsupported[_ -]?parameter|invalid[_ -]?model|bad[_ -]?request|400|schema[_ -]?error|no[_ -]?such[_ -]?model|invalid[_ -]?input)\b/i;

const CONTEXT_PATTERNS =
  /\b(context[_ -]?length|context[_ -]?exceeded|context[_ -]?window|maximum[_ -]?context|too[_ -]?many[_ -]?tokens|token[_ -]?budget|input[_ -]?too[_ -]?long|413|prompt[_ -]?is[_ -]?too[_ -]?long|context[_ -]?limit)\b/i;

const MODEL_STATES =
  /(relocat|load|cold[_ -]?start|unload|drain|restart|starting[_ -]?up|no[_ -]?worker|worker[_ -]?(down|restarting)|scheduler|placement|spinning[_ -]?up)/i;

function extractStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const e = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      httpStatus?: unknown;
    };
    const s = e.status ?? e.statusCode ?? e.response?.status ?? e.httpStatus;
    if (typeof s === "number") return s;
    if (typeof s === "string" && /^\d{3}$/.test(s)) return Number.parseInt(s, 10);
  }
  return null;
}

function extractString(error: unknown, keys: string[]): string | undefined {
  if (error && typeof error === "object") {
    for (const key of keys) {
      const v = (error as Record<string, unknown>)[key];
      if (typeof v === "string") return v;
    }
  }
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as {
    retry_after_ms?: unknown;
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    headers?: Record<string, unknown> | { get?: (k: string) => unknown };
  };
  for (const k of ["retry_after_ms", "retryAfterMs"] as const) {
    const v = e[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
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

/**
 * Classify an arbitrary thrown value into an infrastructure error category.
 * Pure and deterministic — never throws, never touches the network.
 */
export function classifyInfraError(error: unknown): InfraErrorClass {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const msg = raw.toLowerCase();
  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error);
  const scheduler_state = extractString(error, ["scheduler_state", "schedulerState"]);
  const request_id = extractString(error, ["request_id", "requestId"]);

  const has = (...needles: string[]) => needles.some((n) => msg.includes(n));

  // Auth/config errors never blind-retry for 90 minutes.
  if (status === 401 || status === 403 || AUTH_PATTERNS.test(raw)) {
    return { category: "AUTH_CONFIG", retryable: false, reason: "authentication / configuration" };
  }

  // Invalid request errors never blind-retry.
  if (status === 400 || INVALID_PATTERNS.test(raw)) {
    return { category: "INVALID_REQUEST", retryable: false, reason: "invalid request" };
  }

  // 413 / context overflow -> context recovery, NOT infrastructure retry.
  if (status === 413 || CONTEXT_PATTERNS.test(raw)) {
    return {
      category: "CONTEXT_RECOVERABLE",
      retryable: true,
      retryAfterMs,
      reason: "context overflow — recover context",
    };
  }

  // 429 rate-limit / concurrency admission -> WAITING_FOR_CAPACITY.
  if (status === 429 || has("too many requests", "rate limit", "rate limited", "caller_concurrency", "admission")) {
    return { category: "RATE_LIMITED", retryable: true, retryAfterMs, reason: "rate-limited / concurrency admission" };
  }

  // Gateway/model transient infrastructure.
  if (status != null && (TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600))) {
    return {
      category: "TRANSIENT_INFRASTRUCTURE",
      retryable: true,
      retryAfterMs,
      scheduler_state,
      request_id,
      reason: `transient infrastructure (${status})`,
    };
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
      "dns",
    )
  ) {
    return {
      category: "TRANSIENT_INFRASTRUCTURE",
      retryable: true,
      retryAfterMs,
      scheduler_state,
      request_id,
      reason: "network failure",
    };
  }

  // Timeouts.
  if (has("timed out", "timeout", "deadline exceeded", "etimedout", "aborted due to timeout")) {
    return {
      category: "TRANSIENT_INFRASTRUCTURE",
      retryable: true,
      retryAfterMs,
      scheduler_state,
      request_id,
      reason: "timeout",
    };
  }

  // Model loading / relocation wording (no HTTP status, scheduler-driven).
  if (MODEL_STATES.test(raw)) {
    return {
      category: "TRANSIENT_INFRASTRUCTURE",
      retryable: true,
      retryAfterMs,
      scheduler_state: scheduler_state ?? "model_transition",
      request_id,
      reason: "model loading / relocation",
    };
  }

  // Unknown -> conservative: transient (retry within window) but flagged.
  return {
    category: "TRANSIENT_INFRASTRUCTURE",
    retryable: true,
    retryAfterMs,
    scheduler_state,
    request_id,
    reason: "unclassified error",
  };
}
