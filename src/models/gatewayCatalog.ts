/**
 * Reading a model catalogue off an OpenAI-compatible gateway.
 *
 * `GET {baseUrl}/models` is standard, but the standard response carries only
 * `id`, `object`, `created` and `owned_by` — nothing about how big a request a
 * model will accept. This gateway reports considerably more:
 *
 *   {"id":"deepseek-v4-flash","object":"model","owned_by":"","created":…,
 *    "x_context_window":262144,"x_state":"warm",
 *    "ctx_per_request":262144,"ctx_total":2359296,"slots":9}
 *
 * `ctx_per_request` is the field that matters and is NOT the same as
 * `ctx_total`: the total is what the gateway holds across all its slots, while
 * a single call is bounded by the per-request limit. Configuring the total
 * would tell Pi a request four times too large will fit.
 *
 * Pure parsing is kept separate from fetching so the shape handling is testable
 * without a network.
 */

import { noteAdvertisedRequestLimit, noteRequestLimitHeader } from "../request/bodyBudget.ts";

/** One model as the gateway describes it. */
export interface GatewayModelEntry {
  id: string;
  /** Per-request context limit — what actually bounds one call. */
  contextWindow: number;
  /** Context the gateway holds across all slots, when reported. */
  contextTotal?: number;
  /** Gateway-reported readiness, e.g. "warm" / "cold". */
  state?: string;
  /** Concurrent requests this model can serve. Zero is why a 503 happens. */
  slots?: number;
  /** Largest request body the gateway accepts for this model, when advertised. */
  maxRequestBytes?: number;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse a `/models` response.
 *
 * Skips entries with no id or no usable context size rather than inventing one:
 * a fabricated context window is how a session gets configured to overflow. A
 * malformed payload yields an empty list, never a throw.
 */
export function parseGatewayModels(payload: unknown): GatewayModelEntry[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: GatewayModelEntry[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    // Per-request first: `ctx_total` is the gateway's aggregate across slots and
    // would over-state what one call may send.
    const contextWindow = num(row.ctx_per_request) ?? num(row.x_context_window) ?? num(row.context_length);
    if (contextWindow === undefined) continue;
    const contextTotal = num(row.ctx_total);
    const state = str(row.x_state) ?? str(row.state);
    const slots = typeof row.slots === "number" && Number.isFinite(row.slots) ? row.slots : undefined;
    const maxRequestBytes = num(row.x_max_request_bytes) ?? num(row.max_request_bytes);
    out.push({
      id,
      contextWindow,
      ...(contextTotal !== undefined ? { contextTotal } : {}),
      ...(state ? { state } : {}),
      ...(slots !== undefined ? { slots } : {}),
      ...(maxRequestBytes !== undefined ? { maxRequestBytes } : {}),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface FetchCatalogOptions {
  /** Provider base URL, e.g. `https://llm.metabolomics.us/v1`. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The gateway this extension is built around, when nothing else is configured. */
export const DEFAULT_GATEWAY_BASE_URL = "https://llm.metabolomics.us/v1";

export class CatalogFetchError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CatalogFetchError";
    this.status = status;
  }
}

/** Fetch and parse the gateway's catalogue. Throws `CatalogFetchError`. */
export async function fetchGatewayModels(opts: FetchCatalogOptions): Promise<GatewayModelEntry[]> {
  const base = (opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), opts.timeoutMs ?? 15_000);
  // Honour the caller's signal as well as our own deadline.
  const onAbort = () => timer.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await doFetch(`${base}/models`, {
      headers: {
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        ...(opts.headers ?? {}),
      },
      signal: timer.signal,
    });
    if (!res.ok) throw new CatalogFetchError(`gateway returned ${res.status} for ${base}/models`, res.status);
    const body: unknown = await res.json().catch(() => null);
    const models = parseGatewayModels(body);
    // The request-body cap, however the gateway chose to advertise it: a
    // response header, a listing-level field, or per model. Recorded for the
    // live-path body guard (src/request/bodyBudget.ts).
    noteRequestLimitHeader(base, res.headers);
    // `x_max_request_bytes` is the gateway's extension-field convention (like
    // `x_context_window`); `max_request_bytes` is accepted as well.
    const listing = body as { x_max_request_bytes?: unknown; max_request_bytes?: unknown } | null;
    noteAdvertisedRequestLimit(base, listing?.x_max_request_bytes ?? listing?.max_request_bytes);
    for (const model of models) {
      if (model.maxRequestBytes !== undefined) noteAdvertisedRequestLimit(base, model.maxRequestBytes, model.id);
    }
    if (models.length === 0) {
      throw new CatalogFetchError(`gateway returned no usable models from ${base}/models`, res.status);
    }
    return models;
  } catch (err) {
    if (err instanceof CatalogFetchError) throw err;
    throw new CatalogFetchError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
