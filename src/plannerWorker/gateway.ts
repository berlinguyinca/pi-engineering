/**
 * Client side of the planner/worker ↔ InferWeave contract
 * (docs/specs/planner-worker-inferweave-contract.md).
 *
 * Everything here is tolerant by design: a plain OpenAI-compatible gateway
 * that knows nothing about aliases, capabilities or route generations still
 * works — the extended fields are simply absent and role resolution falls back
 * to the static role pins.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseAdmissionPayload } from "../inference/admissionContract.ts";

/** A model or logical route as the gateway advertises it on `GET /models`. */
export interface CatalogModel {
  id: string;
  /** True when `id` is a logical route (alias) rather than a concrete model. */
  alias: boolean;
  /** Concrete model currently backing an alias, when advertised. */
  backing?: string;
  /** Logical aliases a concrete model currently serves. */
  aliases: string[];
  capabilities: string[];
  family?: string;
  sizeClass?: string;
  contextWindow?: number;
  modalities: string[];
  tools?: boolean;
  structuredOutput?: boolean;
  /** Gateway readiness: hot/warm/cold/loading/draining/unavailable. */
  state?: string;
  /** Current load 0..1. */
  load?: number;
  routeGeneration?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function strs(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => s !== undefined);
  const s = str(v);
  return s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Parse a `/models` listing, keeping every extended field the gateway offers. */
export function parseCatalog(payload: unknown): CatalogModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    const backing = str(row.x_backing_model);
    const contextWindow = num(row.ctx_per_request) ?? num(row.x_context_window) ?? num(row.context_length);
    const model: CatalogModel = {
      id,
      alias: row.x_alias === true || backing !== undefined,
      aliases: strs(row.x_aliases),
      capabilities: strs(row.x_capabilities ?? row.capabilities),
      modalities: strs(row.x_modalities),
    };
    if (backing) model.backing = backing;
    const family = str(row.x_family);
    if (family) model.family = family;
    const sizeClass = str(row.x_size_class);
    if (sizeClass) model.sizeClass = sizeClass;
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const tools = bool(row.x_tools);
    if (tools !== undefined) model.tools = tools;
    const structured = bool(row.x_structured_output);
    if (structured !== undefined) model.structuredOutput = structured;
    const state = str(row.x_state) ?? str(row.state);
    if (state) model.state = state.toLowerCase();
    const load = num(row.x_load);
    if (load !== undefined) model.load = load;
    const generation = num(row.x_route_generation);
    if (generation !== undefined) model.routeGeneration = generation;
    out.push(model);
  }
  return out;
}

export interface GatewayConnection {
  /** Base URL including `/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Opt-in per-request limit. Catalogue/route probes default to a few seconds; completions have none. */
  timeoutMs?: number;
}

function headersFor(conn: GatewayConnection, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
    ...extra,
  };
}

function base(conn: GatewayConnection): string {
  return conn.baseUrl.replace(/\/+$/, "");
}

/** Fetch the catalogue. Returns [] (never throws) when the gateway is unreachable. */
export async function fetchCatalog(conn: GatewayConnection, signal?: AbortSignal): Promise<CatalogModel[]> {
  try {
    const res = await fetch(`${base(conn)}/models`, {
      headers: headersFor(conn),
      signal: AbortSignal.any([AbortSignal.timeout(conn.timeoutMs ?? 15_000), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) return [];
    return parseCatalog(await res.json().catch(() => null));
  } catch {
    return [];
  }
}

/** Capability constraints sent alongside a request (spec §9). */
export interface CapabilityRequest {
  capabilities?: string[];
  minimumContext?: number;
  preferredFamily?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/** Route identity the gateway reports for a served request. */
export interface ServedRoute {
  /** Model id the client asked for (alias or concrete). */
  requested: string;
  /** Concrete model that actually served the request. */
  model: string;
  alias?: string;
  generation?: number;
  /** True when a route resolved to something other than its target. */
  fallback?: boolean;
}

export type ChatOutcome =
  | { ok: true; content: string; usage: ChatUsage; served: ServedRoute; wallMs: number }
  | { ok: false; status: number; message: string; wallMs: number; error?: unknown };

/**
 * POST over node:http(s). Node's global fetch carries undici's default 300 s
 * headers/body timeouts — a fixed wall clock on a non-streaming completion
 * that may wait on admission and generate for far longer. This request has no
 * timeout of its own: only `signal` ends it.
 */
function postNoTimeouts(
  url: string,
  opts: { headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<{ ok: boolean; status: number; headers: Headers; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: "POST",
        headers: { ...opts.headers, "content-length": String(Buffer.byteLength(opts.body)) },
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, headers, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** One non-streaming chat completion. */
export async function chatCompletion(
  conn: GatewayConnection,
  req: {
    model: string;
    system: string;
    user: string;
    capability?: CapabilityRequest;
    signal?: AbortSignal;
  },
): Promise<ChatOutcome> {
  const started = Date.now();
  const extra: Record<string, string> = {};
  if (req.capability?.capabilities?.length) extra["x-inferweave-capabilities"] = req.capability.capabilities.join(",");
  if (req.capability?.minimumContext) extra["x-inferweave-min-context"] = String(req.capability.minimumContext);
  if (req.capability?.preferredFamily) extra["x-inferweave-prefer-family"] = req.capability.preferredFamily;
  try {
    const res = await postNoTimeouts(`${base(conn)}/chat/completions`, {
      headers: headersFor(conn, extra),
      body: JSON.stringify({
        model: req.model,
        stream: false,
        temperature: 0,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
      // No default wall-clock cap (docs/mission-time-limits.md): a completion
      // may wait on gateway admission or generate for as long as it needs.
      // Only an explicit `timeoutMs` or the caller's signal ends it early.
      signal: AbortSignal.any([
        ...(conn.timeoutMs !== undefined ? [AbortSignal.timeout(conn.timeoutMs)] : []),
        ...(req.signal ? [req.signal] : []),
      ]),
    });
    const text = res.text;
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: messageOf(body) ?? text.slice(0, 300),
        wallMs: Date.now() - started,
        error: { body, headers: Object.fromEntries(res.headers.entries()) },
      };
    }
    const b = (body ?? {}) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      };
    };
    const content = b.choices?.[0]?.message?.content;
    const served: ServedRoute = {
      requested: req.model,
      model: res.headers.get("x-inferweave-model") ?? str(b.model) ?? req.model,
    };
    // Route headers come only for a route or capability request (a request by
    // model name keeps exactly the headers it always had).
    const alias = res.headers.get("x-inferweave-route");
    if (alias) {
      served.alias = alias;
      const generation = num(res.headers.get("x-inferweave-route-generation"));
      if (generation !== undefined) served.generation = generation;
      const fallback = res.headers.get("x-inferweave-route-fallback");
      if (fallback !== null) served.fallback = fallback.trim().toLowerCase() === "true";
    }
    return {
      ok: true,
      content: typeof content === "string" ? content : "",
      usage: {
        promptTokens: num(b.usage?.prompt_tokens) ?? 0,
        completionTokens: num(b.usage?.completion_tokens) ?? 0,
        cachedTokens: num(b.usage?.prompt_tokens_details?.cached_tokens) ?? 0,
      },
      served,
      wallMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
      wallMs: Date.now() - started,
    };
  }
}

function messageOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { error?: unknown; message?: unknown };
  if (typeof b.message === "string") return b.message;
  if (b.error && typeof b.error === "object") {
    const m = (b.error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  if (typeof b.error === "string") return b.error;
  const admission = parseAdmissionPayload(body);
  return admission?.message;
}

/** Availability codes InferWeave reports (spec §16). */
export const AVAILABILITY_CODES = [
  "NO_WORKERS",
  "MODEL_UNAVAILABLE",
  "MODEL_LOADING",
  "CAPACITY_EXHAUSTED",
  "NODE_DRAINING",
  "NODE_LOST",
] as const;
export type AvailabilityCode = (typeof AVAILABILITY_CODES)[number];

export interface AvailabilityError {
  code: AvailabilityCode;
  status: number;
  message: string;
  retryAfterMs?: number;
  /** Comparable models the gateway suggests (same shape as `/models` rows). */
  candidates: CatalogModel[];
  /** Route or canonical capability query the refusal concerns, when any. */
  route?: string;
  routeGeneration?: number;
}

/**
 * Protocol `code`/admission `reason` tokens mapped onto availability codes,
 * for gateways that do not send `x_availability` (older InferWeave, other
 * gateways). InferWeave's own refusals carry the precise value in
 * `x_availability` / `X-InferWeave-Error-Code`, which always wins.
 */
const REASON_CODES: Readonly<Record<string, AvailabilityCode>> = {
  no_workers: "NO_WORKERS",
  capacity_unavailable: "NO_WORKERS",
  model_unavailable: "MODEL_UNAVAILABLE",
  model_not_found: "MODEL_UNAVAILABLE",
  unsupported_model_capability: "MODEL_UNAVAILABLE",
  context_window_exceeded: "MODEL_UNAVAILABLE",
  model_weights_do_not_fit: "MODEL_UNAVAILABLE",
  model_loading: "MODEL_LOADING",
  model_activating: "MODEL_LOADING",
  capacity_exhausted: "CAPACITY_EXHAUSTED",
  worker_saturated: "CAPACITY_EXHAUSTED",
  queue_limit_reached: "CAPACITY_EXHAUSTED",
  queue_deadline_exceeded: "CAPACITY_EXHAUSTED",
  request_not_queueable: "CAPACITY_EXHAUSTED",
  caller_hard_quota: "CAPACITY_EXHAUSTED",
  node_draining: "NODE_DRAINING",
  node_lost: "NODE_LOST",
  routing_snapshot_expired: "NODE_LOST",
};

function asCode(v: unknown): AvailabilityCode | undefined {
  if (typeof v !== "string") return undefined;
  const upper = v.trim().toUpperCase();
  if ((AVAILABILITY_CODES as readonly string[]).includes(upper)) return upper as AvailabilityCode;
  return REASON_CODES[v.trim().toLowerCase()];
}

/**
 * Classify a failed response's availability metadata. Accepts the
 * `error.code` / top-level `code` field, the `x-inferweave-error-code` header,
 * the admission payload's `reason`, and a 404 for an unknown model. Returns
 * null when the failure is not about availability.
 */
export function parseAvailabilityError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): AvailabilityError | null {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const err = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : {};
  const admission = parseAdmissionPayload(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let code =
    asCode(lower["x-inferweave-error-code"]) ??
    asCode(err.x_availability) ??
    asCode(err.code) ??
    asCode(root.code) ??
    asCode(admission?.reason) ??
    asCode(err.type);
  const message = messageOf(body) ?? `HTTP ${status}`;
  if (!code && status === 404 && /model/i.test(message)) code = "MODEL_UNAVAILABLE";
  if (!code) return null;
  const retryAfterMs =
    num(err.retry_after_ms) ??
    num(root.retry_after_ms) ??
    admission?.retryAfterMs ??
    (num(lower["retry-after"]) !== undefined ? (num(lower["retry-after"]) as number) * 1000 : undefined);
  const rawCandidates = [err.x_fallback_candidates, err.candidates, root.candidates].find(Array.isArray) ?? [];
  const route = str(err.x_route);
  const routeGeneration = num(err.x_route_generation);
  return {
    code,
    status,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    candidates: parseCatalog({ data: rawCandidates }),
    ...(route ? { route } : {}),
    ...(routeGeneration !== undefined ? { routeGeneration } : {}),
  };
}

/** Best-effort classification of a flattened error string (non-HTTP executors). */
export function availabilityFromText(text: string | undefined): AvailabilityCode | null {
  if (!text) return null;
  const m = text.match(/\b(NO_WORKERS|MODEL_UNAVAILABLE|MODEL_LOADING|CAPACITY_EXHAUSTED|NODE_DRAINING|NODE_LOST)\b/);
  if (m) return m[1] as AvailabilityCode;
  if (/model_not_found|unknown-model|model .* (not found|is not served)/i.test(text)) return "MODEL_UNAVAILABLE";
  return null;
}

export type AvailabilityDecision = { action: "wait"; ms: number } | { action: "retry_same" } | { action: "switch" };

/**
 * What to do about an availability failure (spec §16). Bounded: a model is
 * never retried forever — waits are capped and the third strike switches.
 */
export function decideAvailability(
  code: AvailabilityCode,
  strikes: number,
  retryAfterMs?: number,
): AvailabilityDecision {
  const wait = Math.min(Math.max(retryAfterMs ?? 2_000, 250), 30_000);
  switch (code) {
    case "MODEL_LOADING":
      return strikes < 3 ? { action: "wait", ms: wait } : { action: "switch" };
    case "CAPACITY_EXHAUSTED":
    case "NO_WORKERS":
      return strikes < 1 ? { action: "wait", ms: wait } : { action: "switch" };
    case "NODE_DRAINING":
      return strikes < 1 ? { action: "retry_same" } : { action: "switch" };
    default:
      return { action: "switch" };
  }
}

/** A logical route's backing model changed between two requests (spec §10). */
export interface RouteChange {
  alias: string;
  from: string;
  to: string;
  fromGeneration?: number;
  toGeneration?: number;
}

/** Tracks which concrete model each logical route served last. */
export class RouteTracker {
  private readonly last = new Map<string, { model: string; generation?: number }>();

  observe(served: ServedRoute): RouteChange | null {
    const alias = served.alias ?? (served.requested !== served.model ? served.requested : undefined);
    if (!alias) return null;
    const prev = this.last.get(alias);
    this.last.set(alias, {
      model: served.model,
      ...(served.generation !== undefined ? { generation: served.generation } : {}),
    });
    if (!prev) return null;
    const generationChanged =
      prev.generation !== undefined && served.generation !== undefined && prev.generation !== served.generation;
    if (prev.model === served.model && !generationChanged) return null;
    return {
      alias,
      from: prev.model,
      to: served.model,
      ...(prev.generation !== undefined ? { fromGeneration: prev.generation } : {}),
      ...(served.generation !== undefined ? { toGeneration: served.generation } : {}),
    };
  }

  current(alias: string): string | undefined {
    return this.last.get(alias)?.model;
  }
}

const QUERY_NAME = /^[a-z0-9._-]+$/;

/**
 * A capability query in InferWeave's grammar, usable as the `model` field:
 * `cap:<cap>[,<cap>…][?minimum_context=N&family=F&size_class=S]`. Capabilities
 * and minimum context are hard constraints (never relaxed); family and size
 * class are preferences. Returns null when a name is outside the grammar.
 */
export function capabilityQuery(q: {
  capabilities: string[];
  minimumContext?: number;
  family?: string;
  sizeClass?: string;
}): string | null {
  if (q.capabilities.length === 0 || !q.capabilities.every((c) => QUERY_NAME.test(c))) return null;
  const params: string[] = [];
  if (q.minimumContext !== undefined && Number.isInteger(q.minimumContext) && q.minimumContext > 0) {
    params.push(`minimum_context=${q.minimumContext}`);
  }
  if (q.family && QUERY_NAME.test(q.family)) params.push(`family=${q.family}`);
  if (q.sizeClass && ["small", "medium", "large", "xlarge"].includes(q.sizeClass))
    params.push(`size_class=${q.sizeClass}`);
  return `cap:${q.capabilities.join(",")}${params.length > 0 ? `?${params.join("&")}` : ""}`;
}

/** The gateway root for `/iw/v1/...` endpoints (base URLs end in `/v1`). */
function gatewayRoot(conn: GatewayConnection): string {
  return base(conn).replace(/\/v1$/, "");
}

async function getJson(conn: GatewayConnection, path: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(`${gatewayRoot(conn)}${path}`, {
      headers: headersFor(conn),
      signal: AbortSignal.timeout(conn.timeoutMs ?? 5_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** One InferWeave route lifecycle event (`route_event.json`). */
export interface RouteEvent {
  seq: number;
  atMs: number;
  kind:
    | "MODEL_ROUTE_RESOLVED"
    | "MODEL_LOADING"
    | "MODEL_READY"
    | "MODEL_DRAINING"
    | "MODEL_UNLOADED"
    | "MODEL_ROUTE_CHANGED"
    | "MODEL_UNAVAILABLE"
    | "MODEL_FALLBACK";
  generation: number;
  route?: string;
  model?: string;
  previousModel?: string;
  availability?: AvailabilityCode;
  reason?: string;
  inFlight?: number;
}

export interface RouteTable {
  generation: number;
  routes: Record<string, { target: string; fallbacks?: string[]; availability?: AvailabilityCode | null }>;
  retiring: string[];
}

/** `GET /iw/v1/routes`, or null when the gateway has no logical routes. */
export async function fetchRouteTable(conn: GatewayConnection): Promise<RouteTable | null> {
  const r = await getJson(conn, "/iw/v1/routes");
  if (!r || r.status !== 200 || !r.body || typeof r.body !== "object") return null;
  const b = r.body as { generation?: unknown; routes?: unknown; retiring?: unknown };
  const generation = num(b.generation);
  if (generation === undefined) return null;
  return {
    generation,
    routes: (b.routes && typeof b.routes === "object" ? b.routes : {}) as RouteTable["routes"],
    retiring: strs(b.retiring),
  };
}

/**
 * Incremental reader of `GET /iw/v1/routes/events?after=<seq>`. Polled at
 * inference boundaries (no background timer): a route swap shows up before
 * the next request is resolved, with no client restart. A gateway without
 * the endpoint is remembered as unsupported and never asked again.
 */
export class RouteEventFollower {
  private after: number | null = null;
  supported = true;
  private readonly conn: GatewayConnection;

  constructor(conn: GatewayConnection) {
    this.conn = conn;
  }

  async poll(): Promise<{ events: RouteEvent[]; dropped: number }> {
    if (!this.supported) return { events: [], dropped: 0 };
    const r = await getJson(this.conn, `/iw/v1/routes/events${this.after !== null ? `?after=${this.after}` : ""}`);
    if (!r) return { events: [], dropped: 0 };
    if (r.status === 404 || r.status === 405) {
      this.supported = false;
      return { events: [], dropped: 0 };
    }
    const b = (r.body ?? {}) as { events?: unknown; dropped?: unknown; after?: unknown };
    const events = (Array.isArray(b.events) ? b.events : []).filter(
      (e): e is RouteEvent => !!e && typeof e === "object" && typeof (e as RouteEvent).seq === "number",
    );
    const first = this.after === null;
    const next = num(b.after) ?? events.at(-1)?.seq;
    if (next !== undefined) this.after = next;
    else if (first) this.after = 0;
    // The first read only establishes the cursor: history before this
    // mission is not a transition of this mission.
    return first ? { events: [], dropped: 0 } : { events, dropped: num(b.dropped) ?? 0 };
  }
}
