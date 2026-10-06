/**
 * Unified inference-failure classifier (fault-tolerance spec §7, §9, §18).
 *
 * ONE canonical classifier used by every inference caller. Classification is
 * STRUCTURAL first:
 *
 *   1. InferWeave protocol metadata — structured error body / admission
 *      payload reason tokens and `X-InferWeave-*` headers;
 *   2. HTTP status;
 *   3. stream-termination state (no `finish_reason` before the stream ended);
 *   4. underlying network error codes (ECONNRESET, UND_ERR_SOCKET, ...);
 *   5. human-readable string matching — a COMPATIBILITY FALLBACK ONLY.
 *
 * The result carries the scope determination the recovery ladder needs
 * (§10): model-scoped failures may trigger comparable-model fallback;
 * gateway/provider-scoped failures must wait on the gateway instead of
 * needlessly switching models.
 */

import type { InferenceResponseMetadata } from "./inferweaveMetadata.ts";

export type InferenceFailureClass =
  | "incomplete_stream"
  | "rate_limited"
  | "queue_saturated"
  | "capacity_unavailable"
  | "model_activating"
  | "model_unavailable"
  | "no_workers"
  | "worker_evicted"
  | "worker_restarting"
  | "gateway_unavailable"
  | "network_interruption"
  | "routing_stale"
  | "model_not_found"
  | "context_overflow"
  | "request_too_large"
  | "authentication"
  | "authorization"
  | "quota"
  | "billing"
  | "invalid_request"
  | "unknown";

/** What the recovery ladder should do next for a classified failure (spec §18/§21). */
export type InferenceFailureAction =
  | "retry_same_model" // wait + retry the same logical model (incomplete stream, network)
  | "honor_retry_after" // wait the server time, retry same model, NO model switch (429, queue, activating)
  | "wait_gateway_retry" // gateway/provider is down: wait + retry the gateway
  | "refresh_catalog_retry" // stale route: refresh routing/catalog, retry same target
  | "refresh_then_fallback" // no usable workers: short wait + catalog refresh + comparable-model fallback
  | "fallback" // route to a comparable model without a catalog refresh (quota)
  | "compact_and_retry" // context overflow: compact context and retry
  | "fail"; // permanent request error: fail fast

export interface ClassifiedInferenceFailure {
  class: InferenceFailureClass;
  retryable: boolean;
  modelScoped: boolean;
  providerScoped: boolean;
  requestScoped: boolean;
  retryAfterMs?: number;
  model?: string;
  provider?: string;
  worker?: string;
  gateway?: string;
  reason?: string;
  canFallback: boolean;
  shouldRefreshCatalog: boolean;
  shouldCompactContext: boolean;
  /** Recommended next step on the recovery ladder. */
  action: InferenceFailureAction;
  /** Where the classification came from (telemetry: no re-parsing later). */
  source: "inferweave_body" | "inferweave_header" | "http_status" | "stream_state" | "network_code" | "string_fallback" | "none";
  rawStatus?: number;
  rawHeaders?: Record<string, string>;
}

export interface StreamTerminationState {
  /** The stream ended with a terminal `finish_reason` (or done event). */
  finished: boolean;
  /** Assistant-visible output (text/tool calls) reached the consumer. */
  outputCommitted: boolean;
  partialChars?: number;
}

export interface ClassifyInferenceFailureInput {
  error?: unknown;
  metadata?: InferenceResponseMetadata;
  streamState?: StreamTerminationState;
  provider?: string;
  model?: string;
}

/**
 * Reason tokens (InferWeave admission/backpressure bodies, structured error
 * bodies) mapped to canonical failure classes. This is the STRUCTURAL table:
 * it is consulted before any status or text matching.
 */
export const INFERWEAVE_REASON_CLASS: Readonly<Record<string, InferenceFailureClass>> = {
  no_workers: "no_workers",
  no_worker: "no_workers",
  no_available_worker: "no_workers",
  model_unavailable: "model_unavailable",
  model_not_loaded: "model_unavailable",
  model_unloaded: "model_unavailable",
  model_activating: "model_activating",
  model_loading: "model_activating",
  model_cold_start: "model_activating",
  worker_evicted: "worker_evicted",
  worker_killed: "worker_evicted",
  worker_restarting: "worker_restarting",
  worker_down: "worker_restarting",
  worker_saturated: "queue_saturated",
  queue_saturated: "queue_saturated",
  queue_timeout: "queue_saturated",
  queue_full: "queue_saturated",
  capacity_unavailable: "capacity_unavailable",
  capacity_backpressure: "capacity_unavailable",
  global_saturation: "capacity_unavailable",
  admission_rejected: "capacity_unavailable",
  routing_stale: "routing_stale",
  routing_snapshot_expired: "routing_stale",
  stale_route: "routing_stale",
  route_expired: "routing_stale",
  model_not_found: "model_not_found",
  unknown_model: "model_not_found",
  invalid_model_name: "model_not_found",
  context_overflow: "context_overflow",
  context_length_exceeded: "context_overflow",
  context_length: "context_overflow",
  prompt_too_long: "context_overflow",
  request_too_large: "request_too_large",
  payload_too_large: "request_too_large",
  body_too_large: "request_too_large",
  authentication: "authentication",
  auth_failed: "authentication",
  invalid_api_key: "authentication",
  unauthorized: "authentication",
  authorization: "authorization",
  forbidden: "authorization",
  quota: "quota",
  quota_exhausted: "quota",
  quota_exceeded: "quota",
  billing: "billing",
  billing_suspended: "billing",
  invalid_request: "invalid_request",
  malformed_request: "invalid_request",
  bad_request: "invalid_request",
};

const MODEL_SCOPED_CLASSES = new Set<InferenceFailureClass>([
  "no_workers",
  "model_unavailable",
  "model_activating",
  "worker_evicted",
  "worker_restarting",
  "model_not_found",
  "routing_stale",
]);
const GATEWAY_SCOPED_CLASSES = new Set<InferenceFailureClass>([
  "gateway_unavailable",
  "network_interruption",
  "rate_limited",
  "queue_saturated",
  "capacity_unavailable",
  "authentication",
  "authorization",
]);
const FALLBACK_ALLOWED_CLASSES = new Set<InferenceFailureClass>([
  "no_workers",
  "model_unavailable",
  "model_activating",
  "worker_evicted",
  "worker_restarting",
  "model_not_found",
  "quota",
  // NOTE: `capacity_unavailable` is NOT here by default: GLOBAL admission
  // saturation (the class default) must wait/retry the gateway and NEVER
  // model-switch (spec §10). A MODEL-scoped capacity payload (scope: "model")
  // opts back in below, after the wait budget has elapsed.
]);
const REFRESH_CATALOG_CLASSES = new Set<InferenceFailureClass>([
  "no_workers",
  "model_not_found",
  "routing_stale",
  "worker_evicted",
  "worker_restarting",
]);

/** Network error codes that mean the link, not the request, failed. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Compatibility fallback: human-readable stream-termination phrasing (spec §3). */
const INCOMPLETE_STREAM_PATTERNS = [
  /stream ended without finish_reason/i,
  /stream ended unexpectedly/i,
  /unexpected (?:eof|end of file)/i,
  /connection reset/i,
  /socket hang up/i,
  /premature close/i,
  /incomplete sse stream/i,
  /terminated without completion/i,
  /response is incomplete/i,
  /other side closed/i,
  /\beconnreset\b/i,
  /\beconnaborted\b/i,
  /\bepipe\b/i,
  /\betimedout\b/i,
  /\bund_err_socket\b/i,
];

const AUTH_STRING_PATTERNS =
  /\b(401|unauthorized|invalid[_ -]?api[_ -]?key|authentication failed|invalid[_ -]?credentials|api[_ -]?key[_ -]?invalid)\b/i;
const CONTEXT_STRING_PATTERNS =
  /\b(context[_ -]?(length|window|limit|exceeded|overflow)|maximum[_ -]?context|too[_ -]?many[_ -]?tokens|prompt[_ -]?is[_ -]?too[_ -]?long|input[_ -]?too[_ -]?long|413)\b/i;
const NO_WORKER_STRING_PATTERNS = /\b(no[_ -]?workers?|no available worker|no worker for model)\b/i;
const ACTIVATING_STRING_PATTERNS = /\b(model[_ -]?activating|model[_ -]?loading|loading model|cold[_ -]?start)\b/i;
const STALE_ROUTE_STRING_PATTERNS = /\b(routing[_ -]?snapshot[_ -]?expired|stale[_ -]?route|route[_ -]?expired)\b/i;
const MODEL_NOT_FOUND_STRING_PATTERNS = /\b(model[_ -]?not[_ -]?found|unknown[_ -]?model|no[_ -]?such[_ -]?model|invalid model name)\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function errorText(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; httpStatus?: unknown; response?: { status?: unknown } };
  const s = e.status ?? e.statusCode ?? e.httpStatus ?? e.response?.status;
  if (typeof s === "number" && Number.isInteger(s)) return s;
  if (typeof s === "string" && /^\d{3}$/.test(s)) return Number.parseInt(s, 10);
  return undefined;
}

function extractCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string" && e.code) return e.code;
  if (typeof e.cause?.code === "string" && e.cause.code) return e.cause.code;
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function base(input: ClassifyInferenceFailureInput): Omit<ClassifiedInferenceFailure, "class" | "action"> {
  const md = input.metadata;
  const bodyModel = typeof md?.errorBody?.model === "string" ? md.errorBody.model : undefined;
  const model = input.model ?? md?.resolvedModel ?? bodyModel;
  return {
    retryable: false,
    modelScoped: false,
    providerScoped: false,
    requestScoped: false,
    ...(md?.retryAfterMs !== undefined ? { retryAfterMs: md.retryAfterMs } : {}),
    ...(model ? { model } : {}),
    ...(input.provider ?? md?.provider ? { provider: input.provider ?? md?.provider } : {}),
    ...(md?.workerId ? { worker: md.workerId } : {}),
    ...(md?.gatewayId ? { gateway: md.gatewayId } : {}),
    canFallback: false,
    shouldRefreshCatalog: false,
    shouldCompactContext: false,
    source: "none",
    ...(md?.status !== undefined || extractStatus(input.error) !== undefined
      ? { rawStatus: md?.status ?? extractStatus(input.error) }
      : {}),
    ...(md ? { rawHeaders: md.headers } : {}),
  };
}

function finish(
  input: ClassifyInferenceFailureInput,
  cls: InferenceFailureClass,
  overrides: Partial<ClassifiedInferenceFailure> = {},
): ClassifiedInferenceFailure {
  const scopes = {
    modelScoped: MODEL_SCOPED_CLASSES.has(cls),
    providerScoped: GATEWAY_SCOPED_CLASSES.has(cls),
    requestScoped: !MODEL_SCOPED_CLASSES.has(cls) && !GATEWAY_SCOPED_CLASSES.has(cls),
  };
  const retryable = !(
    cls === "authentication" ||
    cls === "authorization" ||
    cls === "billing" ||
    cls === "invalid_request"
  );
  let action: InferenceFailureAction;
  switch (cls) {
    case "incomplete_stream":
      action = "retry_same_model";
      break;
    case "network_interruption":
      action = "retry_same_model";
      break;
    case "rate_limited":
      action = "honor_retry_after";
      break;
    case "queue_saturated":
      action = "honor_retry_after";
      break;
    case "capacity_unavailable":
      // Global admission saturation: wait. Fallback is only considered after
      // the wait budget elapses (handled by the policy layer, not here).
      action = "honor_retry_after";
      break;
    case "model_activating":
      action = "honor_retry_after";
      break;
    case "gateway_unavailable":
      action = "wait_gateway_retry";
      break;
    case "routing_stale":
      action = "refresh_catalog_retry";
      break;
    case "no_workers":
      action = "refresh_then_fallback";
      break;
    case "model_unavailable":
      action = "refresh_then_fallback";
      break;
    case "worker_evicted":
      action = "refresh_then_fallback";
      break;
    case "worker_restarting":
      action = overrides.retryAfterMs !== undefined ? "honor_retry_after" : "refresh_then_fallback";
      break;
    case "model_not_found":
      action = "refresh_then_fallback";
      break;
    case "context_overflow":
      action = "compact_and_retry";
      break;
    case "quota":
      action = "fallback";
      break;
    case "request_too_large":
      action = "fail";
      break;
    case "authentication":
    case "authorization":
    case "billing":
    case "invalid_request":
      action = "fail";
      break;
    default:
      action = "fail";
  }
  return {
    ...base(input),
    class: cls,
    ...scopes,
    retryable,
    canFallback: FALLBACK_ALLOWED_CLASSES.has(cls),
    shouldRefreshCatalog: REFRESH_CATALOG_CLASSES.has(cls),
    shouldCompactContext: cls === "context_overflow",
    action,
    ...overrides,
  };
}

/** InferWeave body reason → class, consulting the structural table first. */
function classifyFromInferweave(
  input: ClassifyInferenceFailureInput,
  reason: string,
): ClassifiedInferenceFailure | undefined {
  const cls = INFERWEAVE_REASON_CLASS[reason];
  if (!cls) return undefined;
  const md = input.metadata;
  // The payload's `scope` field refines the class-derived scope: a model-scope
  // `capacity_unavailable` is model-scoped even though the class default is
  // provider-scoped (global saturation).
  const payloadScope = typeof md?.errorBody?.scope === "string" ? md.errorBody.scope : undefined;
  const overrides: Partial<ClassifiedInferenceFailure> = {
    reason,
    source: "inferweave_body",
  };
  if (payloadScope === "model") {
    overrides.modelScoped = true;
    overrides.providerScoped = false;
    overrides.requestScoped = false;
    // A model-scoped capacity refusal says THIS model cannot be served:
    // comparable-model fallback is allowed once the wait budget elapses.
    if (cls === "capacity_unavailable") overrides.canFallback = true;
  } else if (payloadScope === "global") {
    // Global saturation: wait on the gateway; never switch models.
    overrides.canFallback = false;
    overrides.modelScoped = false;
    overrides.providerScoped = true;
  } else if (payloadScope === "request") {
    overrides.modelScoped = false;
    overrides.providerScoped = false;
    overrides.requestScoped = true;
  }
  const retryAfter = nonNegativeNumber(md?.errorBody?.retry_after_ms ?? md?.errorBody?.retryAfterMs);
  if (retryAfter !== undefined) overrides.retryAfterMs = Math.max(retryAfter, md?.retryAfterMs ?? 0) || retryAfter;
  const result = finish(input, cls, overrides);
  // `worker_restarting` without a server wait hint may reroute instead of wait.
  return result;
}

/**
 * Classify one inference failure.
 *
 * Returns a `ClassifiedInferenceFailure` with the scope flags, the recommended
 * action on the recovery ladder, and provenance (`source`) so telemetry never
 * has to re-derive WHY a model changed.
 */
export function classifyInferenceFailure(input: ClassifyInferenceFailureInput): ClassifiedInferenceFailure {
  const md = input.metadata;
  const text = errorText(input.error);
  const status = md?.status ?? extractStatus(input.error);

  // 1. STRUCTURAL: InferWeave protocol — body reason token.
  const bodyReason = typeof md?.errorBody?.reason === "string" ? md.errorBody.reason : undefined;
  if (bodyReason) {
    const fromBody = classifyFromInferweave(input, bodyReason);
    if (fromBody) return fromBody;
  }
  // InferWeave header signals (e.g. scheduler state on a 503).
  if (md?.inferweaveProtocol) {
    const headerReason = md.inferweave["x-inferweave-reason"] ?? md.inferweave["x-inferweave-failure"];
    if (headerReason) {
      const fromHeader = classifyFromInferweave({ ...input, metadata: { ...md, errorBody: { reason: headerReason } } }, headerReason);
      if (fromHeader) {
        fromHeader.source = "inferweave_header";
        fromHeader.reason = headerReason;
        return fromHeader;
      }
    }
  }

  // 2. HTTP status (before text: a 401 with "stream ended" wording is an auth
  //    outage, not a stream failure).
  if (status !== undefined) {
    if (status === 401) return finish(input, "authentication", { source: "http_status", reason: "HTTP 401" });
    if (status === 403) return finish(input, "authorization", { source: "http_status", reason: "HTTP 403" });
    if (status === 404) return finish(input, "model_not_found", { source: "http_status", reason: "HTTP 404" });
    if (status === 408 || status === 504) {
      return finish(input, "gateway_unavailable", { source: "http_status", reason: `HTTP ${status}` });
    }
    if (status === 413) return finish(input, "request_too_large", { source: "http_status", reason: "HTTP 413" });
    if (status === 422) return finish(input, "invalid_request", { source: "http_status", reason: "HTTP 422" });
    if (status === 400) return finish(input, "invalid_request", { source: "http_status", reason: "HTTP 400" });
    if (status === 429) {
      const reason = bodyReason ?? md?.routingReason;
      if (reason && INFERWEAVE_REASON_CLASS[reason] === "queue_saturated") {
        return finish(input, "queue_saturated", { source: "http_status", reason: `HTTP 429 (${reason})` });
      }
      return finish(input, "rate_limited", { source: "http_status", reason: "HTTP 429" });
    }
    if (status === 425 || status === 503) {
      // A 503 may be model-scoped; the body reason (checked above) decides.
      return finish(input, "gateway_unavailable", { source: "http_status", reason: `HTTP ${status}` });
    }
    if (status === 529) return finish(input, "rate_limited", { source: "http_status", reason: "HTTP 529 (overloaded)" });
    if (status >= 500) return finish(input, "gateway_unavailable", { source: "http_status", reason: `HTTP ${status}` });
  }

  // 3. Stream-termination state: the stream ended without finish_reason.
  const stream = input.streamState;
  if (stream && !stream.finished) {
    return finish(input, "incomplete_stream", {
      source: "stream_state",
      reason: stream.outputCommitted ? "stream ended without finish_reason after output" : "stream ended without finish_reason",
    });
  }

  // 4. Network error codes from the underlying error object.
  const code = extractCode(input.error);
  if (code && NETWORK_CODES.has(code)) {
    return finish(input, "network_interruption", { source: "network_code", reason: code });
  }

  // 5. COMPATIBILITY FALLBACK: string matching on the rendered error text.
  if (text) {
    for (const pattern of INCOMPLETE_STREAM_PATTERNS) {
      if (pattern.test(text)) {
        return finish(input, "incomplete_stream", { source: "string_fallback", reason: "stream termination phrasing" });
      }
    }
    if (AUTH_STRING_PATTERNS.test(text)) return finish(input, "authentication", { source: "string_fallback", reason: "auth phrasing" });
    if (STALE_ROUTE_STRING_PATTERNS.test(text)) return finish(input, "routing_stale", { source: "string_fallback", reason: "stale-route phrasing" });
    if (MODEL_NOT_FOUND_STRING_PATTERNS.test(text)) return finish(input, "model_not_found", { source: "string_fallback", reason: "unknown-model phrasing" });
    if (NO_WORKER_STRING_PATTERNS.test(text)) return finish(input, "no_workers", { source: "string_fallback", reason: "no-workers phrasing" });
    if (ACTIVATING_STRING_PATTERNS.test(text)) return finish(input, "model_activating", { source: "string_fallback", reason: "activation phrasing" });
    if (CONTEXT_STRING_PATTERNS.test(text)) {
      if (/\b413\b|too large/i.test(text)) return finish(input, "request_too_large", { source: "string_fallback", reason: "body-size phrasing" });
      return finish(input, "context_overflow", { source: "string_fallback", reason: "context phrasing" });
    }
    if (NETWORK_CODES.has(text.trim().toUpperCase()) || /\bfetch failed\b/i.test(text)) {
      return finish(input, "network_interruption", { source: "string_fallback", reason: "network phrasing" });
    }
  }

  return finish(input, "unknown", { source: "none", reason: "unclassified inference failure" });
}

/**
 * Human status line for the Engineering panel (spec §26): short, no stack
 * traces, names the model and the next step.
 */
export function describeFailureForUser(f: ClassifiedInferenceFailure, modelLabel: string): string {
  switch (f.class) {
    case "incomplete_stream":
      return `${modelLabel}\nstream interrupted · retrying`;
    case "network_interruption":
      return `${modelLabel}\nconnection interrupted · retrying`;
    case "rate_limited":
      return `${modelLabel}\nrate limited · waiting`;
    case "queue_saturated":
      return `${modelLabel}\nqueue saturated · waiting`;
    case "capacity_unavailable":
      return `${modelLabel}\ncapacity unavailable · waiting`;
    case "model_activating":
      return `${modelLabel}\nmodel activating · waiting`;
    case "no_workers":
      return `${modelLabel}\nno workers available · selecting fallback`;
    case "model_unavailable":
      return `${modelLabel}\nmodel unavailable · selecting fallback`;
    case "worker_evicted":
      return `${modelLabel}\nworker evicted · rerouting`;
    case "worker_restarting":
      return `${modelLabel}\nworker restarting · waiting`;
    case "gateway_unavailable":
      return `${modelLabel}\ngateway unavailable · retrying gateway`;
    case "routing_stale":
      return `${modelLabel}\nstale route · refreshing catalog`;
    case "model_not_found":
      return `${modelLabel}\nmodel not found · refreshing catalog`;
    case "context_overflow":
      return `${modelLabel}\ncontext overflow · compacting`;
    case "request_too_large":
      return `${modelLabel}\nrequest too large · adjusting request`;
    case "authentication":
      return `${modelLabel}\nauthentication failed · needs attention`;
    case "authorization":
      return `${modelLabel}\nauthorization failed · needs attention`;
    case "quota":
      return `${modelLabel}\nquota exhausted · selecting fallback`;
    case "billing":
      return `${modelLabel}\nbilling failure · needs attention`;
    case "invalid_request":
      return `${modelLabel}\ninvalid request · needs attention`;
    default:
      return `${modelLabel}\nunknown inference failure`;
  }
}
