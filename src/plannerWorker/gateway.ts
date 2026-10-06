/**
 * Client side of the planner/worker ↔ InferWeave contract
 * (docs/specs/planner-worker-inferweave-contract.md).
 *
 * Everything here is tolerant by design: a plain OpenAI-compatible gateway
 * that knows nothing about aliases, capabilities or route generations still
 * works — the extended fields are simply absent and role resolution falls back
 * to the static role pins.
 */

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
}

export type ChatOutcome =
  | { ok: true; content: string; usage: ChatUsage; served: ServedRoute; wallMs: number }
  | { ok: false; status: number; message: string; wallMs: number; error?: unknown };

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
    const res = await fetch(`${base(conn)}/chat/completions`, {
      method: "POST",
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
      signal: AbortSignal.any([AbortSignal.timeout(conn.timeoutMs ?? 600_000), ...(req.signal ? [req.signal] : [])]),
    });
    const text = await res.text();
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
    const alias = res.headers.get("x-inferweave-route");
    if (alias) served.alias = alias;
    const generation = num(res.headers.get("x-inferweave-route-generation"));
    if (generation !== undefined) served.generation = generation;
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
