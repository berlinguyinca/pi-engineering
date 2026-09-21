/**
 * Model-gateway wait signals.
 *
 * Gateways in front of the model tell us, precisely, how long to stay away:
 *
 *   429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout",
 *         "queue_limit":100,"queued":30,"reason":"queue_timeout",
 *         "request_id":"…","retry_after_ms":30000,"scope":"agent",
 *         "type":"inference_admission"}
 *
 * Pi's own auto-retry ignores that number and sleeps `baseDelayMs * 2^(n-1)`
 * instead — 1s, 2s, 4s against a 30s ask — so the runtime parses the reported
 * wait itself and honours it (see AdmissionController).
 *
 * This module is pure: it parses text/status/headers into a structured signal
 * and never sleeps, throws, or touches the network.
 */

/** A gateway telling us to wait (or to stop). */
import { parseAdmissionPayload } from "../inference/admissionContract.ts";
import { parseRetryAfterHeader } from "../inference/retryDelay.ts";

// Re-export the shared Retry-After parser so existing gateway callers keep a
// single import surface; the canonical implementation lives in retryDelay.ts.
export { parseRetryAfterHeader };

export interface GatewayWaitSignal {
  /** How long to hold off, in milliseconds. Always >= 0. */
  retryAfterMs: number;
  /** Whether retrying can plausibly succeed (false for quota/billing exhaustion). */
  retryable: boolean;
  /** Where the wait came from — useful when diagnosing a stuck queue. */
  source: "body" | "header" | "default";
  status?: number;
  /** Gateway-reported machine reason, e.g. "queue_timeout". */
  reason?: string;
  /** Gateway-reported error family, e.g. "inference_admission". */
  type?: string;
  /** Admission scope the limit applies to, e.g. "agent". */
  scope?: string;
  /** Concurrent requests the gateway will admit. Clamps local concurrency. */
  activeLimit?: number;
  /** Requests currently queued / the queue's capacity, when reported. */
  queued?: number;
  queueLimit?: number;
  requestId?: string;
  /** The gateway's human-readable message, when present. */
  message?: string;
}

/** Statuses that mean "the gateway is saturated, come back later". */
const WAIT_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Wait applied when a gateway says "too many requests" without saying for how
 * long. Deliberately generous: under-waiting is what caused the overload.
 */
export const DEFAULT_WAIT_MS = 5_000;

/** Phrases that mean the account is out of credit — retrying cannot help. */
const NON_RETRYABLE_PATTERNS =
  /\b(quota[_ -]?exceeded|insufficient[_ -]?quota|billing|payment[_ -]?required|credit[_ -]?balance|exceeded your current quota|out of credits)\b/i;

/** Read the first JSON object embedded in a provider error string. */
function embeddedJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  const end = text.lastIndexOf("}");
  if (end <= start) return undefined;
  // Provider errors are usually `429: {json}`, but some wrap the payload in
  // prose. Try the widest span first, then progressively narrower ones.
  const candidates = [text.slice(start, end + 1)];
  const firstClose = text.indexOf("}", start);
  if (firstClose > start && firstClose !== end) candidates.push(text.slice(start, firstClose + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not JSON — fall through to the next candidate.
    }
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Leading HTTP status in a provider error string, e.g. `429: {...}`. */
function leadingStatus(text: string): number | undefined {
  const m = /^\s*(?:HTTP\s*)?(\d{3})\b/.exec(text);
  if (!m) return undefined;
  const status = Number.parseInt(m[1]!, 10);
  return status >= 400 && status <= 599 ? status : undefined;
}

/** Case-insensitive header lookup (header casing is not guaranteed). */
function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export interface GatewayWaitInput {
  /** Provider error text (e.g. an assistant message's `errorMessage`). */
  text?: string;
  /** HTTP status, when observed directly (e.g. `after_provider_response`). */
  status?: number;
  headers?: Record<string, string>;
  /** Injected clock, for HTTP-date `Retry-After` values. Default Date.now. */
  now?: () => number;
}

/**
 * Extract a wait signal from a provider error, or `null` when the input is not
 * a gateway-saturation signal at all.
 *
 * Never throws: malformed payloads degrade to "no signal" (for unknown text) or
 * to the default wait (for a known saturation status).
 */
export function parseGatewayWait(input: GatewayWaitInput): GatewayWaitSignal | null {
  const nowMs = (input.now ?? Date.now)();
  const text = input.text ?? "";
  const body = text ? embeddedJson(text) : undefined;

  // Structural InferWeave admission envelope, shared with the inference
  // transport layer (type-tag gated). When the body is not an admission
  // envelope this is undefined and we fall back to the gateway heuristics.
  const admission = body ? parseAdmissionPayload(body) : undefined;

  const status = input.status ?? leadingStatus(text) ?? num(body?.status);
  const type = admission ? str(admission.payload.type) : str(body?.type);
  const reason = admission ? admission.reason : str(body?.reason);
  const isAdmission = admission !== undefined || type === "inference_admission" || reason === "queue_timeout";
  const looksRateLimited =
    isAdmission || /\b(rate[_ -]?limit|too many requests|overloaded|queue[_ -]?timeout|try again later)\b/i.test(text);

  if (!(status !== undefined && WAIT_STATUSES.has(status)) && !looksRateLimited) return null;

  // Quota/billing exhaustion is deterministic: waiting never clears it, and Pi's
  // own retry classifier fails fast there for the same reason.
  const retryable = !NON_RETRYABLE_PATTERNS.test(text);

  const bodyWaitMs =
    admission?.retryAfterMs ??
    num(body?.retry_after_ms) ??
    num(body?.retryAfterMs) ??
    num((body as Record<string, unknown> | undefined)?.["retry-after-ms"]);
  const bodyWaitSeconds = num(body?.retry_after) ?? num(body?.retryAfter);
  const headerWaitMs =
    parseRetryAfterHeader(header(input.headers, "retry-after"), nowMs) ??
    (() => {
      const ms = num(header(input.headers, "retry-after-ms"));
      return ms === undefined ? undefined : Math.max(0, Math.round(ms));
    })();

  let retryAfterMs: number;
  let source: GatewayWaitSignal["source"];
  if (bodyWaitMs !== undefined) {
    retryAfterMs = Math.max(0, Math.round(bodyWaitMs));
    source = "body";
  } else if (bodyWaitSeconds !== undefined) {
    retryAfterMs = Math.max(0, Math.round(bodyWaitSeconds * 1000));
    source = "body";
  } else if (headerWaitMs !== undefined) {
    retryAfterMs = headerWaitMs;
    source = "header";
  } else {
    retryAfterMs = DEFAULT_WAIT_MS;
    source = "default";
  }

  const scope = admission ? admission.scope : str(body?.scope);
  const activeLimit = admission ? admission.activeLimit : num(body?.active_limit);
  const queued = admission ? admission.queued : num(body?.queued);
  const queueLimit = admission ? admission.queueLimit : num(body?.queue_limit);
  const requestId = admission ? admission.requestId : str(body?.request_id);
  const message = admission ? admission.message : str(body?.message);

  return {
    retryAfterMs,
    retryable,
    source,
    ...(status !== undefined ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(type ? { type } : {}),
    ...(scope ? { scope } : {}),
    ...(activeLimit !== undefined ? { activeLimit } : {}),
    ...(queued !== undefined ? { queued } : {}),
    ...(queueLimit !== undefined ? { queueLimit } : {}),
    ...(requestId ? { requestId } : {}),
    ...(message ? { message } : {}),
  };
}

/** One-line human summary for notices and logs. */
export function describeGatewayWait(signal: GatewayWaitSignal): string {
  const parts = [`${signal.status ?? 429}`];
  if (signal.reason) parts.push(signal.reason);
  parts.push(`waiting ${Math.round(signal.retryAfterMs / 100) / 10}s (${signal.source})`);
  if (signal.activeLimit !== undefined) parts.push(`active_limit=${signal.activeLimit}`);
  if (signal.queued !== undefined) parts.push(`queued=${signal.queued}`);
  return parts.join(" · ");
}

/** What to do with a failed model call that may be gateway backpressure. */
export type GatewayRetryDecision =
  /** Not backpressure at all — let the normal failure path handle it. */
  | { action: "not-gateway" }
  /** Wait out the reported delay and retry the SAME attempt. */
  | { action: "wait"; signal: GatewayWaitSignal }
  /** Backpressure, but retrying cannot help or the budget is spent. */
  | { action: "give-up"; signal: GatewayWaitSignal; reason: "non-retryable" | "retries-exhausted" };

/**
 * Decide how a worker attempt should respond to a provider error.
 *
 * Gateway backpressure is deliberately kept OUT of the degeneration recovery
 * ladder: lowering reasoning effort and swapping models is the wrong answer to
 * a queue timeout, and burning ladder attempts on it would mask real
 * degeneration later in the run.
 */
/**
 * Is this error a gateway admission refusal carrying a wait we can honour?
 *
 * The discriminator is `source === "body"`: the gateway told us, in the
 * response body, exactly how long to stay away. Anything else — a bare 503, a
 * plain `429 Too Many Requests` — gets a SYNTHESIZED default from
 * `parseGatewayWait`, which is a guess, not an instruction.
 *
 * That distinction decides which retry layer owns the error. Only a
 * body-advertised wait is worth honouring exactly and process-wide; for
 * everything else the transient layer's exponential backoff is the right
 * answer, and claiming it here would take a 503 away from the mechanism built
 * for it.
 */
export function isAccountWideRefusal(signal: GatewayWaitSignal): boolean {
  // 429 and the gateway's own admission envelope are statements about the
  // ACCOUNT: a shared queue, a concurrency ceiling, a position in line. Holding
  // every caller behind them is the point.
  //
  // A 5xx — `503 no worker for model` above all — is a statement about ONE
  // model. Parking the whole process behind it stalls workers on models that
  // are answering perfectly well.
  //
  // Keyed on what the refusal is ABOUT, not on where its number came from.
  //
  // Not to be confused with `isGatewayAdmissionRefusal`, which answers a
  // different question — see its comment. This one decides WHO waits; that one
  // decides WHICH LAYER owns the wait.
  return signal.status === 429 || signal.type === "inference_admission" || signal.reason === "queue_timeout";
}

export function isGatewayAdmissionRefusal(errorText: string | undefined): boolean {
  if (!errorText) return false;
  const signal = parseGatewayWait({ text: errorText });
  return signal?.source === "body" && signal.retryable;
}

export function decideGatewayRetry(
  errorText: string | undefined,
  retriesSoFar: number,
  maxRetries: number,
): GatewayRetryDecision {
  if (!errorText) return { action: "not-gateway" };
  const signal = parseGatewayWait({ text: errorText });
  if (!signal) return { action: "not-gateway" };
  if (!signal.retryable) return { action: "give-up", signal, reason: "non-retryable" };
  if (retriesSoFar >= maxRetries) return { action: "give-up", signal, reason: "retries-exhausted" };
  return { action: "wait", signal };
}
