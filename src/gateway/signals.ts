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
import {
  PERMANENT_ADMISSION_STATUSES,
  isAutomaticReplayAllowed,
  parseAdmissionPayload,
} from "../inference/admissionContract.ts";
import { parseRetryAfterHeader, parseRetryAfterMsHeader } from "../inference/retryDelay.ts";

// Re-export the shared Retry-After parser so existing gateway callers keep a
// single import surface; the canonical implementation lives in retryDelay.ts.
export { parseRetryAfterHeader };

export interface GatewayWaitSignal {
  /** How long to hold off, in milliseconds. Always >= 0. */
  retryAfterMs: number;
  /** Whether retrying can plausibly succeed (false for quota/billing exhaustion). */
  retryable: boolean;
  /**
   * Where the wait came from — useful when diagnosing a stuck queue.
   * `"link-cut"` is the gateway's fixed hint for a flattened link cut (see
   * LINK_CUT_WAIT_MS): honoured exactly, like a body or header wait, but not a
   * body instruction, so it never claims the admission controller's layer.
   */
  source: "body" | "header" | "default" | "link-cut" | "transport-drop";
  /**
   * A genuine post-200 flattened InferWeave refusal: a bare code (or its
   * readable wording) with no HTTP status. Held by the caller alone, since
   * flattening lost the scope and limits that would justify parking anyone
   * else. The same code WITH a status keeps the shared model-scoped hold.
   */
  flattened?: boolean;
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
  code?: string;
  action?: string;
  actionCode?: string;
  replaySafe?: boolean;
  requestState?: "not_started" | "queued" | "dispatched" | "streaming" | "unknown";
  provider?: string;
  model?: string;
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

/**
 * A linked (peer-gateway) stream cut mid-response.
 *
 * InferWeave reports it after a 200 head as an SSE error frame
 * (`inferweave_backpressure`, reason `upstream_transport_error`, scope `model`,
 * `retry_after_ms: 1000`), and the OpenAI SDK flattens that frame to its bare
 * message — "…the route serving this model ended before the response did…",
 * optionally prefixed "Connection lost:" in the newer wording. Nothing
 * structured survives, so the sentence itself is the signal. The bare reason
 * token counts only next to "InferWeave": other proxies may use the same word.
 */
const LINK_CUT_SENTENCE = /route serving this model ended before the response did/i;
const LINK_CUT_REASON = /\bupstream_transport_error\b/i;

/** The gateway's own hint for a link cut: the request is routed afresh at once. */
export const LINK_CUT_WAIT_MS = 1_000;

/**
 * True when a provider error is a flattened gateway link cut.
 *
 * Fails closed: text that also carries a permanent status (401/403/...), a
 * quota/billing phrase, or any `inferweave_backpressure` envelope is not a link
 * cut here. A well-formed envelope is decided by the admission contract, and a
 * malformed one is terminal — both exactly as without the link-cut rule.
 */
export function isGatewayLinkCut(text: string | undefined): boolean {
  if (!text) return false;
  const matches = LINK_CUT_SENTENCE.test(text) || (LINK_CUT_REASON.test(text) && /inferweave/i.test(text));
  if (!matches) return false;
  if (text.includes("inferweave_backpressure")) return false;
  if (NON_RETRYABLE_PATTERNS.test(text)) return false;
  const status = leadingStatus(text) ?? num(embeddedJson(text)?.status);
  return !(status !== undefined && PERMANENT_ADMISSION_STATUSES.includes(status));
}

/**
 * Pre-dispatch InferWeave refusal codes that are retryable per the gateway's
 * own guidance (iw-protocol `inference_guidance`: 503 → retry_alternate, 429
 * queue/model → backoff, all with request_state not_started/queued, so replay
 * is safe). Deliberately excludes caller-scoped quota codes
 * (`caller_hard_quota`) and everything the guidance marks do-not-retry.
 */
const FLATTENED_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "routing_snapshot_expired",
  "capacity_unavailable",
  "model_activating",
  "queue_timeout",
  "queue_deadline_exceeded",
  "queue_limit_reached",
  "request_not_queueable",
]);

/** "Error: 503: routing_snapshot_expired" → status 503, code. The whole text. */
const BARE_REFUSAL = /^\s*(?:error:\s*)?(?:(?:http\s*)?(\d{3})\b[:\s]*)?([a-z_]+)\.?\s*$/i;
/** The readable wording: "No fresh route for model m (routing_snapshot_expired); please retry your request." */
const WORDED_REFUSAL = /\(([a-z_]+)\);\s*please retry your request\b/i;
const PREFIXED_STATUS = /^\s*(?:error:\s*)?(?:http\s*)?(\d{3})\b/i;

/** HTTP status leading an error text, after an optional "Error:" prefix. */
export function errorTextStatus(text: string | undefined): number | undefined {
  return text ? num(PREFIXED_STATUS.exec(text)?.[1]) : undefined;
}

/**
 * The retryable pre-dispatch refusal code a flattened InferWeave error carries,
 * or undefined.
 *
 * Only two shapes count: the whole text is the code (after an optional
 * "Error:" and HTTP status), or the gateway's "(<code>); please retry your
 * request" wording. Prose that merely mentions a code is not a refusal. Fails
 * closed like isGatewayLinkCut: a permanent status, quota/billing wording, or
 * any admission envelope leaves the decision to the structured path.
 */
export function flattenedInferWeaveRefusalCode(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (/inferweave_backpressure|inference_admission/i.test(text)) return undefined;
  if (NON_RETRYABLE_PATTERNS.test(text)) return undefined;
  const code = (BARE_REFUSAL.exec(text)?.[2] ?? WORDED_REFUSAL.exec(text)?.[1])?.toLowerCase();
  if (!code || !FLATTENED_REFUSAL_CODES.has(code)) return undefined;
  const status = errorTextStatus(text);
  if (status !== undefined && PERMANENT_ADMISSION_STATUSES.includes(status)) return undefined;
  return code;
}

/**
 * A connection dropped under the request by the transport itself — undici's
 * "terminated" (socket closed mid-body, often with an "other side closed"
 * cause), "socket hang up", ECONNRESET / UND_ERR_SOCKET, or "fetch failed"
 * (connection refused while a gateway restarts). Observed: every "Error:
 * terminated" coincided with a gateway restart whose drain grace cut a long
 * in-flight stream. The OpenAI SDK's "Connection error." (APIConnectionError)
 * is what a retry sees while the restarting gateway's listener is still
 * closed. Anchored at the start of the text (after an optional
 * "Error:"/"TypeError:"), so prose that mentions the words is not a drop.
 */
const TRANSPORT_DROP =
  /^\s*(?:(?:type)?error:\s*)?(?:terminated|other side closed|socket hang up|fetch failed|(?:read\s+)?econnreset|und_err_socket|connection error)\b/i;

/**
 * Transport failures that are NOT a restart: DNS (ENOTFOUND, EAI_AGAIN) and
 * TLS/certificate errors mean a misconfigured endpoint, which no wait fixes.
 */
const PERMANENT_TRANSPORT = /\b(?:enotfound|eai_again|certificate|ssl|tls)\b/i;

/**
 * Waits for a transport drop: a gateway restart takes ~40-80s, so the ladder
 * reaches past it quickly without hammering a gateway that is still draining.
 */
export const TRANSPORT_DROP_WAITS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];

/**
 * True when a provider error is a bare transport drop. Fails closed like the
 * link-cut rule: a leading HTTP status, any embedded JSON body, an admission
 * envelope, or quota/billing wording means the gateway ANSWERED, and the
 * structured paths decide.
 */
export function isTransportDrop(text: string | undefined): boolean {
  if (!text || !TRANSPORT_DROP.test(text)) return false;
  if (/inferweave_backpressure|inference_admission/i.test(text)) return false;
  if (NON_RETRYABLE_PATTERNS.test(text)) return false;
  if (PERMANENT_TRANSPORT.test(text)) return false;
  if (embeddedJson(text) !== undefined) return false;
  return errorTextStatus(text) === undefined;
}

/**
 * The interactive pump's wait for a transport drop, or null.
 *
 * Deliberately NOT part of parseGatewayWait: that parser also feeds the worker
 * gateway layer, and a worker's transport drop is owned by the transient layer
 * (classifyError → network). Replay is safe only while nothing visible reached
 * the transcript, which the pump enforces; a user abort is excluded there too.
 * An error status observed for the attempt (anything but a 2xx head) means the
 * gateway answered, so it is not a drop.
 */
export function transportDropWait(input: GatewayWaitInput): GatewayWaitSignal | null {
  if (input.status !== undefined && (input.status < 200 || input.status >= 300)) return null;
  if (!isTransportDrop(input.text)) return null;
  return {
    retryAfterMs: TRANSPORT_DROP_WAITS_MS[0]!,
    retryable: true,
    source: "transport-drop",
    reason: "transport_drop",
    scope: "request",
  };
}

export function isFlattenedInferWeaveRefusal(text: string | undefined): boolean {
  return flattenedInferWeaveRefusalCode(text) !== undefined;
}

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
  const malformedNewContract = admission === undefined && text.includes("inferweave_backpressure");

  const status = input.status ?? leadingStatus(text) ?? num(body?.status);
  const type = admission
    ? str(admission.payload.type)
    : (str(body?.type) ?? (malformedNewContract ? "inferweave_backpressure" : undefined));
  const reason = admission ? admission.reason : str(body?.reason);
  const isAdmission = admission !== undefined || type === "inference_admission" || reason === "queue_timeout";
  const looksRateLimited =
    isAdmission || /\b(rate[_ -]?limit|too many requests|overloaded|queue[_ -]?timeout|try again later)\b/i.test(text);

  // A flattened link cut carries no envelope to parse. Replay is safe while no
  // token was delivered (the pump enforces that), and it concerns one model's
  // route. "Routed afresh" means the next attempt takes a new route, so the 1s
  // hint is honoured exactly — no escalation — and `gatewayHoldScope` keeps it
  // out of every shared cooldown. Behind the same fail-closed guards as every
  // other signal: a permanent status or malformed envelope is never a link cut.
  const permanentStatus = status !== undefined && PERMANENT_ADMISSION_STATUSES.includes(status);
  if (!admission && !malformedNewContract && !permanentStatus && isGatewayLinkCut(text)) {
    return {
      retryAfterMs: LINK_CUT_WAIT_MS,
      retryable: true,
      source: "link-cut",
      reason: "upstream_transport_error",
      type: "inferweave_backpressure",
      scope: "model",
      ...(status !== undefined ? { status } : {}),
    };
  }

  // A pre-dispatch refusal carried only as its code (bare, or the readable
  // "(<code>); please retry your request" wording). Retryable and replay-safe
  // while nothing was delivered — the pump's rule — and about one model's
  // routing. It goes through the normal wait handling below, so an observed
  // Retry-After or body wait is still honoured exactly; with none, the
  // escalating default applies, because no fixed delay survives flattening
  // (a stale snapshot lasts until the controller republishes, a warm-up as
  // long as the placement takes).
  const refusalCode =
    !admission && !malformedNewContract && !permanentStatus ? flattenedInferWeaveRefusalCode(text) : undefined;

  if (!(status !== undefined && WAIT_STATUSES.has(status)) && !looksRateLimited && !refusalCode) return null;

  // Quota/billing exhaustion is deterministic: waiting never clears it, and Pi's
  // own retry classifier fails fast there for the same reason.
  const retryable =
    status !== undefined && PERMANENT_ADMISSION_STATUSES.includes(status)
      ? false
      : malformedNewContract
        ? false
        : admission
          ? isAutomaticReplayAllowed(admission, false)
          : !NON_RETRYABLE_PATTERNS.test(text);

  const bodyWaitMs =
    admission?.retryAfterMs ??
    num(body?.retry_after_ms) ??
    num(body?.retryAfterMs) ??
    num((body as Record<string, unknown> | undefined)?.["retry-after-ms"]);
  const bodyWaitSeconds = num(body?.retry_after) ?? num(body?.retryAfter);
  const retryAfter = parseRetryAfterHeader(header(input.headers, "retry-after"), nowMs);
  const retryAfterMsHeader = parseRetryAfterMsHeader(header(input.headers, "retry-after-ms"));
  const headerWaitMs = [retryAfter, retryAfterMsHeader]
    .filter((value): value is number => value !== undefined)
    .reduce((maximum, value) => Math.max(maximum, value), -1);
  const validHeaderWaitMs = headerWaitMs >= 0 ? headerWaitMs : undefined;

  let retryAfterMs: number;
  let source: GatewayWaitSignal["source"];
  const normalizedBodyMs = bodyWaitMs !== undefined ? Math.max(0, Math.round(bodyWaitMs)) : undefined;
  const normalizedBodySeconds =
    bodyWaitSeconds !== undefined ? Math.max(0, Math.round(bodyWaitSeconds * 1000)) : undefined;
  const bodyMaximum = [normalizedBodyMs, normalizedBodySeconds]
    .filter((value): value is number => value !== undefined)
    .reduce((maximum, value) => Math.max(maximum, value), -1);
  if (bodyMaximum >= 0 || validHeaderWaitMs !== undefined) {
    const bodyWins = bodyMaximum >= (validHeaderWaitMs ?? -1);
    retryAfterMs = bodyWins ? bodyMaximum : (validHeaderWaitMs as number);
    source = bodyWins ? "body" : "header";
  } else {
    retryAfterMs = DEFAULT_WAIT_MS;
    source = "default";
  }

  const scope = admission ? admission.scope : (str(body?.scope) ?? (refusalCode ? "model" : undefined));
  const activeLimit = admission ? admission.activeLimit : num(body?.active_limit);
  const queued = admission ? admission.queued : num(body?.queued);
  const queueLimit = admission ? admission.queueLimit : num(body?.queue_limit);
  const requestId = admission ? admission.requestId : str(body?.request_id);
  const message = admission ? admission.message : str(body?.message);

  const signalReason = reason ?? refusalCode;
  const signalType = type ?? (refusalCode ? "inferweave_backpressure" : undefined);
  return {
    retryAfterMs,
    retryable,
    source,
    ...(refusalCode && status === undefined ? { flattened: true } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(signalReason ? { reason: signalReason } : {}),
    ...(signalType ? { type: signalType } : {}),
    ...(scope ? { scope } : {}),
    ...(activeLimit !== undefined ? { activeLimit } : {}),
    ...(queued !== undefined ? { queued } : {}),
    ...(queueLimit !== undefined ? { queueLimit } : {}),
    ...(requestId ? { requestId } : {}),
    ...(message ? { message } : {}),
    ...(admission?.code ? { code: admission.code } : {}),
    ...(admission?.action ? { action: admission.action } : {}),
    ...(admission?.actionCode ? { actionCode: admission.actionCode } : {}),
    ...(admission?.replaySafe !== undefined ? { replaySafe: admission.replaySafe } : {}),
    ...(admission?.requestState ? { requestState: admission.requestState } : {}),
    ...(str(admission?.payload.provider ?? body?.provider)
      ? { provider: str(admission?.payload.provider ?? body?.provider) }
      : {}),
    ...(str(admission?.payload.model ?? body?.model) ? { model: str(admission?.payload.model ?? body?.model) } : {}),
  };
}

/**
 * Grow a synthesized wait with consecutive failures.
 *
 * A gateway that reports `retry_after_ms` (or a link cut's fixed "routed
 * afresh" hint) is obeyed to the millisecond — it knows when its queue drains
 * and we do not. A wait we synthesized (`"default"`) advertises nothing, and
 * asking again every 5s while a model has no workers at all is a busy-wait
 * against an outage. Escalate those, capped so recovery stays prompt.
 */
export function escalateSyntheticWait(signal: GatewayWaitSignal, attempt: number, capMs: number): GatewayWaitSignal {
  if (signal.source === "transport-drop") {
    const step = TRANSPORT_DROP_WAITS_MS[Math.min(Math.max(0, attempt - 1), TRANSPORT_DROP_WAITS_MS.length - 1)]!;
    return { ...signal, retryAfterMs: Math.min(capMs, step) };
  }
  if (signal.source !== "default") return signal;
  const escalated = Math.min(capMs, signal.retryAfterMs * 2 ** Math.max(0, attempt - 1));
  return { ...signal, retryAfterMs: escalated };
}

/**
 * The worker failure marker for a gateway wait budget that ran out.
 *
 * A flattened refusal is the same failure the transient layer sees when it is
 * thrown, so it exhausts into the same `transient:server_unavailable` marker —
 * the scheduler's resilience window then waits out a long warm-up instead of
 * failing the task. Everything else keeps its `gateway:<reason>` marker.
 */
export function gatewayFailureMarker(signal: GatewayWaitSignal): string {
  if (signal.flattened) return "transient:server_unavailable";
  return `gateway:${signal.reason ?? signal.type ?? signal.status ?? "rate-limited"}`;
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
  if (signal.scope === "model" || signal.scope === "request") return false;
  if (signal.scope === "caller" || signal.scope === "global") return true;
  return signal.status === 429 || signal.type === "inference_admission" || signal.reason === "queue_timeout";
}

/**
 * Which cooldown a hold for `signal` belongs to.
 *
 * `"shared"`: arm the admission controller's cooldown (process-wide for an
 * account-wide refusal, per-model for a model-scoped one) so other callers back
 * off too. `"caller"`: park only the caller that hit it. A link cut is always
 * the caller's: one request's route broke, and the retry is routed afresh.
 */
export function gatewayHoldScope(signal: GatewayWaitSignal): "shared" | "caller" {
  if (signal.source === "link-cut" || signal.source === "transport-drop" || signal.flattened) return "caller";
  if (isAccountWideRefusal(signal) || signal.scope === "model") return "shared";
  return "caller";
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

/**
 * The worker's handover after its transient-retry loop gave up.
 *
 * Errors the transient layer owns (see classifyError) have already had their
 * retries there; a link cut or a flattened refusal code is one of them, so
 * handing it to the gateway layer
 * as well would multiply the two budgets. Everything else keeps the existing
 * `decideGatewayRetry` behaviour.
 */
export function decideTransientHandover(
  errorText: string | undefined,
  retriesSoFar: number,
  maxRetries: number,
): GatewayRetryDecision {
  if (isGatewayLinkCut(errorText) || isFlattenedInferWeaveRefusal(errorText)) return { action: "not-gateway" };
  return decideGatewayRetry(errorText, retriesSoFar, maxRetries);
}
