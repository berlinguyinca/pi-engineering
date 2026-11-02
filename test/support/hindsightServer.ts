/**
 * Minimal in-process Hindsight (herdr-memory) server for integration tests.
 *
 * Implements the bank contract the runtime's HindsightProvider targets
 * (src/blackhole/durable.ts):
 *
 *   POST /v1/default/banks/{bank}/memories          retain items
 *   POST /v1/default/banks/{bank}/memories/recall   semantic-ish recall
 *   DELETE /v1/default/banks/{bank}/documents/{id}  forget a document
 *
 * Bearer auth: when a token is configured, every request must carry
 * `Authorization: Bearer <token>`. Recall uses the same any-token relevance
 * rule the durable providers use (token length >= 2), so tests exercise real
 * search behavior without a model.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

export interface MockHindsight {
  url: string;
  port: number;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** A record matches when ANY whitespace-delimited query token (>= 2 chars) appears. */
function matches(content: string, query: string): boolean {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  const hay = content.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

export async function startHindsight(opts: { port?: number; token?: string } = {}): Promise<MockHindsight> {
  // bank name -> document_id -> content
  const banks = new Map<string, Map<string, string>>();
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const match = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/documents\/([^/]+)$/);
      if (match) {
        if (req.method !== "DELETE") {
          send(res, 405, { error: "method not allowed" });
          return;
        }
        const bank = banks.get(match[1]!);
        if (bank?.delete(match[2]!)) send(res, 200, { status: "deleted" });
        else send(res, 404, { error: "not found" });
        return;
      }
      const mem = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/memories(\/recall)?$/);
      if (!mem) {
        send(res, 404, { error: "not found" });
        return;
      }
      const bankName = mem[1]!;
      const body = (await readJson(req)) as Record<string, unknown>;
      if (mem[2]) {
        // recall: {query} -> {results: [{document_id, content}]}
        if (req.method !== "POST") {
          send(res, 405, { error: "method not allowed" });
          return;
        }
        const bank = banks.get(bankName) ?? new Map<string, string>();
        const query = String(body.query ?? "");
        const results = [...bank.entries()]
          .filter(([, content]) => matches(content, query))
          .map(([id, content]) => ({
            document_id: id,
            content,
          }));
        send(res, 200, { results });
        return;
      }
      // retain: {items: [{content, document_id, ...}], async}
      if (req.method !== "POST" || !Array.isArray(body.items)) {
        send(res, 400, { error: "items array required" });
        return;
      }
      const bank = banks.get(bankName) ?? new Map<string, string>();
      banks.set(bankName, bank);
      for (const item of body.items as Array<Record<string, unknown>>) {
        if (typeof item.document_id !== "string" || typeof item.content !== "string") {
          send(res, 400, { error: "item requires document_id and content" });
          return;
        }
        bank.set(item.document_id, item.content);
      }
      send(res, 200, { status: "ok" });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
