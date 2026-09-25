/**
 * The mission recovery probe against a real HTTP server shaped like InferWeave:
 * `/v1/models` needs the client token and lists per-model readiness, and
 * `/healthz` answers 503 "degraded" whenever ANY model lacks workers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CatalogRecoveryProbe, HttpRecoveryProbe, resolveCatalogProbeTarget } from "../../src/resilience/probe.ts";

interface Gateway {
  models: Array<{ id: string; slots?: number; x_state?: string }>;
  healthz: number;
  down: boolean;
}

async function withGateway(state: Gateway, body: (baseUrl: string) => Promise<void>) {
  const seenAuth: Array<string | undefined> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (state.down) {
      res.socket?.destroy();
      return;
    }
    if (req.url === "/v1/models") {
      seenAuth.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer secret") {
        res.writeHead(401).end('{"error":"missing client token"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: state.models.map((m) => ({ object: "model", ...m })) }));
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(state.healthz, { "content-type": "application/json" });
      res.end(state.healthz === 200 ? '{"status":"ok"}' : '{"status":"degraded"}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await body(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.close();
  }
  return seenAuth;
}

describe("CatalogRecoveryProbe: authenticated model listing", () => {
  it("is healthy only when the gateway lists the mission's model with capacity", async () => {
    const state: Gateway = { models: [{ id: "qwen-27b", slots: 2 }], healthz: 503, down: false };
    const seen = await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "qwen-27b" }),
      });
      assert.equal((await probe.probe()).healthy, true, "listed with slots, even while /healthz says degraded");

      state.models = [{ id: "qwen-27b", slots: 0 }];
      const noSlots = await probe.probe();
      assert.equal(noSlots.healthy, false);
      assert.match(noSlots.reason ?? "", /no capacity/);

      state.models = [{ id: "other-model", slots: 4 }];
      assert.equal((await probe.probe()).healthy, false, "the mission's model is not served");

      state.down = true;
      assert.equal((await probe.probe()).healthy, false, "unreachable");
    });
    assert.ok(
      seen.every((h) => h === "Bearer secret"),
      "the client token is sent",
    );
  });

  it("without the client token the gateway refuses, so the probe is not healthy", async () => {
    const state: Gateway = { models: [{ id: "qwen-27b", slots: 2 }], healthz: 200, down: false };
    await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({ resolve: async () => ({ baseUrl, modelId: "qwen-27b" }) });
      const r = await probe.probe();
      assert.equal(r.healthy, false);
      assert.match(r.reason ?? "", /401/);
    });
  });

  it("an unresolvable target is reported as non-authoritative, never as a recovery", async () => {
    const probe = new CatalogRecoveryProbe({ resolve: async () => undefined });
    const r = await probe.probe();
    assert.equal(r.authoritative, false);
  });

  it("resolves base URL, key and model from the worker's own ModelRuntime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-target-"));
    try {
      writeFileSync(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            metabolomics: {
              baseUrl: "https://gateway.example/v1",
              api: "openai-completions",
              apiKey: "secret",
              models: [{ id: "qwen-27b", contextWindow: 100_000, maxTokens: 4096 }],
            },
          },
        }),
      );
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
        allowModelNetwork: false,
      });
      const target = await resolveCatalogProbeTarget(runtime, { provider: "metabolomics", id: "qwen-27b" });
      assert.deepEqual(target, { baseUrl: "https://gateway.example/v1", apiKey: "secret", modelId: "qwen-27b" });
      assert.equal(await resolveCatalogProbeTarget(runtime, { provider: "nope", id: "x" }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HttpRecoveryProbe (PI_GATEWAY_HEALTH_URL override)", () => {
  it("counts an InferWeave /healthz answer as reachable even when it says degraded", async () => {
    const state: Gateway = { models: [], healthz: 503, down: false };
    await withGateway(state, async (baseUrl) => {
      const probe = new HttpRecoveryProbe({ baseUrl: baseUrl.replace(/\/v1$/, "") });
      assert.equal((await probe.probe()).healthy, true);
      state.down = true;
      assert.equal((await probe.probe()).healthy, false);
    });
  });
});
