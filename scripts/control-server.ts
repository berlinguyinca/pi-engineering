/**
 * Minimal control-plane HTTP server (spec 02/08, deployment glue).
 *
 * Serves the normalized control-plane snapshot (projects/runs/workers/events)
 * that the EXTERNAL Pi Web operator UI consumes. This is pi-engineering-owned
 * adapter surface — NOT a Pi Web replacement. State is loaded from a JSONL
 * EventStore file so the server reconstructs the graph from events on start.
 *
 * Endpoints:
 *   GET /health       -> { status: "ok" }          (no credential required)
 *   GET /control      -> the ControlPlane snapshot (JSON)
 *   POST /runs        -> create a run { projectId, goal }
 *   POST /workers     -> create a worker { projectId, role, runId? }
 *
 * ── Exposure ───────────────────────────────────────────────────────────────
 *
 * Binds to LOOPBACK by default. A fresh-context review found this serving an
 * unauthenticated snapshot — including raw git remotes and absolute host paths
 * — on every interface, and found that one unauthenticated POST could kill the
 * process. Reaching it from another host is now a deliberate act:
 *
 *   PI_PLATFORM_BIND=0.0.0.0  PI_PLATFORM_TOKEN=<secret>
 *
 * and a token is REQUIRED whenever the bind address is not loopback: the
 * server refuses to start otherwise, rather than coming up open. The token is
 * compared in constant time and carried in `authorization: Bearer <token>`.
 *
 * This is a deployment control, not an authorization model. Per-project
 * authorization (`ProjectAuth` in src/platform/security.ts) is NOT wired in
 * here — every holder of the token can see and do everything this server
 * offers.
 *
 * Run: node --experimental-strip-types scripts/control-server.ts [port]
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { RemoteHttpTransport } from "../src/platform/RemoteHttpTransport.ts";
import { JsonlEventStore } from "../src/platform/eventstore/jsonl.ts";
import { Platform } from "../src/platform/index.ts";

/** Largest request body accepted. A control call is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;
/** Longest free-text field accepted (a goal, a role). */
const MAX_FIELD_LENGTH = 4_096;
/** Request must arrive within this, so a half-open socket cannot park a handler. */
const REQUEST_TIMEOUT_MS = 15_000;

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

/**
 * Read a bounded JSON body.
 *
 * Three things the previous version did not do: cap the size (a 64 MiB body
 * amplified into every later `/control` response and onto disk), settle on a
 * client abort (a socket destroyed mid-body left the handler awaiting forever,
 * holding the accumulated bytes), and reject rather than buffer past the cap.
 */
function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = (err: Error) => {
      req.removeAllListeners();
      reject(err);
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        fail(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const data = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        fail(new Error("invalid JSON"));
      }
    });
    // Without these a client that announces a Content-Length and then destroys
    // the socket leaves this promise pending for the life of the process.
    req.on("error", (err) => fail(err instanceof Error ? err : new Error("request error")));
    req.on("aborted", () => fail(new Error("request aborted")));
    req.on("close", () => {
      if (!req.readableEnded) fail(new Error("request closed"));
    });
  });
}

/** A required, length-capped string field. Throws `BadRequest` when it is not. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequest(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_FIELD_LENGTH) throw new BadRequest(`${field} exceeds ${MAX_FIELD_LENGTH} characters`);
  return value;
}

class BadRequest extends Error {}

/** Constant-time token comparison, so a wrong token leaks nothing by timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
  const bind = process.env.PI_PLATFORM_BIND ?? "127.0.0.1";
  const token = process.env.PI_PLATFORM_TOKEN ?? "";

  // Refuse to come up open. Binding beyond loopback without a credential is
  // how an internal tool becomes an unauthenticated public endpoint, and the
  // snapshot this serves is exactly the thing not to publish.
  if (!isLoopback(bind) && !token) {
    process.stderr.write(
      `control-plane: refusing to bind ${bind} without PI_PLATFORM_TOKEN.\nSet a token, or leave PI_PLATFORM_BIND unset to listen on loopback only.\n`,
    );
    process.exitCode = 2;
    return;
  }

  const platform = await boot();
  const remoteHttp = new RemoteHttpTransport(platform);

  // Reflect this node into the stack node-registry (best-effort, Phase 2-lite).
  const nodeRegistryUrl = process.env.PI_PLATFORM_NODE_REGISTRY_URL || "";
  const thisNodeId = process.env.PI_PLATFORM_NODE_ID || "local";
  const thisNodeEndpoint = process.env.PI_PLATFORM_NODE_ENDPOINT || "";
  async function reflectNode() {
    if (!nodeRegistryUrl) return;
    try {
      await fetch(`${nodeRegistryUrl.replace(/\/$/, "")}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          node_id: thisNodeId,
          name: thisNodeId,
          endpoint: thisNodeEndpoint,
          capabilities: { control_plane: true },
        }),
      });
    } catch {
      /* non-fatal: registry is stack-owned and may be absent */
    }
  }

  const server = createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      // Liveness stays open so a probe needs no credential; it reveals nothing.
      if (req.method === "GET" && url.pathname === "/health") return send(200, { status: "ok" });

      if (token) {
        const header = req.headers.authorization ?? "";
        const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!supplied || !tokenMatches(supplied, token)) return send(401, { error: "unauthorized" });
      }

      if (req.method === "GET" && url.pathname === "/control") {
        await platform.graph.flush();
        await platform.registry.flush();
        return send(200, platform.controlPlane.snapshot());
      }
      // CAV status/evidence surface for external pi-web (pi-engineering-owned
      // adapter data; NOT a pi-web implementation). Requires token (non-loopback).
      if (req.method === "GET" && url.pathname === "/cav") {
        const { buildCavSurface } = await import("../src/cav/statusSurface.ts");
        const { loadCavSteps } = await import("../src/cav/steps.ts");
        const { CavEvidenceLedger } = await import("../src/cav/evidence.ts");
        const { resolve } = await import("node:path");
        const { readdirSync } = await import("node:fs");
        const repo = resolve(import.meta.dirname, "..");
        const stepsDir = `${repo}/docs/specs/cav/steps`;
        let steps = loadCavSteps(stepsDir);
        if (steps.length === 0) {
          try {
            readdirSync(stepsDir);
          } catch {
            steps = [];
          }
        }
        // Evidence file is overridable so deployments/tests can point the surface
        // at a seeded ledger instead of the gitignored local default.
        const evidenceFile = process.env.PI_CAV_EVIDENCE_FILE ?? `${repo}/.pi-eng/cav/evidence.jsonl`;
        const ledger = await CavEvidenceLedger.open(evidenceFile);
        return send(200, buildCavSurface(steps, ledger));
      }
      if (req.method === "POST" && url.pathname === "/runs") {
        const b = await body(req);
        const run = platform.graph.createRun({
          projectId: requiredString(b.projectId, "projectId"),
          goal: requiredString(b.goal, "goal"),
        });
        // `flush` now REPORTS write failures rather than swallowing them, so a
        // run whose event never reached the store answers 5xx instead of 201.
        await platform.graph.flush();
        return send(201, run);
      }
      if (req.method === "POST" && url.pathname === "/workers") {
        const b = await body(req);
        const w = platform.graph.createWorker({
          projectId: requiredString(b.projectId, "projectId"),
          role: requiredString(b.role, "role"),
          runId: b.runId === undefined || b.runId === null ? null : requiredString(b.runId, "runId"),
        });
        await platform.graph.flush();
        return send(201, w);
      }
      if (req.method === "GET" && url.pathname === "/worker/attach") {
        // A remote node agent dials in and attaches an outbound channel.
        remoteHttp.attach(
          requiredString(url.searchParams.get("workerId"), "workerId"),
          {
            projectId: requiredString(url.searchParams.get("projectId"), "projectId"),
            role: requiredString(url.searchParams.get("role"), "role"),
            node: url.searchParams.get("node") ?? "remote",
          },
          req,
          res,
        );
        await reflectNode();
        await platform.graph.flush();
        return; // SSE response is owned by the transport.
      }
      if (req.method === "POST" && url.pathname === "/worker/result") {
        const b = await body(req);
        const resolved = remoteHttp.result(b);
        await platform.graph.flush();
        if (resolved) return send(200, { accepted: true });
        return send(404, { error: "unknown or expired correlationId" });
      }
      return send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof BadRequest) return send(400, { error: err.message });
      if (err instanceof Error && (err.message === "body too large" || err.message === "invalid JSON")) {
        return send(400, { error: err.message });
      }
      // Opaque on purpose. This is a catch-all around every handler, and Node's
      // fs errors carry absolute paths — echoing `err.message` handed internal
      // detail to whoever sent the request. The detail goes to the operator's
      // own stderr instead, with an id the two can be correlated by.
      const correlation = Math.random().toString(36).slice(2, 10);
      process.stderr.write(`control-plane error [${correlation}]: ${err instanceof Error ? err.stack : String(err)}\n`);
      return send(500, { error: "internal error", id: correlation });
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.listen(port, bind, () => {
    const scope = isLoopback(bind) ? "loopback only" : `${bind} (token required)`;
    process.stdout.write(`control-plane listening on ${bind}:${port} — ${scope}\n`);
    void reflectNode();
  });
}

void main();
