/**
 * `/refresh-models` verification against a real local HTTP gateway.
 *
 * Reproduces the operator report: three `qwen3.8-27b-modality-vision-ctx-*`
 * models answered the verification probe with HTTP 400 and the whole refresh
 * aborted ("model verification was inconclusive … configuration was not
 * changed"). InferWeave rewrites a backend 400 into its backpressure shape
 * (iw-protocol normalize_openai_error): `code: "upstream_error"`, the fixed
 * message "Correct the request syntax, parameters, endpoint, or model
 * identity.", `action: "fix_request"`. A 400 is a verdict about ONE model and
 * this probe, never a reason to drop every other model's result.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshConfiguredProviders, refreshProviderModels } from "../../src/models/refresh.ts";

const VISION = (ctx: string) => `qwen3.8-27b-modality-vision-ctx-${ctx}-quant-q4_k_m`;
const DEEPSEEK = "deepseek_v4-flash-modality-text-quant-mxfp4";
const GLM = "glm5.3-flash-modality-vision-quant-q6_k_xl";
const RETIRED = "qwen3.8-flash-next";

/** InferWeave's normalized backend 400 (iw-protocol/src/error.rs normalize_openai_error). */
const UPSTREAM_400 = {
  error: {
    type: "inferweave_backpressure",
    message: "Correct the request syntax, parameters, endpoint, or model identity.",
    code: "upstream_error",
    reason: "upstream_error",
    retryable: false,
    replay_safe: false,
    request_state: "unknown",
    action: "fix_request",
    scope: "request",
  },
};

/** A per-model queue deadline (adaptive.rs) — capacity, not a verdict on the model. */
const QUEUE_DEADLINE_429 = {
  error: {
    type: "inferweave_backpressure",
    message: `Timed out waiting for capacity for model ${GLM} (queue_deadline_exceeded); please retry your request.`,
    code: "queue_deadline_exceeded",
    reason: "queue_deadline_exceeded",
    retryable: true,
    retry_after_ms: 1000,
    scope: "model",
    x_availability: "CAPACITY_EXHAUSTED",
  },
};

interface Probe {
  model: string;
  body: Record<string, unknown>;
}

async function startGateway(
  models: string[] | ((listing: number) => string[] | null),
  respond: (probe: Probe) => { status: number; body: unknown },
): Promise<{ baseUrl: string; probes: Probe[]; close: () => Promise<void> }> {
  const probes: Probe[] = [];
  let listings = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/v1/models") {
      listings += 1;
      const listed = typeof models === "function" ? models(listings) : models;
      if (listed === null) {
        send(503, { error: { code: "capacity_unavailable", message: "listing unavailable" } });
        return;
      }
      send(200, {
        data: listed.map((id) => ({ id, ctx_per_request: 131072, x_context_window: 131072, x_state: "warm" })),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const probe = { model: String(body.model), body };
      probes.push(probe);
      const reply = respond(probe);
      send(reply.status, reply.body);
      return;
    }
    send(404, { error: { code: "not_found", message: "no route" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    probes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const OK = { status: 200, body: { choices: [{ message: { role: "assistant", content: "OK" } }] } };

function configured(id: string) {
  return {
    id,
    name: `${id} (operator)`,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 120000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function scratch(baseUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "refresh-verify-"));
  const path = join(dir, "models.json");
  const config = {
    providers: {
      metabolomics: {
        baseUrl,
        api: "openai-completions",
        apiKey: "sk-test",
        models: [configured(DEEPSEEK), configured(VISION("c120k")), configured(GLM), configured(RETIRED)],
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 1), { mode: 0o600 });
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type ModelsFile = { providers: { metabolomics: { models: Array<{ id: string; name?: string }> } } };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as ModelsFile;

test("refresh: a per-model HTTP 400 is reported for that model and never aborts the refresh", async () => {
  const gateway = await startGateway(
    [DEEPSEEK, VISION("c80k"), VISION("c120k"), VISION("c260k"), GLM, "brand-new-text"],
    ({ model, body }) => {
      if (model === DEEPSEEK || model === "brand-new-text") return OK;
      // The c80k backend rejects the optional thinking-off parameter only.
      if (model === VISION("c80k"))
        return body.reasoning_effort === undefined ? OK : { status: 400, body: UPSTREAM_400 };
      if (model === GLM) return { status: 429, body: QUEUE_DEADLINE_429 };
      return { status: 400, body: UPSTREAM_400 };
    },
  );
  const s = scratch(gateway.baseUrl);
  try {
    const result = await refreshConfiguredProviders({
      modelsPath: s.path,
      providerIds: ["metabolomics"],
      authForProvider: () => ({ apiKey: "sk-test" }),
      probeModels: true,
    });

    assert.deepEqual(result.failures, [], "a per-model 400 must not fail the provider");
    assert.equal(result.written, true, "models that verified are applied");
    const ids = read(s.path).providers.metabolomics.models.map((m) => m.id);
    assert.ok(ids.includes(DEEPSEEK));
    assert.ok(ids.includes("brand-new-text"), "a new working model is added");
    assert.ok(ids.includes(VISION("c80k")), "a model that verifies once the optional parameters are dropped works");
    assert.ok(ids.includes(VISION("c120k")), "a configured model whose probe was rejected is kept as before");
    assert.ok(!ids.includes(VISION("c260k")), "an unconfigured model whose probe was rejected is not added");
    assert.ok(ids.includes(GLM), "a model out of capacity is inconclusive and kept as before");
    assert.ok(!ids.includes(RETIRED), "a configured model the gateway no longer lists is still pruned");
    const kept = read(s.path).providers.metabolomics.models.find((m) => m.id === VISION("c120k"));
    assert.equal(kept?.name, `${VISION("c120k")} (operator)`, "the operator's entry is untouched");

    // Minimal probe, retried once without optional parameters on 400.
    const c80k = gateway.probes.filter((p) => p.model === VISION("c80k"));
    assert.equal(c80k.length, 2);
    for (const probe of gateway.probes) {
      assert.ok(Number(probe.body.max_tokens) <= 256, "the probe asks for a small completion");
      assert.equal(probe.body.stream, false);
      for (const forbidden of ["tools", "stream_options", "response_format"]) {
        assert.equal(probe.body[forbidden], undefined, `the probe never sends ${forbidden}`);
      }
    }
    assert.equal(c80k[1]!.body.reasoning_effort, undefined);
    assert.equal(c80k[1]!.body.temperature, undefined);
    assert.equal(gateway.probes.filter((p) => p.model === VISION("c120k")).length, 2, "one retry, not a loop");

    const report = result.lines.join("\n");
    assert.match(
      report,
      new RegExp(`rejected: ${VISION("c120k")} — HTTP 400 upstream_error: Correct the request syntax`),
    );
    assert.match(report, new RegExp(`rejected: ${VISION("c260k")} — HTTP 400`));
    assert.match(report, new RegExp(`inconclusive: ${GLM} — HTTP 429 queue_deadline_exceeded: Timed out waiting`));
    assert.match(report, /kept as configured/);
    assert.match(report, /not added/);
  } finally {
    s.cleanup();
    await gateway.close();
  }
});

test("refresh: a 400 for every probed model still leaves the configuration intact", async () => {
  const gateway = await startGateway([VISION("c80k"), VISION("c120k")], () => ({ status: 400, body: UPSTREAM_400 }));
  const s = scratch(gateway.baseUrl);
  const before = readFileSync(s.path, "utf8");
  try {
    await assert.rejects(
      () =>
        refreshProviderModels({
          modelsPath: s.path,
          providerId: "metabolomics",
          apiKey: "sk-test",
          probeModels: true,
        }),
      /none of the 2 advertised models produced a usable completion.*HTTP 400 upstream_error/,
    );
    assert.equal(readFileSync(s.path, "utf8"), before);
  } finally {
    s.cleanup();
    await gateway.close();
  }
});

test("refresh: an authentication refusal still stops the provider without writing", async () => {
  const gateway = await startGateway([DEEPSEEK, GLM], ({ model }) =>
    model === DEEPSEEK ? OK : { status: 401, body: { error: { code: "invalid_api_key", message: "bad key" } } },
  );
  const s = scratch(gateway.baseUrl);
  const before = readFileSync(s.path, "utf8");
  try {
    await assert.rejects(
      () =>
        refreshProviderModels({
          modelsPath: s.path,
          providerId: "metabolomics",
          apiKey: "sk-test",
          probeModels: true,
        }),
      /verification was inconclusive.*HTTP 401/,
    );
    assert.equal(readFileSync(s.path, "utf8"), before);
  } finally {
    s.cleanup();
    await gateway.close();
  }
});

/** A reasoning model that spends the whole budget thinking: served, no visible text. */
const THINKING = {
  status: 200,
  body: {
    choices: [
      { message: { role: "assistant", content: "", reasoning_content: "Let me think…" }, finish_reason: "length" },
    ],
  },
};
const NOT_FOUND = {
  status: 404,
  body: { error: { code: "model_not_found", message: `The model is not served right now.` } },
};

const ids = (path: string) => read(path).providers.metabolomics.models.map((m) => m.id);

test("refresh: a thinking model that returns no visible text within the budget is served, never pruned", async () => {
  const gateway = await startGateway([DEEPSEEK, GLM], ({ model }) => (model === DEEPSEEK ? OK : THINKING));
  const s = scratch(gateway.baseUrl);
  try {
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "sk-test",
      probeModels: true,
    });
    assert.ok(ids(s.path).includes(GLM), result.lines.join("\n"));
    const glmProbe = gateway.probes.find((p) => p.model === GLM);
    assert.ok(Number(glmProbe?.body.max_tokens) >= 256, "a configured reasoning model gets room to answer");
  } finally {
    s.cleanup();
    await gateway.close();
  }
});

test("refresh: a 404 for a model the gateway still lists is transient and keeps the model", async () => {
  const gateway = await startGateway([DEEPSEEK, GLM], ({ model }) => (model === DEEPSEEK ? OK : NOT_FOUND));
  const s = scratch(gateway.baseUrl);
  try {
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "sk-test",
      probeModels: true,
    });
    assert.ok(ids(s.path).includes(GLM), result.lines.join("\n"));
    assert.match(result.lines.join("\n"), new RegExp(`inconclusive: ${GLM} — HTTP 404 model_not_found`));
  } finally {
    s.cleanup();
    await gateway.close();
  }
});

test("refresh: a 404 for a model that has left the gateway's listing removes it", async () => {
  const gateway = await startGateway(
    (listing) => (listing === 1 ? [DEEPSEEK, GLM] : [DEEPSEEK]),
    ({ model }) => (model === DEEPSEEK ? OK : NOT_FOUND),
  );
  const s = scratch(gateway.baseUrl);
  try {
    await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "sk-test",
      probeModels: true,
    });
    assert.ok(!ids(s.path).includes(GLM));
  } finally {
    s.cleanup();
    await gateway.close();
  }
});

test("refresh: a 404 is never confirmed when the listing cannot be re-read; the model is kept", async () => {
  const gateway = await startGateway(
    (listing) => (listing === 1 ? [DEEPSEEK, GLM] : null),
    ({ model }) => (model === DEEPSEEK ? OK : NOT_FOUND),
  );
  const s = scratch(gateway.baseUrl);
  try {
    await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "sk-test",
      probeModels: true,
    });
    assert.ok(ids(s.path).includes(GLM));
  } finally {
    s.cleanup();
    await gateway.close();
  }
});
