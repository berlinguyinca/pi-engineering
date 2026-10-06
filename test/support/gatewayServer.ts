/**
 * A real local HTTP server that speaks the OpenAI-compatible surface plus the
 * InferWeave extensions the planner/worker mode consumes
 * (docs/specs/planner-worker-inferweave-contract.md). Responses are
 * deterministic: each test supplies a responder that answers from the request.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatRequestRecord {
  model: string;
  system: string;
  user: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ScriptedReply {
  status?: number;
  /** Assistant message content (ignored when `body` is given). */
  content?: string;
  /** Raw JSON body (errors). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Model reported as the server of the request. */
  servedModel?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
  delayMs?: number;
}

export interface GatewayServer {
  baseUrl: string;
  requests: ChatRequestRecord[];
  setModels(models: unknown[]): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startGatewayServer(opts: {
  models?: unknown[];
  respond: (req: ChatRequestRecord, index: number) => ScriptedReply | Promise<ScriptedReply>;
}): Promise<GatewayServer> {
  let models = opts.models ?? [];
  const requests: ChatRequestRecord[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }
    if (req.method === "POST" && url.endsWith("/chat/completions")) {
      const body = JSON.parse(await readBody(req)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const record: ChatRequestRecord = {
        model: body.model,
        system: body.messages.find((m) => m.role === "system")?.content ?? "",
        user: body.messages.find((m) => m.role === "user")?.content ?? "",
        headers: req.headers,
      };
      const index = requests.length;
      requests.push(record);
      const reply = await opts.respond(record, index);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      const status = reply.status ?? 200;
      res.writeHead(status, { "content-type": "application/json", ...(reply.headers ?? {}) });
      if (reply.body !== undefined) {
        res.end(JSON.stringify(reply.body));
        return;
      }
      const usage = reply.usage ?? { prompt_tokens: Math.ceil(record.user.length / 4), completion_tokens: 50 };
      res.end(
        JSON.stringify({
          id: `chatcmpl-${index}`,
          object: "chat.completion",
          model: reply.servedModel ?? body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: reply.content ?? "" } }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.prompt_tokens + usage.completion_tokens,
            prompt_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
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
      models = next;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
