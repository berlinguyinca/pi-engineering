/**
 * A real local HTTP server that speaks the OpenAI-compatible surface plus the
 * InferWeave logical-route extensions the planner/worker mode consumes, in
 * the shapes InferWeave actually emits (inferweave docs/specs/logical-routes.md;
 * pi docs/specs/planner-worker-inferweave-contract.md):
 *
 * - `/v1/models` rows with `x_context_window`, `x_capabilities`, `x_state`;
 *   one `x_alias` row per configured route (no `slots`);
 * - route headers ONLY for requests naming a route or a `cap:` query;
 * - `/iw/v1/routes` (table + generation) and `/iw/v1/routes/events?after=`;
 * - refusals keep the protocol `code`; availability is `x_availability` plus
 *   `X-InferWeave-Error-Code`, candidates are `x_fallback_candidates`.
 *
 * Responses are deterministic: each test supplies a responder.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatRequestRecord {
  model: string;
  system: string;
  user: string;
  headers: Record<string, string | string[] | undefined>;
  /** Concrete model the emulated routing resolved the request to. */
  resolved: string;
}

export interface ScriptedReply {
  status?: number;
  /** Assistant message content (ignored when `body` is given). */
  content?: string;
  /** Raw JSON body (errors). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Model reported as the server of the request (defaults to the resolved model). */
  servedModel?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
  delayMs?: number;
}

export interface RouteEvent {
  seq: number;
  atMs: number;
  kind: string;
  generation: number;
  route?: string;
  model?: string;
  previousModel?: string;
  reason?: string;
  availability?: string;
}

export interface GatewayServer {
  baseUrl: string;
  requests: ChatRequestRecord[];
  setModels(models: unknown[]): void;
  /** Hot swap: re-bind a route (bumps the generation, emits MODEL_ROUTE_CHANGED). */
  rebind(route: string, target: string): void;
  /** Append a lifecycle event (MODEL_DRAINING, MODEL_READY, …). */
  emit(event: Omit<RouteEvent, "seq" | "atMs" | "generation">): void;
  generation(): number;
  close(): Promise<void>;
}

/** A refusal exactly as InferWeave's adaptive router shapes it. */
export function inferweaveRefusal(opts: {
  code: string;
  availability: string;
  status?: number;
  message?: string;
  retryAfterMs?: number;
  route?: string;
  routeGeneration?: number;
  candidates?: unknown[];
}): ScriptedReply {
  return {
    status: opts.status ?? 503,
    headers: { "X-InferWeave-Error-Code": opts.availability },
    body: {
      error: {
        code: opts.code,
        message: opts.message ?? opts.code,
        retryable: true,
        action_code: "IW-ACT-RETRY-ALTERNATE",
        ...(opts.retryAfterMs !== undefined ? { retry_after_ms: opts.retryAfterMs } : {}),
        x_availability: opts.availability,
        ...(opts.route ? { x_route: opts.route, x_route_generation: opts.routeGeneration ?? 0 } : {}),
        x_fallback_candidates: opts.candidates ?? [],
      },
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface ModelRow {
  id: string;
  x_capabilities?: string[];
  [k: string]: unknown;
}

export async function startGatewayServer(opts: {
  models?: unknown[];
  /** Logical routes: name → target model. */
  routes?: Record<string, string>;
  respond: (req: ChatRequestRecord, index: number) => ScriptedReply | Promise<ScriptedReply>;
}): Promise<GatewayServer> {
  let models = (opts.models ?? []) as ModelRow[];
  const routes = new Map(Object.entries(opts.routes ?? {}));
  let generation = routes.size > 0 ? 1 : 0;
  const events: RouteEvent[] = [];
  let seq = 0;
  const push = (e: Omit<RouteEvent, "seq" | "atMs" | "generation">) => {
    seq += 1;
    events.push({ ...e, seq, atMs: Date.now(), generation });
  };
  const requests: ChatRequestRecord[] = [];

  const catalogue = () => [
    ...models,
    ...[...routes.entries()].map(([name, target]) => {
      const t = models.find((m) => m.id === target);
      return {
        id: name,
        object: "model",
        x_alias: true,
        x_backing_model: target,
        x_route_generation: generation,
        x_capabilities: t?.x_capabilities ?? [],
        x_context_window: t?.x_context_window,
        x_state: t?.x_state ?? "hot",
      };
    }),
  ];

  /** Emulated resolution: route name, `cap:` query, or a plain model name. */
  const resolve = (model: string): { resolved: string; route?: string } => {
    const target = routes.get(model);
    if (target) return { resolved: target, route: model };
    if (model.startsWith("cap:")) {
      const caps = model.slice(4).split("?")[0]!.split(",");
      const hit = models.find((m) => caps.every((c) => m.x_capabilities?.includes(c)));
      return { resolved: hit?.id ?? model, route: model };
    }
    return { resolved: model };
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.endsWith("/v1/models")) return json(200, { object: "list", data: catalogue() });
    if (req.method === "GET" && url.startsWith("/iw/v1/routes/events")) {
      if (routes.size === 0 && events.length === 0) return json(404, { error: { code: "not_found" } });
      const after = Number(new URL(url, "http://x").searchParams.get("after") ?? -1);
      const out = events.filter((e) => e.seq > after);
      return json(200, { events: out, dropped: 0, after: out.at(-1)?.seq ?? (after >= 0 ? after : null) });
    }
    if (req.method === "GET" && url === "/iw/v1/routes") {
      if (routes.size === 0) return json(404, { error: { code: "not_found" } });
      return json(200, {
        generation,
        routes: Object.fromEntries(
          [...routes].map(([n, t]) => [n, { target: t, fallbacks: [], availability: null, pending: null }]),
        ),
        models: {},
        retiring: [],
      });
    }
    if (req.method === "POST" && url.endsWith("/chat/completions")) {
      const body = JSON.parse(await readBody(req)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const { resolved, route } = resolve(body.model);
      const record: ChatRequestRecord = {
        model: body.model,
        system: body.messages.find((m) => m.role === "system")?.content ?? "",
        user: body.messages.find((m) => m.role === "user")?.content ?? "",
        headers: req.headers,
        resolved,
      };
      const index = requests.length;
      requests.push(record);
      const reply = await opts.respond(record, index);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      const status = reply.status ?? 200;
      const served = reply.servedModel ?? resolved;
      // Route metadata only for a route or capability request (acceptance 15).
      const routeHeaders: Record<string, string> = route
        ? {
            "X-InferWeave-Route": route,
            "X-InferWeave-Model": served,
            "X-InferWeave-Route-Generation": String(generation),
            "X-InferWeave-Route-Fallback": "false",
          }
        : {};
      if (reply.body !== undefined) return json(status, reply.body, { ...(reply.headers ?? {}) });
      const usage = reply.usage ?? { prompt_tokens: Math.ceil(record.user.length / 4), completion_tokens: 50 };
      return json(
        status,
        {
          id: `chatcmpl-${index}`,
          object: "chat.completion",
          model: served,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply.content ?? "" } }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.prompt_tokens + usage.completion_tokens,
            prompt_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
          },
        },
        { ...routeHeaders, ...(reply.headers ?? {}) },
      );
    }
    return json(404, { error: { message: "not found" } });
  };
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setModels(next) {
      models = next as ModelRow[];
    },
    rebind(route, target) {
      const previous = routes.get(route);
      routes.set(route, target);
      generation += 1;
      push({ kind: "MODEL_ROUTE_CHANGED", route, model: target, ...(previous ? { previousModel: previous } : {}) });
    },
    emit: push,
    generation: () => generation,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
