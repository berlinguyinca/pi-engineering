import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilityFetchResult, CapabilityTransport } from "../../src/context/client.ts";
import {
  DEFAULT_INFERWEAVE_CONFIG,
  createInferweaveProvider,
  inferweaveConfigFromEnv,
  parseOverrides,
} from "../../src/context/provider.ts";

function makeTransport(handlers: {
  listing?: () => CapabilityFetchResult;
  capability?: (modelId: string) => CapabilityFetchResult;
}): { transport: CapabilityTransport; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    transport: async (url) => {
      urls.push(url);
      if (url.endsWith("/models")) return handlers.listing?.() ?? { status: 404 };
      const modelId = decodeURIComponent(url.split("/models/")[1]!.split("/")[0]!);
      return handlers.capability?.(modelId) ?? { status: 404 };
    },
  };
}

test("env config: the integration is inert without a gateway URL", () => {
  assert.equal(inferweaveConfigFromEnv({}).enabled, false);
  assert.equal(inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: "http://gw:8787/v1/" }).enabled, true);
  assert.equal(inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: "http://gw:8787/v1/" }).baseUrl, "http://gw:8787/v1");
  assert.equal(inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: "http://gw", INFERWEAVE_ENABLED: "0" }).enabled, false);
  assert.equal(
    inferweaveConfigFromEnv({ INFERWEAVE_BASE_URL: "http://gw", INFERWEAVE_TTL_SECONDS: "45" }).ttlSeconds,
    45,
  );
});

test("overrides parse the documented model=window[:output][:unsafe] form", () => {
  const overrides = parseOverrides("big=1048576,small=32768:2048:unsafe, ,junk");
  assert.deepEqual(overrides.big, {
    modelId: "big",
    contextWindow: 1_048_576,
    maxOutputTokens: undefined,
    allowUnsafeOverride: false,
  });
  assert.deepEqual(overrides.small, {
    modelId: "small",
    contextWindow: 32_768,
    maxOutputTokens: 2_048,
    allowUnsafeOverride: true,
  });
  assert.equal(overrides.junk, undefined);
  assert.deepEqual(parseOverrides(undefined), {});
});

test("refreshModels gives Pi the guaranteed window and the advertised output cap", async () => {
  const probe = makeTransport({
    listing: () => ({
      status: 200,
      body: {
        data: [
          { id: "qwen3.8-27b", inferweave: { guaranteed_routable_tokens: 262_144, max_output_tokens: 32_768 } },
          { id: "tiny", context_window: 32_768, max_tokens: 4_096 },
        ],
      },
    }),
  });
  const provider = createInferweaveProvider(
    { ...DEFAULT_INFERWEAVE_CONFIG, enabled: true, baseUrl: "http://gw/v1" },
    { transport: probe.transport },
  );
  const models = await provider.registration.refreshModels({});
  assert.deepEqual(
    models.map((m) => [m.id, m.contextWindow, m.maxTokens]),
    [
      ["qwen3.8-27b", 262_144, 32_768],
      ["tiny", 32_768, 4_096],
    ],
  );
  assert.equal(probe.urls.length, 1, "a listing that carries capabilities is one request");
  assert.equal(provider.windowFor("qwen3.8-27b")?.windowTokens, 262_144);
});

test("a model with nothing advertised lands on the floor and says so", async () => {
  const probe = makeTransport({
    listing: () => ({ status: 200, body: { data: [{ id: "opaque" }] } }),
    capability: () => ({ status: 404 }),
  });
  const provider = createInferweaveProvider(
    { ...DEFAULT_INFERWEAVE_CONFIG, enabled: true, baseUrl: "http://gw/v1" },
    { transport: probe.transport },
  );
  const models = await provider.registration.refreshModels({});
  assert.equal(models[0]!.contextWindow, 128_000);
  assert.match(provider.diagnostics("opaque").join("\n"), /floor|fallback/);
});

test("capability lookups are bounded so a big listing cannot stampede the gateway", async () => {
  const probe = makeTransport({
    listing: () => ({ status: 200, body: { data: Array.from({ length: 30 }, (_unused, i) => ({ id: `m${i}` })) } }),
    capability: () => ({ status: 200, body: { guaranteed_routable_tokens: 262_144 } }),
  });
  const provider = createInferweaveProvider(
    { ...DEFAULT_INFERWEAVE_CONFIG, enabled: true, baseUrl: "http://gw/v1", maxCapabilityLookups: 3 },
    { transport: probe.transport },
  );
  const models = await provider.registration.refreshModels({});
  assert.equal(models.length, 30);
  assert.equal(probe.urls.filter((u) => u.includes("/capabilities")).length, 3, "three lookups, not thirty");
  assert.match(provider.diagnostics().join("\n"), /capability lookups capped/);
});

test("a gateway outage yields the previous list rather than an empty one", async () => {
  let fail = false;
  const probe = makeTransport({
    listing: () => {
      if (fail) throw new Error("connection refused");
      return { status: 200, body: { data: [{ id: "m", context_window: 65_536 }] } };
    },
  });
  const provider = createInferweaveProvider(
    { ...DEFAULT_INFERWEAVE_CONFIG, enabled: true, baseUrl: "http://gw/v1" },
    { transport: probe.transport },
  );
  assert.equal((await provider.registration.refreshModels({})).length, 1);
  fail = true;
  const after = await provider.registration.refreshModels({});
  assert.equal(after.length, 1, "the last good list survives an outage");
  assert.match(provider.diagnostics().join("\n"), /listing refresh failed/);
});
