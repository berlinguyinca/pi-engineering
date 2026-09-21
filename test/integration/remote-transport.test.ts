import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it, afterEach } from "node:test";
import { Platform } from "../../src/platform/index.ts";
import { RemoteHttpTransport } from "../../src/platform/RemoteHttpTransport.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { WorkerCommandEnvelope } from "../../src/platform/RemoteWorker.ts";

const servers: Array<ReturnType<typeof createServer>> = [];
const platforms: Platform[] = [];
const transports: RemoteHttpTransport[] = [];

function startControl(platform: Platform, transport: RemoteHttpTransport): Promise<{ url: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/worker/attach") {
      transport.attach(
        url.searchParams.get("workerId") ?? "",
        {
          projectId: url.searchParams.get("projectId") ?? "PRJ",
          role: url.searchParams.get("role") ?? "worker",
          node: url.searchParams.get("node") ?? "remote",
        },
        req,
        res,
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/worker/result") {
      let body = "";
      for await (const chunk of req) body += chunk;
      transport.result(JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    });
  });
}

/** Minimal remote agent (mirrors docker/remote-agent/agent.mjs protocol). */
function runAgent(control: string, workerId: string) {
  const controller = () => {
    let event = "message";
    const lines: string[] = [];
    const flush = () => {
      if (lines.length === 0) return;
      const data = lines.join("\n");
      lines.length = 0;
      if (event !== "command") return;
      const env = JSON.parse(data) as WorkerCommandEnvelope;
      const base = { workerId: env.workerId, generation: env.generation };
      const result = env.command.kind === "heartbeat"
        ? { ...base, ok: true, ack: "remote-alive" }
        : env.command.kind === "run_task"
          ? { ...base, ok: false, ack: "remote task execution not yet wired" }
          : { ...base, ok: true, ack: "ack" };
      void fetch(`${control}/worker/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...result, correlationId: env.correlationId }),
      });
    };
    void (async () => {
      while (true) {
        try {
          const res = await fetch(`${control}/worker/attach?workerId=${workerId}&projectId=PRJ&role=worker&node=agent-node`);
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of frame.split("\n").filter((l) => !l.startsWith(":"))) {
                if (line.startsWith("event:")) { event = line.slice(6).trim(); lines.length = 0; }
                else if (line.startsWith("data:")) lines.push(line.slice(5).trim());
              }
              flush();
            }
          }
        } catch {
          /* reconnect */
        }
        await new Promise((r) => {
          const t = setTimeout(r, 50);
          t.unref?.();
        });
      }
    })();
  };
  controller();
}

afterEach(() => {
  for (const t of transports.splice(0)) t.dispose();
  for (const p of platforms.splice(0)) p.remote.dispose();
  for (const s of servers.splice(0)) s.close();
});

describe("RemoteHttpTransport (spec 12, Phase 2-lite)", () => {
  it("attaches an outbound channel and round-trips a heartbeat", async () => {
    const platform = new Platform({ store: JsonlEventStore.inMemory() });
    platforms.push(platform);
    const transport = new RemoteHttpTransport(platform);
    transports.push(transport);
    const { url } = await startControl(platform, transport);

    runAgent(url, "wrk-hello");
    // Wait for attach + first heartbeat round-trip.
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(transport.isAttached("wrk-hello"), true);
    const worker = platform.graph.getWorker("wrk-hello");
    assert.ok(worker, "worker was created by attach");
    assert.equal(worker.location.host, "agent-node");
    assert.equal(worker.location.remote, true);

    const result = await platform.remote.dispatch("wrk-hello", { kind: "heartbeat" });
    assert.equal(result.ok, true);
    assert.equal(result.ack, "remote-alive");
  });

  it("answers run_task with an honest not-yet-wired stub", async () => {
    const platform = new Platform({ store: JsonlEventStore.inMemory() });
    platforms.push(platform);
    const transport = new RemoteHttpTransport(platform);
    transports.push(transport);
    const { url } = await startControl(platform, transport);
    runAgent(url, "wrk-task");
    await new Promise((r) => setTimeout(r, 300));

    const result = await platform.remote.dispatch("wrk-task", { kind: "run_task", taskRef: "t1" });
    assert.equal(result.ok, false);
    assert.match(result.ack, /not yet wired/);
  });

  it("marks a worker recovering when the agent disconnects", async () => {
    const platform = new Platform({ store: JsonlEventStore.inMemory() });
    platforms.push(platform);
    const transport = new RemoteHttpTransport(platform);
    transports.push(transport);
    const { url } = await startControl(platform, transport);
    runAgent(url, "wrk-drop");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(transport.isAttached("wrk-drop"), true);
    transport.dispose();
    assert.equal(transport.isAttached("wrk-drop"), false);
    assert.equal(platform.graph.getWorker("wrk-drop")!.status, "RECOVERING");
  });
});
