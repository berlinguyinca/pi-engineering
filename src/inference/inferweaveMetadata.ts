/**
 * InferWeave response-metadata capture (fault-tolerance spec §8).
 *
 * When communicating with an InferWeave-compatible gateway the harness MUST
 * capture and preserve response headers for BOTH successful and failed
 * requests, and must never throw them away when converting a response into a
 * Pi/model error. Unknown `X-InferWeave-*` headers are retained verbatim for
 * telemetry so a protocol that grows new fields keeps working (forward
 * compatibility).
 *
 * Nothing here is tied to one deployment: any `x-inferweave-*` header is
 * accepted, and the well-known names below are merely the current protocol's
 * convenience fields.
 */

import {
  type AdmissionHeaders,
  headerGetter,
  parseAdmissionPayload,
  serverRequestIdFromHeaders,
} from "./admissionContract.ts";
import { parseRetryAfterHeader, parseRetryAfterMsHeader } from "./retryDelay.ts";

/** Response metadata preserved across the transport boundary (spec §8). */
export interface InferenceResponseMetadata {
  status?: number;
  headers: Record<string, string>;
  provider?: string;
  protocol?: string;
  requestedModel?: string;
  resolvedModel?: string;
  nodeId?: string;
  gatewayId?: string;
  workerId?: string;
  retryAfterMs?: number;
  routingReason?: string;
  capacityState?: string;
  /** Server request id (correlates gateway and harness logs). */
  requestId?: string;
  /** Every `x-inferweave-*` header, lower-cased name → value, incl. unknown ones. */
  inferweave: Record<string, string>;
  /** Parsed structured error body, when one was present. */
  errorBody?: Record<string, unknown>;
  /** True when the response carries the InferWeave protocol (headers or body). */
  inferweaveProtocol: boolean;
}

export interface ResponseMetadataInput {
  status?: number;
  headers?: AdmissionHeaders;
  /** Raw body text or an already-parsed object; only error bodies are buffered. */
  body?: unknown;
  provider?: string;
  requestedModel?: string;
  nowMs?: number;
}

const INFERWEAVE_HEADER = /^x-inferweave-/i;

/** The well-known InferWeave header names (preference order per field). */
const HEADER_FIELDS = {
  resolvedModel: ["x-inferweave-resolved-model", "x-inferweave-model", "x-inferweave-served-model"],
  nodeId: ["x-inferweave-node-id", "x-inferweave-node"],
  gatewayId: ["x-inferweave-gateway-id", "x-inferweave-gateway"],
  workerId: ["x-inferweave-worker-id", "x-inferweave-worker"],
  routingReason: ["x-inferweave-routing-reason", "x-inferweave-routed-by", "x-inferweave-reason"],
  capacityState: ["x-inferweave-capacity-state", "x-inferweave-capacity", "x-inferweave-scheduler-state"],
} as const;

export type InferenceMetadataField = keyof typeof HEADER_FIELDS;

/** Lower-cased plain record of a header bag (`Headers` or object). */
export function headersToLowerCaseRecord(headers: AdmissionHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Capture every `x-inferweave-*` header. Unknown names are retained verbatim
 * — this is the forward-compatibility guarantee the spec requires.
 */
export function captureInferweaveHeaders(headers: AdmissionHeaders | undefined): Record<string, string> {
  const lowered = headersToLowerCaseRecord(headers);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(lowered)) {
    if (INFERWEAVE_HEADER.test(key)) out[key] = value;
  }
  return out;
}

function firstHeader(get: (name: string) => string | undefined, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = get(name);
    if (value) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Reduce a raw response (success OR failure) to `InferenceResponseMetadata`.
 *
 * Never throws: a malformed header bag or body yields a metadata record with
 * whatever could be captured, so the classifier still gets the raw headers.
 */
export function metadataFromResponse(input: ResponseMetadataInput): InferenceResponseMetadata {
  const lowered = headersToLowerCaseRecord(input.headers);
  const get = headerGetter(input.headers);
  const inferweave = captureInferweaveHeaders(input.headers);

  let errorBody: Record<string, unknown> | undefined;
  let parsedBody: Record<string, unknown> | undefined;
  const rawBody = input.body;
  if (typeof rawBody === "string") {
    const text = rawBody.trim();
    if (text) {
      try {
        parsedBody = asRecord(JSON.parse(text));
      } catch {
        parsedBody = undefined;
      }
    }
  } else {
    parsedBody = asRecord(rawBody);
  }
  if (input.status !== undefined && input.status >= 400) {
    // Only error bodies are surfaced as `errorBody`; success bodies are never
    // buffered (they stream untouched upstream).
    const nested = parsedBody ? (asRecord(parsedBody.error) ?? asRecord(parsedBody.detail) ?? parsedBody) : undefined;
    errorBody = nested;
  }

  const admission = parsedBody ? parseAdmissionPayload(parsedBody) : undefined;
  const inferweaveProtocol =
    Object.keys(inferweave).length > 0 || admission !== undefined || errorBody?.type === "inference_admission";

  const nowMs = input.nowMs ?? Date.now();
  let retryAfterMs = admission?.retryAfterMs;
  if (retryAfterMs === undefined) {
    const ms = parseRetryAfterMsHeader(get("retry-after-ms"));
    if (ms !== undefined) retryAfterMs = ms;
  }
  if (retryAfterMs === undefined) {
    const ra = get("retry-after");
    if (ra !== undefined) {
      const seconds = parseRetryAfterMsHeader(ra);
      retryAfterMs = seconds !== undefined ? seconds * 1000 : parseRetryAfterHeader(ra, nowMs);
    }
  }
  if (retryAfterMs === undefined && errorBody) {
    const bodyMs = nonNegativeNumber(errorBody.retry_after_ms ?? errorBody.retryAfterMs);
    if (bodyMs !== undefined) retryAfterMs = bodyMs;
  }

  const resolvedFromHeader = firstHeader(get, HEADER_FIELDS.resolvedModel);
  const resolvedFromBody =
    (typeof errorBody?.model === "string" && errorBody.model) ||
    (typeof parsedBody?.model === "string" && parsedBody.model);

  const metadata: InferenceResponseMetadata = {
    headers: lowered,
    inferweave,
    inferweaveProtocol,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(resolvedFromHeader ? { resolvedModel: resolvedFromHeader } : {}),
    ...(resolvedFromHeader === undefined && resolvedFromBody ? { resolvedModel: resolvedFromBody } : {}),
    ...(admission?.requestId ? { requestId: admission.requestId } : {}),
  };
  for (const field of Object.keys(HEADER_FIELDS) as InferenceMetadataField[]) {
    const value = firstHeader(get, HEADER_FIELDS[field]);
    if (!value) continue;
    if (field === "resolvedModel") continue; // handled above with body fallback
    metadata[field] = value;
  }
  if (metadata.requestId === undefined) {
    const fromHeaders = serverRequestIdFromHeaders(input.headers);
    if (fromHeaders) metadata.requestId = fromHeaders;
  }
  if (retryAfterMs !== undefined) metadata.retryAfterMs = retryAfterMs;
  if (admission?.reason) metadata.routingReason = metadata.routingReason ?? admission.reason;
  if (errorBody) metadata.errorBody = errorBody;
  if (inferweaveProtocol) metadata.protocol = "inferweave";
  return metadata;
}
