/**
 * Minimal control-plane HTTP server (spec 02/08, deployment glue).
 *
 * Serves the normalized control-plane snapshot (projects/runs/workers/events)
 * that the EXTERNAL Pi Web operator UI consumes. This is pi-engineering-owned
 * adapter surface — NOT a Pi Web replacement. State is loaded from a JSONL
 * EventStore file so the server reconstructs the graph from events on start.
 *
 * Endpoints:
 *   GET /health       -> { status: "ok" }
 *   GET /control      -> the ControlPlane snapshot (JSON)
 *   POST /runs        -> create a run { projectId, goal }
 *   POST /workers     -> create a worker { projectId, role, runId? }
 *
 * Run: node --experimental-strip-types scripts/control-server.ts [port]
 */

import { createServer } from "node:http";
import { WorkGraph } from "../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../src/platform/eventstore/jsonl.ts";
import { Platform } from "../src/platform/index.ts";

async function boot(): Promise<Platform> {
  const file = process.env.PI_PLATFORM_STORE_FILE;
  const store = file ? await JsonlEventStore.open(file) : JsonlEventStore.inMemory();
  const platform = new Platform({
    store,
    workspaceName: process.env.PI_PLATFORM_WORKSPACE ?? "eng",
  });
  // A default project so the surface is non-empty on first boot.
  if (platform.registry.listProjects().length === 0) {
    platform.registry.registerProject({
      name: "default",
      canonicalRemote: process.env.PI_PLATFORM_PROJECT_REMOTE ?? null,
    });
    await platform.registry.flush();
  }
  return platform;
}

function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
  const platform = await boot();
  const server = createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") return send(200, { status: "ok" });
      if (req.method === "GET" && url.pathname === "/control") {
        await platform.graph.flush();
        await platform.registry.flush();
        return send(200, platform.controlPlane.snapshot());
      }
      if (req.method === "POST" && url.pathname === "/runs") {
        const b = await body(req);
        const run = platform.graph.createRun({ projectId: String(b.projectId), goal: String(b.goal) });
        await platform.graph.flush();
        return send(201, run);
      }
      if (req.method === "POST" && url.pathname === "/workers") {
        const b = await body(req);
        const w = platform.graph.createWorker({
          projectId: String(b.projectId),
          role: String(b.role),
          runId: b.runId ? String(b.runId) : null,
        });
        await platform.graph.flush();
        return send(201, w);
      }
      return send(404, { error: "not found" });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, () => {
    process.stdout.write(`control-plane listening on :${port}\n`);
  });
}

void main();
