/**
 * InferWeave admission-error contract (spec 01-admission-error-contract).
 *
 * Classification is STRUCTURAL: a response is an InferWeave admission response
 * only when its JSON body carries `type: "inference_admission"` (optionally
 * nested one level under `error`, `detail`, or `detail.error`). Rendered error
 * text is never re-parsed to decide retry behaviour.
 */

/** The wire contract InferWeave returns for admission-control rejections. */
export interface InferWeaveAdmissionPayload {
  type: "inference_admission" | "inferweave_backpressure";
  reason: string;
  message?: string;
  scope?: string;
  request_id?: string;
  retry_after_ms?: number;
  active?: number;
  active_limit?: number;
  queued?: number;
  queue_limit?: number;
}

/** Shared normalized guidance consumed by both retry paths. */
export interface InferenceGuidance {
  status?: number;
  message?: string;
  type?: "inference_admission" | "inferweave_backpressure";
  code?: string;
  reason?: string;
  action?: string;
  actionCode?: string;
  retryable?: boolean;
  replaySafe?: boolean;
  requestState?: "not_started" | "queued" | "dispatched" | "streaming" | "unknown";
  scope?: "request" | "model" | "caller" | "global" | string;
  retryAfterMs?: number;
}

/** What a well-formed admission payload is normalised into. */
export interface AdmissionInfo extends InferenceGuidance {
  /** Raw reason token (`queue_timeout`, `caller_concurrency`, ...). */
  reason: string;
  /** True when replay must follow the explicit v1 contract, not legacy heuristics. */
  explicitReplayContract?: boolean;
  /** InferWeave request id, used to correlate gateway and harness logs. */
  requestId?: string;
  active?: number;
  activeLimit?: number;
  queued?: number;
  queueLimit?: number;
  /** The untouched parsed JSON object, for telemetry and forensics. */
  payload: Record<string, unknown>;
}

/** How the harness responds to an admission classification. */
export type AdmissionAction = "retry" | "retry_then_fallback" | "fallback" | "fail";

/** Per-reason policy: how long to wait, and when to hand off to model routing. */
export interface AdmissionReasonPolicy {
  action: AdmissionAction;
  /** Reason-specific wait budget (falls back to the global budget). */
  maxElapsedMs?: number;
  /** For `retry_then_fallback`: elapsed wait after which routing takes over. */
  fallbackAfterMs?: number;
}

/** Response statuses that may carry an admission rejection. */
export const ADMISSION_STATUSES: readonly number[] = [429, 503];

/** Statuses that are permanent regardless of the reason token carried. */
export const PERMANENT_ADMISSION_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 413, 422];

/** Reason taxonomy and defaults (spec 01 §4). */
export const DEFAULT_ADMISSION_REASON_POLICY: Readonly<Record<string, AdmissionReasonPolicy>> = {
  queue_timeout: { action: "retry" },
  caller_concurrency: { action: "retry" },
  worker_saturated: { action: "retry" },
  model_loading: { action: "retry" },
  capacity_unavailable: { action: "retry_then_fallback", fallbackAfterMs: 180_000 },
  quota_exhausted: { action: "fallback" },
  auth_failed: { action: "fail" },
  forbidden: { action: "fail" },
  malformed_request: { action: "fail" },
};

/** Reasons the harness is willing to wait out by default. */
export const RETRYABLE_ADMISSION_REASONS: readonly string[] = [
  "queue_timeout",
  "caller_concurrency",
  "worker_saturated",
  "model_loading",
];

/** Reasons that must not be waited on; model routing decides instead. */
export const FALLBACK_ADMISSION_REASONS: readonly string[] = ["quota_exhausted"];

/**
 * True for any error response, which is the set that can carry an admission
 * rejection. The capture layer buffers only these bodies (they are small) to
 * look for the structured contract; success responses stream untouched.
 */
export function mayCarryAdmission(status: number): boolean {
  return status >= 400 && status <= 599;
}

/** True for the statuses the harness is willing to wait out. */
export function isAdmissionRetryStatus(status: number): boolean {
  return ADMISSION_STATUSES.includes(status);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = nonNegativeNumber(value);
  return n === undefined ? undefined : Math.floor(n);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAdmissionMarker(obj: Record<string, unknown>): boolean {
  return obj.type === "inference_admission" || obj.type === "inferweave_backpressure";
}

const REPLAY_ACTION_CODES = new Set(["IW-ACT-BACKOFF", "IW-ACT-REDUCE-CONCURRENCY", "IW-ACT-RETRY-ALTERNATE"]);
const KNOWN_ACTIONS = new Set([
  "backoff",
  "reduce_concurrency",
  "retry_alternate",
  "fix_request",
  "authenticate",
  "request_access",
  "resolve_conflict",
  "reduce_input",
  "do_not_retry",
]);
const KNOWN_ACTION_CODES = new Set([
  ...REPLAY_ACTION_CODES,
  "IW-ACT-FIX-REQUEST",
  "IW-ACT-AUTHENTICATE",
  "IW-ACT-REQUEST-ACCESS",
  "IW-ACT-RESOLVE-CONFLICT",
  "IW-ACT-REDUCE-INPUT",
  "IW-ACT-DO-NOT-RETRY",
]);

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requestState(value: unknown): AdmissionInfo["requestState"] {
  return value === "not_started" ||
    value === "queued" ||
    value === "dispatched" ||
    value === "streaming" ||
    value === "unknown"
    ? value
    : undefined;
}

/**
 * Structurally recognise an admission payload.
 *
 * Accepts the contract shape at the top level or nested one level under
 * `error` / `detail` / `detail.error` (gateway wrapping). Returns `undefined`
 * for anything else, including a bare HTTP 429 with a provider-shaped body.
 */
export function parseAdmissionPayload(value: unknown): AdmissionInfo | undefined {
  let body = value;
  if (typeof body === "string") {
    const text = body.trim();
    if (!text) return undefined;
    try {
      body = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  const candidate = candidateAdmissionObject(body);
  if (!candidate) return undefined;
  const reason = nonEmptyString(candidate.reason) ?? "unknown";
  const type = candidate.type as AdmissionInfo["type"];
  const action = nonEmptyString(candidate.action);
  const actionCode = nonEmptyString(candidate.action_code ?? candidate.actionCode);
  const explicitReplayContract =
    type === "inferweave_backpressure" ||
    [
      "retryable",
      "replay_safe",
      "replaySafe",
      "request_state",
      "requestState",
      "action",
      "action_code",
      "actionCode",
    ].some((key) => Object.hasOwn(candidate, key));
  const info: AdmissionInfo = {
    type,
    reason,
    code: nonEmptyString(candidate.code),
    message: nonEmptyString(candidate.message),
    scope: nonEmptyString(candidate.scope),
    action: action && KNOWN_ACTIONS.has(action) ? action : undefined,
    actionCode: actionCode && KNOWN_ACTION_CODES.has(actionCode) ? actionCode : undefined,
    retryable: boolean(candidate.retryable),
    replaySafe: boolean(candidate.replay_safe ?? candidate.replaySafe),
    requestState: requestState(candidate.request_state ?? candidate.requestState),
    explicitReplayContract,
    requestId: nonEmptyString(candidate.request_id) ?? nonEmptyString(candidate.requestId),
    payload: candidate,
  };
  const retryAfterMs = nonNegativeNumber(candidate.retry_after_ms ?? candidate.retryAfterMs);
  if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
  const active = nonNegativeInt(candidate.active);
  if (active !== undefined) info.active = active;
  const activeLimit = nonNegativeInt(candidate.active_limit ?? candidate.activeLimit);
  if (activeLimit !== undefined) info.activeLimit = activeLimit;
  const queued = nonNegativeInt(candidate.queued);
  if (queued !== undefined) info.queued = queued;
  const queueLimit = nonNegativeInt(candidate.queue_limit ?? candidate.queueLimit);
  if (queueLimit !== undefined) info.queueLimit = queueLimit;
  return info;
}

/** Shared pure replay gate used by both structured and interactive transports. */
export function isAutomaticReplayAllowed(info: AdmissionInfo, outputCommitted: boolean): boolean {
  if (outputCommitted) return false;
  if (info.explicitReplayContract !== true) {
    const policy = DEFAULT_ADMISSION_REASON_POLICY[info.reason];
    return policy === undefined || policy.action === "retry" || policy.action === "retry_then_fallback";
  }
  return (
    info.retryable === true &&
    info.replaySafe === true &&
    (info.requestState === "not_started" || info.requestState === "queued") &&
    info.actionCode !== undefined &&
    REPLAY_ACTION_CODES.has(info.actionCode)
  );
}

/** Preserve normalized server guidance when a provider flattens the terminal error. */
export function augmentInferenceErrorMessage(
  providerMessage: string | undefined,
  guidance: Pick<InferenceGuidance, "message" | "code" | "actionCode">,
): string {
  const base = providerMessage?.trim() || "Inference request rejected";
  const parts = [base];
  if (guidance.message && !base.includes(guidance.message)) parts.push(`message=${guidance.message}`);
  if (guidance.code && !base.includes(guidance.code)) parts.push(`code=${guidance.code}`);
  if (guidance.actionCode && !base.includes(guidance.actionCode)) parts.push(`action_code=${guidance.actionCode}`);
  return parts.join(", ");
}

function candidateAdmissionObject(body: unknown): Record<string, unknown> | undefined {
  const top = asRecord(body);
  if (!top) return undefined;
  if (isAdmissionMarker(top)) return top;
  for (const key of ["error", "detail"]) {
    const nested = asRecord(top[key]);
    if (nested && isAdmissionMarker(nested)) return nested;
    const deeper = asRecord(nested?.error);
    if (deeper && isAdmissionMarker(deeper)) return deeper;
  }
  return undefined;
}

/** Headers accepted by the parser, in either shape. */
export type AdmissionHeaders = Record<string, string | number | undefined> | Headers;

/** Normalise a header bag to a case-insensitive lookup. */
export function headerGetter(headers: AdmissionHeaders | undefined): (name: string) => string | undefined {
  if (!headers) return () => undefined;
  if (headers instanceof Headers) return (name: string) => headers.get(name) ?? undefined;
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    lowered.set(key.toLowerCase(), String(value));
  }
  return (name: string) => lowered.get(name.toLowerCase());
}

/** Request-id headers InferWeave may set, in preference order. */
const REQUEST_ID_HEADERS = [
  "x-inferweave-request-id",
  "x-request-id",
  "x-amz-request-id",
  "request-id",
  "x-correlation-id",
] as const;

/** Extract the server-side request id from response headers, if any. */
export function serverRequestIdFromHeaders(headers: AdmissionHeaders | undefined): string | undefined {
  const get = headerGetter(headers);
  for (const name of REQUEST_ID_HEADERS) {
    const value = get(name);
    if (value) return value;
  }
  return undefined;
}

/** A raw HTTP response reduced to what the admission parser needs. */
export interface AdmissionHttpResponse {
  status: number;
  headers?: AdmissionHeaders;
  /** Response body as text or an already-parsed object. */
  body?: unknown;
}

/**
 * Classify a raw HTTP response as an admission rejection.
 *
 * Returns `undefined` for non-admission responses so the caller keeps its own
 * error handling; a bare 429 from a non-InferWeave provider is NOT admission.
 */
export function admissionFromResponse(response: AdmissionHttpResponse): AdmissionInfo | undefined {
  if (!mayCarryAdmission(response.status)) return undefined;
  const info = parseAdmissionPayload(response.body);
  if (!info) return undefined;
  if (!info.requestId) {
    const fromHeaders = serverRequestIdFromHeaders(response.headers);
    if (fromHeaders) info.requestId = fromHeaders;
  }
  info.status = response.status;
  return info;
}

/** Fields the final failure must retain (spec 01 §6). */
export interface AdmissionFailureFacts {
  provider: string;
  modelId: string;
  logicalRequestId: string;
  status: number;
  reason: string;
  action: AdmissionAction;
  attempts: number;
  elapsedMs: number;
  lastDelayMs?: number;
  serverRequestId?: string;
  /** Why the chain stopped waiting. */
  terminatedBy?: "budget_attempts" | "budget_elapsed" | "reason_policy" | "fallback_threshold" | "budget_ledger";
  /** True when model routing is expected to select an alternate model. */
  fallbackAttempted?: boolean;
  serverMessage?: string;
  code?: string;
  actionCode?: string;
}

/**
 * Terminal admission failure.
 *
 * The message retains every field the contract requires so a downstream layer
 * (logs, telemetry, the agent) can see status, reason, wait accounting and the
 * server request id without re-parsing anything.
 */
export class AdmissionFailure extends Error {
  readonly name = "AdmissionFailure";
  readonly facts: AdmissionFailureFacts;

  constructor(facts: AdmissionFailureFacts) {
    super(formatAdmissionFailure(facts));
    this.facts = facts;
  }
}

/** Render the canonical terminal admission failure message. */
export function formatAdmissionFailure(facts: AdmissionFailureFacts): string {
  const parts = [
    `InferWeave admission rejected (${facts.reason}, HTTP ${facts.status})`,
    `attempts=${Math.max(1, Math.floor(facts.attempts))}`,
    `waited=${formatDuration(facts.elapsedMs)}`,
  ];
  if (facts.lastDelayMs !== undefined) parts.push(`last_retry_after=${formatDuration(facts.lastDelayMs)}`);
  parts.push(`classification=${facts.action}`);
  if (facts.serverRequestId) parts.push(`request=${facts.serverRequestId}`);
  if (facts.code) parts.push(`code=${facts.code}`);
  if (facts.actionCode) parts.push(`action_code=${facts.actionCode}`);
  const suffix = facts.serverMessage ? `: ${facts.serverMessage}` : "";
  // `out of budget` is deliberate: Pi's assistant-error classifier treats that
  // phrase as a permanent provider limit, which stops the agent layer from
  // re-running an inference whose admission budget the harness already spent.
  parts.push(`out of admission budget (provider out of budget for ${facts.provider}/${facts.modelId})`);
  return `${parts.join(", ")}${suffix}`;
}

/** Compact human duration: `30s`, `2m15s`, `850ms`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    const rounded = totalSeconds >= 10 ? Math.round(totalSeconds) : Math.round(totalSeconds * 10) / 10;
    return `${rounded}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}
