/**
 * OpenViking HTTP service — the cross-machine durable-memory endpoint.
 *
 * Serves the exact contract expected by the runtime's `OpenVikingProvider`
 * (src/blackhole/durable.ts):
 *
 *   POST {base}/memory            store (promote) a DurableMemoryRecord
 *   GET  {base}/memory            recall all promoted records
 *   GET  {base}/memory/search?q=  token-relevance search
 *   GET  {base}/health            liveness (for docker healthcheck)
 *
 * Optional Bearer-token auth: when OPENVIKING_TOKEN is set, every request must
 * carry `Authorization: Bearer <token>` (matching OpenVikingProvider).
 *
 * Storage is chosen by env:
 *   DATABASE_URL set  => PostgresStore (tier-1 production)
 *   otherwise         => MemoryStore (dev / tests, zero dependencies)
 *
 * Uses only node:http + node:pg (pg loaded lazily for Postgres mode), so the
 * service has no framework dependency and no build step.
 */
import { createServer } from "node:http";
import { MemoryStore } from "./store.mjs";

/**
 * @param {object} opts
 * @param {import("./store.mjs").MemoryStore | import("./store.mjs").PostgresStore} [opts.store]
 */
export async function startServer({ port = 0, token, store = new MemoryStore(), logger = console }) {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, { store, token, logger });
    } catch (err) {
      // Never crash the process on an unexpected handler error.
      logger.error("openviking unhandled error", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  await store.init();
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    port: actualPort,
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(async () => {
          if (typeof store.close === "function") await store.close();
          resolve();
        });
      }),
  };
}

/** Route a single request. Throwing here is caught by the server wrapper. */
async function handle(req, res, { store, token, logger }) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    // --- health (unauthenticated so container healthchecks work). Probes the
    // store so a DB outage surfaces as 503 instead of a false healthy. ------
    if (method === "GET" && url.pathname === "/health") {
      try {
        await store.recallAll();
        sendJson(res, 200, { status: "ok" });
      } catch {
        sendJson(res, 503, { status: "degraded" });
      }
      return;
    }

    // --- auth middleware -------------------------------------------------
    if (token) {
      const auth = req.headers.authorization || "";
      const ok = auth === `Bearer ${token}`;
      if (!ok) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // --- POST /memory : promote ------------------------------------------
    if (method === "POST" && url.pathname === "/memory") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let record;
      try {
        record = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!record || typeof record.id !== "string" || typeof record.text !== "string") {
        sendJson(res, 400, { error: "record requires string id and text" });
        return;
      }
      // Validate array fields so a malformed record cannot poison later search.
      if (
        (record.sourceRefs != null && !Array.isArray(record.sourceRefs)) ||
        (record.evidenceIds != null && !Array.isArray(record.evidenceIds))
      ) {
        sendJson(res, 400, { error: "sourceRefs and evidenceIds must be arrays" });
        return;
      }
      try {
        await store.store(record);
      } catch (err) {
        logger.error("openviking store error", err);
        sendJson(res, 500, { error: "store unavailable" });
        return;
      }
      sendJson(res, 201, { id: record.id });
      return;
    }

    // --- GET /memory : recall all ----------------------------------------
    if (method === "GET" && url.pathname === "/memory") {
      try {
        const all = await store.recallAll();
        sendJson(res, 200, all);
      } catch (err) {
        logger.error("openviking store error", err);
        sendJson(res, 500, { error: "store unavailable" });
      }
      return;
    }

    // --- GET /memory/search?q= : relevance search --------------------------
    if (method === "GET" && url.pathname === "/memory/search") {
      const q = url.searchParams.get("q") || "";
      try {
        const hits = await store.search(q);
        sendJson(res, 200, hits);
      } catch (err) {
        logger.error("openviking store error", err);
        sendJson(res, 500, { error: "store unavailable" });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}
