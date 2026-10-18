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

import { isGatewayLinkCut } from "../gateway/signals.ts";

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

const BODY_TOO_LARGE =
  /request body too large|payload too large|request entity too large|body too large|\brequest_too_large\b/i;
const CONTEXT_WORDING =
  /context[_ -]?(length|window|limit|exceeded)|maximum[_ -]?context|too[_ -]?many[_ -]?tokens|prompt[_ -]?is[_ -]?too[_ -]?long|input[_ -]?too[_ -]?long/i;

const MODEL_STATES =
  /(relocat|load|cold[_ -]?start|unload|drain|restart|starting[_ -]?up|no[_ -]?worker|worker[_ -]?(down|restarting)|scheduler|placement|spinning[_ -]?up)/i;

/** Node errno codes that indicate a local storage/disk condition (recoverable). */
const STORAGE_CODES = new Set(["ENOSPC", "ENOMEM", "EIO", "EFBIG", "EROFS", "EDQUOT"]);

function isStorageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && STORAGE_CODES.has(code);
}

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

  // A body-size 413 (the gateway's byte cap, or our own preflight refusing to
  // send) is not a context problem and not transient: resending the same body
  // fails the same way. The live path already shrinks what it can before
  // sending (src/request/bodyBudget.ts), so what is left needs a person.
  if (BODY_TOO_LARGE.test(raw) && !CONTEXT_WORDING.test(raw)) {
    return { category: "INVALID_REQUEST", retryable: false, reason: "request body exceeds the gateway's size cap" };
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

  // Gateway link cut: a peer route ended mid-response. Status-less (it follows
  // a 200 head) and replayable, so name it rather than leaving it to the
  // unclassified fallback.
  if (status == null && isGatewayLinkCut(raw)) {
    return {
      category: "TRANSIENT_INFRASTRUCTURE",
      retryable: true,
      retryAfterMs,
      scheduler_state,
      request_id,
      reason: "gateway link cut",
    };
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

  // Local storage / disk errors (ENOSPC 'no space left on device', ENOMEM,
  // EIO, EFBIG, EROFS, EDQUOT). These are infrastructure failures that become
  // retryable once the disk recovers; they must NOT fall through to a terminal
  // FAILED (which is unrecoverable). The supervisor parks and retries within the
  // window; the write is retried once space frees.
  if (isStorageError(error) || has("no space left on device", "enospc", "disk full", "storage")) {
    return {
      category: "TRANSIENT_INFRASTRUCTURE",
      retryable: true,
      retryAfterMs,
      scheduler_state,
      request_id,
      reason: "storage / disk space",
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

/* -------------------------------------------------------------------------- *
 * Disk-pressure classification (disk-pressure recovery spec).
 *
 * A write can fail for reasons other than a shortage of free bytes: exhausted
 * inodes, a per-directory quota, a read-only remount, a container-layer
 * barrier, or reserved root blocks. The operator must not treat a healthy `/`
 * as proof a separate output mount is healthy, and the system must not
 * blind-retry a condition that only an operator can clear. This module turns a
 * raw storage failure into a typed incident the suspension/recovery machinery
 * can act on deterministically.
 * -------------------------------------------------------------------------- */

export type StoragePressureCategory =
  | "DISK_FULL" // no free bytes (ENOSPC) — auto-recovers once space frees
  | "INODE_EXHAUSTED" // no free inodes — auto-recovers once inodes free
  | "QUOTA_EXCEEDED" // per-directory quota (EDQUOT) — auto-recovers once quota lifts
  | "READ_ONLY_FS" // EROFS / read-only remount — needs an operator to remount
  | "IO_ERROR" // EIO / EFBIG — conservative, probe-based
  | "UNKNOWN_STORAGE"; // unclassified storage errno

/** How the incident clears: by itself, or only after an operator acts. */
export type StorageRecoveryClass = "AUTO" | "OPERATOR" | "CONSERVATIVE";

/**
 * Typed result of classifying a storage failure. Used to decide whether to
 * suspend a mission (auto-recover via probes) or surface an operator action.
 */
export interface StoragePressureIncident {
  category: StoragePressureCategory;
  recovery: StorageRecoveryClass;
  /** The errno code that triggered classification, e.g. "ENOSPC". */
  code: string;
  /** Human-readable reason for status surfaces. */
  reason: string;
  /** True when the mission should suspend and auto-resume via probes. */
  autoRecover: boolean;
  /** True when an operator action is required before resuming. */
  needsOperator: boolean;
  /** The filesystem/volume path the failure targeted, when known. */
  path?: string;
  /** Free bytes at detection, when supplied by the caller. */
  freeBytes?: number;
  /** Required bytes, when known. */
  requiredBytes?: number;
  /** Free inodes at detection, when supplied by the caller. */
  freeInodes?: number;
}

/**
 * Optional measurement hints a caller (e.g. the snapshot publisher) can attach
 * so classification can distinguish an inode exhaustion from a plain byte
 * shortage instead of guessing from the errno alone.
 */
export interface StorageHints {
  path?: string;
  freeBytes?: number;
  requiredBytes?: number;
  freeInodes?: number;
}

/**
 * Errno codes that indicate a storage/disk condition at all. ENOTDIR is NOT
 * included: "path is not a directory" is a path-shape/layout error (e.g. the
 * work dir was replaced by a file), not a storage-pressure condition —
 * waiting for disk space can never clear it, so it falls through to the
 * operator-review fallback instead of suspending the mission.
 */
const STORAGE_ERRNOS = new Set(["ENOSPC", "ENOMEM", "EIO", "EFBIG", "EROFS", "EDQUOT", "EACCES"]);

/** Read a storage-relevant field from an unknown thrown value. */
function storageField(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const v = (error as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function storageCode(error: unknown): string | undefined {
  const code = storageField(error, "code") ?? storageField(error, "errno");
  if (code && /^[A-Z0-9_]+$/.test(code)) return code;
  return undefined;
}

/**
 * Classify a storage failure into a typed incident. Pure and deterministic;
 * never throws. Prefer the errno code; fall back to message text and the
 * optional measurement hints to disambiguate (inodes vs bytes vs quota).
 */
export function classifyStorageIncident(error: unknown, hints: StorageHints = {}): StoragePressureIncident {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const msg = raw.toLowerCase();
  const code = storageCode(error);
  const codeLower = code?.toLowerCase() ?? "";
  const path = hints.path ?? storageField(error, "path");
  const freeBytes = hints.freeBytes;
  const requiredBytes = hints.requiredBytes;
  const freeInodes = hints.freeInodes;

  const mentions = (...needles: string[]) => needles.some((n) => msg.includes(n));

  const base = {
    code: code ?? "UNKNOWN",
    path,
    freeBytes,
    requiredBytes,
    freeInodes,
  };

  // Inode exhaustion: the error text says so explicitly, or the free-inode
  // hint is zero/absent while free bytes are plentiful (so bytes are not the
  // binding constraint). Both self-heal once inodes are freed.
  if (mentions("no space left on device", "enospc") && mentions("inode")) {
    return {
      ...base,
      category: "INODE_EXHAUSTED",
      recovery: "AUTO",
      autoRecover: true,
      needsOperator: false,
      reason: "no free inodes on the target filesystem",
    };
  }
  if (freeInodes === 0 && typeof freeBytes === "number" && freeBytes > 0) {
    return {
      ...base,
      category: "INODE_EXHAUSTED",
      recovery: "AUTO",
      autoRecover: true,
      needsOperator: false,
      reason: "no free inodes (bytes remain but inodes are exhausted)",
    };
  }

  // Quota exceeded.
  if (code === "EDQUOT" || mentions("quota")) {
    return {
      ...base,
      category: "QUOTA_EXCEEDED",
      recovery: "AUTO",
      autoRecover: true,
      needsOperator: false,
      reason: "per-directory or per-user quota exceeded",
    };
  }

  // Read-only filesystem: only an operator can remount; blind retries cannot
  // clear it.
  if (code === "EROFS" || mentions("read-only file system", "readonly", "read only")) {
    return {
      ...base,
      category: "READ_ONLY_FS",
      recovery: "OPERATOR",
      autoRecover: false,
      needsOperator: true,
      reason: "target filesystem is read-only — remount to recover",
    };
  }

  // Permission denied on a storage path: an operator must fix ownership/mode.
  if (code === "EACCES" || mentions("permission denied")) {
    return {
      ...base,
      category: "READ_ONLY_FS",
      recovery: "OPERATOR",
      autoRecover: false,
      needsOperator: true,
      reason: "permission denied writing to the target path",
    };
  }

  // I/O error / file too big: probe-based, treat conservatively.
  if (code === "EIO" || code === "EFBIG" || mentions("input/output error", "file too large")) {
    return {
      ...base,
      category: "IO_ERROR",
      recovery: "CONSERVATIVE",
      autoRecover: true,
      needsOperator: false,
      reason: "storage I/O error — probing before retrying",
    };
  }

  // Plain ENOSPC / no free bytes.
  if (code === "ENOSPC" || code === "ENOMEM" || mentions("no space left on device", "enospc", "disk full", "storage")) {
    return {
      ...base,
      category: "DISK_FULL",
      recovery: "AUTO",
      autoRecover: true,
      needsOperator: false,
      reason: freeBytes === 0 ? "target filesystem has no free space" : "no space left on the target filesystem",
    };
  }

  // An unrecognised errno that is nonetheless storage-flavoured: conservative.
  if (STORAGE_ERRNOS.has(code ?? "") || mentions("storage", "filesystem")) {
    return {
      ...base,
      category: "UNKNOWN_STORAGE",
      recovery: "CONSERVATIVE",
      autoRecover: true,
      needsOperator: false,
      reason: "unclassified storage condition",
    };
  }

  return {
    ...base,
    category: "UNKNOWN_STORAGE",
    recovery: "OPERATOR",
    autoRecover: false,
    needsOperator: true,
    reason: "not a storage failure — operator review required",
  };
}
