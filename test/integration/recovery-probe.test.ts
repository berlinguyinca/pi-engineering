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

interface AdmissionModel {
  model: string;
  aliases?: string[];
  ceiling?: number;
  active?: number;
  queued?: number;
  queueCapacity?: number;
}

interface Gateway {
  models: Array<{ id: string; slots?: number; x_state?: string; owned_by?: string; x_alias?: boolean }>;
  admission?: AdmissionModel[];
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
    if (req.url === "/iw/v1/admission") {
      seenAuth.push(req.headers.authorization);
      res.writeHead(state.admission ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ gatewayId: "gateway-a", models: state.admission }));
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
    const state: Gateway = {
      models: [{ id: "qwen-27b", slots: 2 }],
      admission: [{ model: "qwen-27b", aliases: [], ceiling: 2, active: 0, queued: 0, queueCapacity: 4 }],
      healthz: 503,
      down: false,
    };
    const seen = await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "qwen-27b", provider: "metabolomics" }),
      });
      assert.equal((await probe.probe()).healthy, true, "measured idle capacity, even while /healthz says degraded");

      state.models = [{ id: "qwen-27b", slots: 0 }];
      const noSlots = await probe.probe();
      assert.equal(noSlots.healthy, false);
      assert.match(noSlots.reason ?? "", /no capacity/);
      assert.equal(noSlots.model_unlisted, undefined, "listed without capacity is an outage, not an unlisting");

      state.models = [{ id: "other-model", slots: 4 }];
      const unlisted = await probe.probe();
      assert.equal(unlisted.healthy, false, "the mission's model is not served");
      assert.equal(unlisted.model_unlisted, true, "the gateway answered without the model");
      assert.equal(unlisted.model_id, "qwen-27b", "names the unlisted model");
      assert.equal(unlisted.model_provider, "metabolomics", "and its provider");

      state.down = true;
      const down = await probe.probe();
      assert.equal(down.healthy, false, "unreachable");
      assert.equal(down.model_unlisted, undefined, "an unreachable gateway says nothing about the listing");
    });
    assert.ok(
      seen.every((h) => h === "Bearer secret"),
      "the client token is sent",
    );
  });

  it("does not recover on configured slots when the model queue is full", async () => {
    const admission: AdmissionModel = {
      model: "qwen-27b",
      aliases: [],
      ceiling: 2,
      active: 2,
      queued: 4,
      queueCapacity: 4,
    };
    const state: Gateway = {
      models: [{ id: "qwen-27b", slots: 2 }],
      admission: [admission],
      healthz: 200,
      down: false,
    };
    await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "qwen-27b" }),
      });
      const full = await probe.probe();
      assert.equal(full.healthy, false, "configured slots do not measure remaining queue capacity");
      assert.equal(full.authoritative, true);
      assert.equal(full.model_unlisted, undefined);
      assert.match(full.reason ?? "", /queue.*full/i);
    });
  });

  it("waits for immediate model capacity even when the queue has room", async () => {
    const admission: AdmissionModel = {
      model: "qwen-27b",
      aliases: [],
      ceiling: 2,
      active: 2,
      queued: 1,
      queueCapacity: 4,
    };
    const state: Gateway = {
      models: [{ id: "qwen-27b", slots: 2 }],
      admission: [admission],
      healthz: 200,
      down: false,
    };
    await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "qwen-27b" }),
      });
      assert.equal((await probe.probe()).healthy, false, "queue room is not free execution capacity");
      admission.queued = 0;
      assert.equal((await probe.probe()).healthy, false, "all active capacity is occupied");
      admission.active = 3;
      assert.equal((await probe.probe()).healthy, false, "overcommitted model is saturated too");
      admission.active = 1;
      const ready = await probe.probe();
      assert.equal(ready.healthy, true);
      assert.equal(ready.authoritative, true);
      assert.match(ready.reason ?? "", /model-level.*headroom/);
      assert.match(ready.reason ?? "", /caller.*not reported/);
      admission.queued = 1;
      assert.equal((await probe.probe()).healthy, false, "existing waiters retain priority even below the ceiling");
      admission.queued = 0;
      admission.ceiling = 0;
      admission.active = 0;
      assert.equal((await probe.probe()).healthy, false, "restorable capacity is not current execution capacity");
      admission.ceiling = 2;
      admission.active = 1;
      admission.queueCapacity = 0;
      assert.equal((await probe.probe()).healthy, true, "disabled queue permits immediate execution");
      admission.active = 2;
      assert.equal((await probe.probe()).healthy, false, "disabled queue and occupied seats are unavailable");
    });
  });

  it("checks the selected model or alias rather than another model's idle report", async () => {
    const state: Gateway = {
      models: [{ id: "coding", owned_by: "inferweave", x_alias: true }],
      admission: [
        { model: "other", ceiling: 20, active: 0, queued: 0, queueCapacity: 4 },
        { model: "qwen-27b", aliases: ["coding"], ceiling: 2, active: 2, queued: 0, queueCapacity: 4 },
      ],
      healthz: 200,
      down: false,
    };
    await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "coding" }),
      });
      assert.equal((await probe.probe()).healthy, false);
      state.admission![1]!.active = 0;
      assert.equal((await probe.probe()).healthy, true);
    });
  });

  it("preserves generic OpenAI model availability without InferWeave", async () => {
    const state: Gateway = { models: [{ id: "generic", owned_by: "openai" }], healthz: 200, down: false };
    await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "generic" }),
      });
      assert.deepEqual(await probe.probe(), { healthy: true, authoritative: true });
      state.models = [{ id: "other", owned_by: "openai" }];
      assert.equal((await probe.probe()).model_unlisted, true);
    });
  });

  it("cannot establish recovery from a missing or invalid admission measurement", async () => {
    const state: Gateway = { models: [{ id: "qwen-27b", slots: 2 }], healthz: 200, down: false };
    await withGateway(state, async (baseUrl) => {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl, apiKey: "secret", modelId: "qwen-27b" }),
      });
      for (const admission of [
        undefined,
        [],
        [{ model: "other", ceiling: 2, active: 0, queued: 0, queueCapacity: 4 }],
        [{ model: "qwen-27b", ceiling: 2, active: 0, queued: 0 }],
        [{ model: "qwen-27b", ceiling: 2, active: 0, queued: -1, queueCapacity: 4 }],
        [{ model: "qwen-27b", ceiling: 2, active: 0.5, queued: 0, queueCapacity: 4 }],
      ]) {
        state.admission = admission;
        const result = await probe.probe();
        assert.equal(result.healthy, false, JSON.stringify(admission));
        assert.equal(result.authoritative, false, JSON.stringify(admission));
        assert.match(result.reason ?? "", /capacity.*unknown/i);
        assert.equal(result.model_unlisted, undefined);
      }
    });
  });

  it("does not promote admission errors or malformed bodies to authoritative recovery", async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      new Response(null, { status: 401 }),
      new Response(null, { status: 503 }),
      new Response("not-json"),
      Response.json(null),
      Response.json({ models: [null, "invalid", {}] }),
    ]) {
      const probe = new CatalogRecoveryProbe({
        resolve: async () => ({ baseUrl: "https://gateway.example/proxy/v1/", apiKey: "secret", modelId: "qwen-27b" }),
        fetchImpl: async (url, init) => {
          assert.deepEqual(init?.headers, { Authorization: "Bearer secret" });
          if (String(url).endsWith("/models")) {
            return Response.json({ data: [{ id: "qwen-27b", owned_by: "inferweave", slots: 2 }] });
          }
          assert.equal(url, "https://gateway.example/proxy/iw/v1/admission", "retains the provider mount prefix");
          return response;
        },
      });
      const result = await probe.probe();
      assert.equal(result.healthy, false);
      assert.equal(result.authoritative, false);
      assert.match(result.reason ?? "", /capacity.*unknown/i);
    }
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
      assert.deepEqual(target, {
        baseUrl: "https://gateway.example/v1",
        apiKey: "secret",
        modelId: "qwen-27b",
        provider: "metabolomics",
      });
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
