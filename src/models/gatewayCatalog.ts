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
  /** Concurrent requests the gateway admits for this model (`active_limit` / `x_active_limit`). */
  activeLimit?: number;
  /** Largest request body the gateway accepts for this model, when advertised. */
  maxRequestBytes?: number;
  /** True when `id` is a logical route (`x_alias`) rather than a concrete model. */
  alias?: boolean;
  /** Concrete model currently backing a route, when advertised. */
  backingModel?: string;
  /** Logical routes a concrete model currently serves (`x_aliases`). */
  aliases?: string[];
  /** Capabilities the gateway advertises for the model (`x_capabilities` / `capabilities`). */
  capabilities?: string[];
  /** Model family (`x_family`); independent reviewers must differ in family. */
  family?: string;
  /** Whether the model supports tool calling (`x_tools`); undefined when not advertised. */
  tools?: boolean;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function capacityNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
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
  const windows = new Map<string, number>();
  for (const raw of data) {
    const row = raw as Record<string, unknown> | null;
    const id = row && typeof row === "object" ? str(row.id) : undefined;
    const w = row ? (num(row.ctx_per_request) ?? num(row.x_context_window) ?? num(row.context_length)) : undefined;
    if (id && w !== undefined) windows.set(id, w);
  }
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    const backingModel = str(row.x_backing_model);
    const alias = row.x_alias === true || backingModel !== undefined;
    const aliases = Array.isArray(row.x_aliases)
      ? row.x_aliases.filter((a): a is string => typeof a === "string" && a.length > 0)
      : [];
    // Per-request first: `ctx_total` is the gateway's aggregate across slots and
    // would over-state what one call may send.
    // A route row with no size of its own is bounded by the model behind it.
    const contextWindow =
      num(row.ctx_per_request) ??
      num(row.x_context_window) ??
      num(row.context_length) ??
      (backingModel ? windows.get(backingModel) : undefined);
    if (contextWindow === undefined) continue;
    const contextTotal = num(row.ctx_total);
    const state = str(row.x_state) ?? str(row.state);
    const slots = capacityNumber(row.slots);
    const activeLimit = capacityNumber(row.x_active_limit) ?? capacityNumber(row.active_limit);
    const maxRequestBytes = num(row.x_max_request_bytes) ?? num(row.max_request_bytes);
    // Routing facts are kept exactly as advertised: absent stays undefined, never a guess.
    const capabilities = strs(row.x_capabilities ?? row.capabilities);
    const family = str(row.x_family);
    const tools = typeof row.x_tools === "boolean" ? row.x_tools : undefined;
    out.push({
      id,
      contextWindow,
      ...(contextTotal !== undefined ? { contextTotal } : {}),
      ...(state ? { state } : {}),
      ...(slots !== undefined ? { slots } : {}),
      ...(activeLimit !== undefined ? { activeLimit } : {}),
      ...(maxRequestBytes !== undefined ? { maxRequestBytes } : {}),
      ...(alias ? { alias } : {}),
      ...(backingModel ? { backingModel } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(family ? { family } : {}),
      ...(tools !== undefined ? { tools } : {}),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Concurrency the gateway will serve: the largest per-model `active_limit`
 * (falling back to its slot count). Undefined when the catalogue says nothing.
 */
export function gatewayCapacity(entries: readonly GatewayModelEntry[]): number | undefined {
  let best: number | undefined;
  for (const entry of entries) {
    const n = entry.activeLimit ?? entry.slots;
    if (n !== undefined && n >= 0 && (best === undefined || n > best)) best = n;
  }
  return best;
}

/** A routed model, never an ambient catalogue maximum. */
export interface GatewayCapacityIdentity {
  modelId: string;
  provider?: string;
  baseUrl?: string;
}

const observedCatalogs = new Map<string, Map<string, number>>();
// null means the provider name has described multiple endpoints in this process.
// A caller must then supply its actual endpoint instead of selecting the last one.
const observedProviders = new Map<string, string | null>();

function capacityKey(provider: string | undefined, baseUrl: string): string {
  return JSON.stringify([provider ?? "", baseUrl.replace(/\/+$/, "")]);
}

/**
 * Capacity for an identified provider/endpoint and model. Unknown routes stay
 * unknown: another provider's catalogue is not evidence for this model.
 */
export function observedGatewayCapacity(identity?: GatewayCapacityIdentity): number | undefined {
  if (!identity?.modelId) return undefined;
  const key = identity.baseUrl
    ? capacityKey(identity.provider, identity.baseUrl)
    : identity.provider
      ? observedProviders.get(identity.provider)
      : undefined;
  return key == null ? undefined : observedCatalogs.get(key)?.get(identity.modelId);
}

/** Total concurrency across the catalogue's concrete (non-alias) models. */
export function gatewayCapacityTotal(entries: readonly GatewayModelEntry[]): number | undefined {
  let total = 0;
  let known = false;
  for (const entry of entries) {
    if (entry.alias) continue;
    const capacity = entry.activeLimit ?? entry.slots;
    if (capacity === undefined || capacity < 0) continue;
    known = true;
    total += capacity;
  }
  return known ? total : undefined;
}

export interface FetchCatalogOptions {
  /** Provider base URL, e.g. `https://llm.example.com/v1`. */
  baseUrl: string;
  /** Registry provider identity, when known by the caller. */
  providerId?: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** False for previews: do not publish scheduling capacity or request-body limits. */
  observeRuntime?: boolean;
}

/** The gateway this extension is built around, when nothing else is configured. */
export const DEFAULT_GATEWAY_BASE_URL = "https://llm.example.com/v1";

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
  opts.signal?.throwIfAborted();
  const base = (opts.baseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), opts.timeoutMs ?? 15_000);
  // Honour the caller's signal as well as our own deadline.
  const onAbort = () => timer.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      const existing = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (existing) delete headers[existing];
      if (value !== null) headers[name] = value;
    }
    const res = await doFetch(`${base}/models`, {
      headers,
      signal: timer.signal,
    });
    opts.signal?.throwIfAborted();
    if (!res.ok) throw new CatalogFetchError(`gateway returned ${res.status} for ${base}/models`, res.status);
    const body: unknown = await res.json().catch(() => null);
    const models = parseGatewayModels(body);
    // The request-body cap, however the gateway chose to advertise it: a
    // response header, a listing-level field, or per model. Recorded for the
    // live-path body guard (src/request/bodyBudget.ts).
    if (opts.observeRuntime !== false) {
      noteRequestLimitHeader(base, res.headers);
      // `x_max_request_bytes` is the gateway's extension-field convention (like
      // `x_context_window`); `max_request_bytes` is accepted as well.
      const listing = body as { x_max_request_bytes?: unknown; max_request_bytes?: unknown } | null;
      noteAdvertisedRequestLimit(base, listing?.x_max_request_bytes ?? listing?.max_request_bytes);
      for (const model of models) {
        if (model.maxRequestBytes !== undefined) noteAdvertisedRequestLimit(base, model.maxRequestBytes, model.id);
      }
    }
    if (models.length === 0) {
      throw new CatalogFetchError(`gateway returned no usable models from ${base}/models`, res.status);
    }
    if (opts.observeRuntime !== false) {
      const key = capacityKey(opts.providerId, base);
      observedCatalogs.set(
        key,
        new Map(
          models.flatMap((m) => {
            const n = m.activeLimit ?? m.slots;
            return n !== undefined && n >= 0 ? [[m.id, n] as [string, number]] : [];
          }),
        ),
      );
      if (opts.providerId) {
        const previous = observedProviders.get(opts.providerId);
        observedProviders.set(opts.providerId, previous === undefined || previous === key ? key : null);
      }
    }
    return models;
  } catch (err) {
    opts.signal?.throwIfAborted();
    if (err instanceof CatalogFetchError) throw err;
    throw new CatalogFetchError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
