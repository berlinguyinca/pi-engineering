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
 * Minimal Prometheus text-format metrics registry (no dependencies).
 * Exposed at GET /metrics so external monitoring (e.g. status.metabolomics.us)
 * can track this installation's health and load.
 */
class Metrics {
  constructor(labels) {
    this.labels = labels;
    this.requests = new Map(); // "method route status" -> count
    this.recordsGauge = 0;
    this.up = 1;
  }

  observeRequest(method, route, status) {
    const k = `${method} ${route} ${status}`;
    this.requests.set(k, (this.requests.get(k) || 0) + 1);
  }

  setRecords(n) {
    this.recordsGauge = n;
  }

  render() {
    const { kind, version, auth } = this.labels;
    const L = [];
    const esc = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
    const push = (line) => L.push(line);
    push("# HELP openviking_up 1 if the service is serving.");
    push("# TYPE openviking_up gauge");
    push(`openviking_up{kind=${esc(kind)},version=${esc(version)},auth=${esc(auth)}} ${this.up}`);
    push("# HELP openviking_memory_records Number of promoted durable memory records.");
    push("# TYPE openviking_memory_records gauge");
    push(`openviking_memory_records ${this.recordsGauge}`);
    push("# HELP openviking_requests_total Requests served by route and status.");
    push("# TYPE openviking_requests_total counter");
    for (const [k, v] of this.requests) {
      const [method, route, status] = k.split(" ");
      push(`openviking_requests_total{method=${esc(method)},route=${esc(route)},status=${status}} ${v}`);
    }
    return L.join("\n") + "\n";
  }
}

/**
 * @param {object} opts
 * @param {import("./store.mjs").MemoryStore | import("./store.mjs").PostgresStore} [opts.store]
 * @param {{ kind?: string; version?: string }} [opts.labels]
 */
export async function startServer({ port = 0, token, store = new MemoryStore(), logger = console, labels = {} }) {
  const metrics = new Metrics({
    kind: store.kind || "memory",
    version: "0.1.0",
    auth: token ? "on" : "off",
    ...labels,
  });
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, { store, token, logger, metrics });
    } catch (err) {
      // Never crash the process on an unexpected handler error.
      logger.error("openviking unhandled error", err);
      metrics.observeRequest(req.method || "?", req.url?.split("?")[0] || "/", 500);
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
async function handle(req, res, { store, token, logger, metrics }) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    // --- health (unauthenticated so container healthchecks work). Probes the
    // store so a DB outage surfaces as 503 instead of a false healthy. ------
    if (method === "GET" && url.pathname === "/health") {
      try {
        const n = (await store.recallAll()).length;
        metrics.setRecords(n);
        metrics.observeRequest("GET", "/health", 200);
        sendJson(res, 200, { status: "ok" });
      } catch {
        metrics.observeRequest("GET", "/health", 503);
        sendJson(res, 503, { status: "degraded" });
      }
      return;
    }

    // --- /metrics : Prometheus text format (unauthenticated for scraping) ---
    if (method === "GET" && url.pathname === "/metrics") {
      try {
        metrics.setRecords((await store.recallAll()).length);
      } catch {
        // records gauge stays at last known; service still reports itself up
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metrics.render());
      return;
    }

    // --- auth middleware -------------------------------------------------
    if (token) {
      const auth = req.headers.authorization || "";
      const ok = auth === `Bearer ${token}`;
      if (!ok) {
        metrics.observeRequest(method, url.pathname, 401);
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
        metrics.observeRequest("POST", "/memory", 400);
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!record || typeof record.id !== "string" || typeof record.text !== "string") {
        metrics.observeRequest("POST", "/memory", 400);
        sendJson(res, 400, { error: "record requires string id and text" });
        return;
      }
      // Validate array fields so a malformed record cannot poison later search.
      if (
        (record.sourceRefs != null && !Array.isArray(record.sourceRefs)) ||
        (record.evidenceIds != null && !Array.isArray(record.evidenceIds))
      ) {
        metrics.observeRequest("POST", "/memory", 400);
        sendJson(res, 400, { error: "sourceRefs and evidenceIds must be arrays" });
        return;
      }
      try {
        await store.store(record);
      } catch (err) {
        logger.error("openviking store error", err);
        metrics.observeRequest("POST", "/memory", 500);
        sendJson(res, 500, { error: "store unavailable" });
        return;
      }
      metrics.observeRequest("POST", "/memory", 201);
      sendJson(res, 201, { id: record.id });
      return;
    }

    // --- GET /memory : recall all ----------------------------------------
    if (method === "GET" && url.pathname === "/memory") {
      try {
        const all = await store.recallAll();
        metrics.setRecords(all.length);
        metrics.observeRequest("GET", "/memory", 200);
        sendJson(res, 200, all);
      } catch (err) {
        logger.error("openviking store error", err);
        metrics.observeRequest("GET", "/memory", 500);
        sendJson(res, 500, { error: "store unavailable" });
      }
      return;
    }

    // --- GET /memory/search?q= : relevance search --------------------------
    if (method === "GET" && url.pathname === "/memory/search") {
      const q = url.searchParams.get("q") || "";
      try {
        const hits = await store.search(q);
        metrics.setRecords(hits.length);
        metrics.observeRequest("GET", "/memory/search", 200);
        sendJson(res, 200, hits);
      } catch (err) {
        logger.error("openviking store error", err);
        metrics.observeRequest("GET", "/memory/search", 500);
        sendJson(res, 500, { error: "store unavailable" });
      }
      return;
    }

    metrics.observeRequest(method, url.pathname, 404);
    sendJson(res, 404, { error: "not found" });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}
