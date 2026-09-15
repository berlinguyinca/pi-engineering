/**
 * End-to-end `/refresh-models`: gateway response in, `models.json` out.
 *
 * The fixture is the real drift measured against `https://llm.metabolomics.us/v1`
 * — a model configured at 1,048,576 tokens that the gateway caps at 262,144,
 * one at 131,072 that accepts 250,112, and a vision model missing entirely.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshProviderModels } from "../../src/models/refresh.ts";

const PAYLOAD = {
  data: [
    {
      id: "deepseek-v4-flash",
      ctx_per_request: 262144,
      x_context_window: 262144,
      ctx_total: 2359296,
      x_state: "warm",
      slots: 9,
    },
    { id: "qwen3.8-27b", ctx_per_request: 262144, x_state: "warm", slots: 3 },
    { id: "qwen3.8-27b-q4-250k", ctx_per_request: 250112, x_state: "warm", slots: 1 },
    { id: "qwen3.8-27b-vision", ctx_per_request: 262144, x_state: "warm", slots: 2 },
    { id: "qwen3.8-flash-next", ctx_per_request: 262144, x_state: "warm", slots: 1 },
  ],
};

const STARTING_CONFIG = {
  providers: {
    metabolomics: {
      baseUrl: "https://llm.metabolomics.us/v1",
      api: "openai-completions",
      apiKey: "sk-super-secret",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [
        {
          id: "deepseek-v4-flash",
          name: "deepseek-v4-flash (gateway)",
          reasoning: true,
          input: ["text"],
          contextWindow: 1048576,
          maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: "qwen3.8-27b",
          name: "qwen3.8-27b (gateway)",
          reasoning: true,
          input: ["text"],
          contextWindow: 262144,
          maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: "qwen3.8-27b-q4-250k",
          name: "qwen3.8-27b-q4-250k (gateway)",
          reasoning: true,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: "qwen3.8-flash-next",
          name: "qwen3.8-flash-next (gateway)",
          reasoning: true,
          input: ["text"],
          contextWindow: 262144,
          maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};

/**
 * `null` means "no file on disk" — a deliberate sentinel, because passing
 * `undefined` would trigger the default parameter and silently write the
 * starting config, which is exactly the bug that made the fresh-install test
 * pass a file it was supposed to prove absent.
 */
function scratch(config: unknown = STARTING_CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), "refresh-"));
  const path = join(dir, "models.json");
  if (config !== null) writeFileSync(path, JSON.stringify(config, null, 1), { mode: 0o600 });
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const okFetch = (async () => ({ ok: true, status: 200, json: async () => PAYLOAD })) as unknown as typeof fetch;

function read(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as typeof STARTING_CONFIG;
}

test("refresh: corrects the real drift and adds the missing model", async () => {
  const s = scratch();
  try {
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      fetchImpl: okFetch,
    });

    assert.equal(result.written, true);
    const models = read(s.path).providers.metabolomics.models;
    const byId = new Map(models.map((m) => [m.id, m]));

    assert.equal(byId.get("deepseek-v4-flash")?.contextWindow, 262144);
    assert.equal(byId.get("qwen3.8-27b-q4-250k")?.contextWindow, 250112);
    assert.ok(byId.has("qwen3.8-27b-vision"));
    assert.equal(models.length, 5);
  } finally {
    s.cleanup();
  }
});

test("refresh: the API key and provider settings survive", async () => {
  const s = scratch();
  try {
    await refreshProviderModels({ modelsPath: s.path, providerId: "metabolomics", apiKey: "k", fetchImpl: okFetch });
    const provider = read(s.path).providers.metabolomics;

    assert.equal(provider.apiKey, "sk-super-secret", "a refresh must never cost the operator their credentials");
    assert.equal(provider.baseUrl, "https://llm.metabolomics.us/v1");
    assert.deepEqual(provider.compat, { supportsDeveloperRole: false, supportsReasoningEffort: true });
  } finally {
    s.cleanup();
  }
});

test("refresh: the file mode is not widened", async () => {
  const s = scratch();
  try {
    await refreshProviderModels({ modelsPath: s.path, providerId: "metabolomics", apiKey: "k", fetchImpl: okFetch });
    assert.equal(statSync(s.path).mode & 0o777, 0o600, "the file still holds an API key");
  } finally {
    s.cleanup();
  }
});

test("refresh: a backup is left and it restores the original", async () => {
  const s = scratch();
  try {
    const before = readFileSync(s.path, "utf8");
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      fetchImpl: okFetch,
    });

    assert.ok(result.backupPath && existsSync(result.backupPath));
    assert.equal(readFileSync(result.backupPath, "utf8"), before);
  } finally {
    s.cleanup();
  }
});

test("refresh: a dry run changes nothing on disk but still reports", async () => {
  const s = scratch();
  try {
    const before = readFileSync(s.path, "utf8");
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      dryRun: true,
      fetchImpl: okFetch,
    });

    assert.equal(result.written, false);
    assert.equal(readFileSync(s.path, "utf8"), before);
    assert.match(result.lines.join("\n"), /contextWindow 1048576 → 262144/);
    assert.match(result.lines.join("\n"), /Dry run/);
  } finally {
    s.cleanup();
  }
});

test("refresh: running twice does not churn the file", async () => {
  const s = scratch();
  try {
    await refreshProviderModels({ modelsPath: s.path, providerId: "metabolomics", apiKey: "k", fetchImpl: okFetch });
    const afterFirst = readFileSync(s.path, "utf8");

    const second = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      fetchImpl: okFetch,
    });

    assert.equal(second.written, false, "an unchanged config must not earn a new backup and mtime");
    assert.equal(second.backupPath, undefined);
    assert.equal(readFileSync(s.path, "utf8"), afterFirst);
  } finally {
    s.cleanup();
  }
});

test("refresh: a gateway failure leaves the config untouched", async () => {
  const s = scratch();
  try {
    const before = readFileSync(s.path, "utf8");
    await assert.rejects(() =>
      refreshProviderModels({
        modelsPath: s.path,
        providerId: "metabolomics",
        apiKey: "k",
        fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
      }),
    );
    assert.equal(readFileSync(s.path, "utf8"), before, "a saturated gateway must not cost the operator their models");
  } finally {
    s.cleanup();
  }
});

test("refresh: an empty gateway list never empties the config", async () => {
  const s = scratch();
  try {
    const before = readFileSync(s.path, "utf8");
    await assert.rejects(() =>
      refreshProviderModels({
        modelsPath: s.path,
        providerId: "metabolomics",
        apiKey: "k",
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })) as unknown as typeof fetch,
      }),
    );
    assert.equal(readFileSync(s.path, "utf8"), before);
  } finally {
    s.cleanup();
  }
});

test("refresh: a malformed config fails before any network call", async () => {
  const s = scratch(null);
  writeFileSync(s.path, "{ not json", { mode: 0o600 });
  let fetched = false;
  try {
    await assert.rejects(() =>
      refreshProviderModels({
        modelsPath: s.path,
        providerId: "metabolomics",
        fetchImpl: (async () => {
          fetched = true;
          return { ok: true, status: 200, json: async () => PAYLOAD };
        }) as unknown as typeof fetch,
      }),
    );
    assert.equal(fetched, false, "a config we cannot parse is one we must not replace");
    assert.equal(readFileSync(s.path, "utf8"), "{ not json");
  } finally {
    s.cleanup();
  }
});

test("refresh: a fresh install with no config at all is populated", async () => {
  const s = scratch(null);
  try {
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      baseUrl: "https://llm.metabolomics.us/v1",
      apiKey: "k",
      fetchImpl: okFetch,
    });

    assert.equal(result.written, true);
    assert.equal(result.backupPath, undefined, "nothing to back up on a first run");
    assert.equal(read(s.path).providers.metabolomics.models.length, 5);
  } finally {
    s.cleanup();
  }
});

test("refresh: the default gateway is used when nothing is configured", async () => {
  const s = scratch(null);
  let seen = "";
  try {
    await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      fetchImpl: (async (url: string) => {
        seen = String(url);
        return { ok: true, status: 200, json: async () => PAYLOAD };
      }) as unknown as typeof fetch,
    });
    assert.equal(seen, "https://llm.metabolomics.us/v1/models");
  } finally {
    s.cleanup();
  }
});

test("refresh: a model the gateway dropped is kept unless pruning is asked for", async () => {
  const withExtra = JSON.parse(JSON.stringify(STARTING_CONFIG)) as typeof STARTING_CONFIG;
  withExtra.providers.metabolomics.models.push({
    id: "retired",
    name: "retired",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const s = scratch(withExtra);
  try {
    await refreshProviderModels({ modelsPath: s.path, providerId: "metabolomics", apiKey: "k", fetchImpl: okFetch });
    assert.ok(read(s.path).providers.metabolomics.models.some((m) => m.id === "retired"));

    await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      pruneMissing: true,
      fetchImpl: okFetch,
    });
    assert.equal(
      read(s.path).providers.metabolomics.models.some((m) => m.id === "retired"),
      false,
    );
  } finally {
    s.cleanup();
  }
});
