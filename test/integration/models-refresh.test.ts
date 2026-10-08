/**
 * End-to-end `/refresh-models`: gateway response in, `models.json` out.
 *
 * The fixture is the real drift measured against `https://llm.example.com/v1`
 * — a model configured at 1,048,576 tokens that the gateway caps at 262,144,
 * one at 131,072 that accepts 250,112, and a vision model missing entirely.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshConfiguredProviders, refreshProviderModels } from "../../src/models/refresh.ts";

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
      baseUrl: "https://llm.example.com/v1",
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
    assert.equal(provider.baseUrl, "https://llm.example.com/v1");
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

test("refresh: one unavailable host does not block healthy configured providers", async () => {
  const localModels = [{ id: "local", contextWindow: 250_000, maxTokens: 32_768 }];
  const s = scratch({
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8082/v1",
        models: localModels,
      },
      metabolomics: STARTING_CONFIG.providers.metabolomics,
    },
  });
  try {
    const result = await refreshConfiguredProviders({
      modelsPath: s.path,
      providerIds: ["local", "metabolomics"],
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("http://127.0.0.1:8082/")) {
          return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
        return { ok: true, status: 200, json: async () => PAYLOAD };
      }) as typeof fetch,
    });

    assert.deepEqual(
      result.results.map((entry) => entry.providerId),
      ["metabolomics"],
    );
    assert.deepEqual(
      result.failures.map((entry) => entry.providerId),
      ["local"],
    );
    assert.match(result.lines.join("\n"), /local — skipped:/);

    const config = JSON.parse(readFileSync(s.path, "utf8")) as {
      providers: {
        local: { models: Array<{ id: string; contextWindow?: number; maxTokens?: number }> };
        metabolomics: { models: Array<{ id: string; contextWindow?: number; maxTokens?: number }> };
      };
    };
    assert.deepEqual(config.providers.local.models, localModels, "the failed host keeps its last-known models");
    assert.equal(config.providers.metabolomics.models.length, 5, "the healthy host is still refreshed");
  } finally {
    s.cleanup();
  }
});

test("refresh: multiple successful providers share one restorable batch backup", async () => {
  const original = {
    providers: {
      first: { baseUrl: "https://first.example/v1", models: [{ id: "old-first", contextWindow: 8_192 }] },
      second: { baseUrl: "https://second.example/v1", models: [{ id: "old-second", contextWindow: 8_192 }] },
    },
  };
  const s = scratch(original);
  try {
    const result = await refreshConfiguredProviders({
      modelsPath: s.path,
      providerIds: ["first", "second"],
      now: () => new Date("2026-09-28T12:00:00Z"),
      fetchImpl: (async (input: string | URL | Request) => {
        const id = String(input).includes("first.example") ? "new-first" : "new-second";
        return { ok: true, status: 200, json: async () => ({ data: [{ id, ctx_per_request: 262_144 }] }) };
      }) as typeof fetch,
    });

    assert.ok(result.backupPath);
    assert.deepEqual(JSON.parse(readFileSync(result.backupPath, "utf8")), original);
    assert.equal(
      result.results.every(({ result: entry }) => entry.backupPath === result.backupPath),
      true,
    );
  } finally {
    s.cleanup();
  }
});

test("refresh: cancellation stops later providers and prevents a partial write", async () => {
  const original = {
    providers: {
      first: { baseUrl: "https://first.example/v1", models: [{ id: "old-first", contextWindow: 8_192 }] },
      second: { baseUrl: "https://second.example/v1", models: [{ id: "old-second", contextWindow: 8_192 }] },
    },
  };
  const s = scratch(original);
  const controller = new AbortController();
  const requested: string[] = [];
  try {
    await assert.rejects(() =>
      refreshConfiguredProviders({
        modelsPath: s.path,
        providerIds: ["first", "second"],
        signal: controller.signal,
        fetchImpl: (async (input: string | URL | Request) => {
          requested.push(String(input));
          controller.abort();
          return { ok: true, status: 200, json: async () => ({ data: [{ id: "new", ctx_per_request: 262_144 }] }) };
        }) as typeof fetch,
      }),
    );

    assert.equal(requested.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(s.path, "utf8")), original);
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
      baseUrl: "https://llm.example.com/v1",
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
    assert.equal(seen, "https://llm.example.com/v1/models");
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

test("refresh: verification keeps every model that answers, visible text or not", async () => {
  const s = scratch();
  const requested: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      probeModels: true,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) {
          return { ok: true, status: 200, headers: new Headers(), json: async () => PAYLOAD };
        }
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          reasoning_effort?: string;
        };
        requested.push(body.model);
        assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer k");
        assert.equal(body.reasoning_effort, "none", "known reasoning gateways must not spend the probe on thinking");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          if (body.model === "qwen3.8-27b-q4-250k" || body.model === "deepseek-v4-flash") {
            return {
              ok: true,
              status: 200,
              json: async () => ({ choices: [{ message: { content: "OK" } }] }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: "", reasoning_content: "still thinking" } }] }),
          };
        } finally {
          inFlight -= 1;
        }
      }) as typeof fetch,
    });

    assert.deepEqual(requested.sort(), PAYLOAD.data.map((model) => model.id).sort());
    assert.equal(maxInFlight, 1, "default probing must not create its own capacity contention");
    // A reasoning model that spends the probe budget thinking (empty content)
    // is still served: it must never be pruned from the picker for that.
    assert.deepEqual(
      read(s.path)
        .providers.metabolomics.models.map((model) => model.id)
        .sort(),
      PAYLOAD.data.map((model) => model.id).sort(),
    );
  } finally {
    s.cleanup();
  }
});

test("refresh: one success plus an account-wide refusal preserves the provider", async () => {
  const s = scratch();
  const before = readFileSync(s.path, "utf8");
  try {
    await assert.rejects(
      () =>
        refreshProviderModels({
          modelsPath: s.path,
          providerId: "metabolomics",
          apiKey: "k",
          probeModels: true,
          fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("/models")) {
              return { ok: true, status: 200, headers: new Headers(), json: async () => PAYLOAD };
            }
            const body = JSON.parse(String(init?.body)) as { model: string };
            if (body.model === PAYLOAD.data[0]!.id) {
              return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
            }
            return {
              ok: false,
              status: 429,
              json: async () => ({ error: { code: "caller_concurrency", scope: "account" } }),
            };
          }) as typeof fetch,
        }),
      /verification was inconclusive.*HTTP 429/,
    );
    assert.equal(readFileSync(s.path, "utf8"), before);
  } finally {
    s.cleanup();
  }
});

test("refresh: a model is excluded only after two bounded probe timeouts", async () => {
  const s = scratch();
  const payload = { data: PAYLOAD.data.slice(0, 2) };
  let timedOutAttempts = 0;
  try {
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      probeModels: true,
      probeTimeoutMs: 5,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
          return { ok: true, status: 200, headers: new Headers(), json: async () => payload };
        }
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (body.model === payload.data[0]!.id) {
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
        }
        timedOutAttempts += 1;
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      }) as typeof fetch,
    });

    assert.equal(timedOutAttempts, 2);
    assert.deepEqual(
      result.gateway.map((model) => model.id),
      [payload.data[0]!.id],
    );
    assert.match(result.lines.join("\n"), /probe timed out/);
  } finally {
    s.cleanup();
  }
});

test("refresh: unsupported inference APIs retain metadata-only refresh semantics", async () => {
  const config = JSON.parse(JSON.stringify(STARTING_CONFIG)) as typeof STARTING_CONFIG;
  config.providers.metabolomics.api = "anthropic-messages";
  const s = scratch(config);
  let posts = 0;
  try {
    const result = await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      probeModels: true,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") posts += 1;
        return { ok: true, status: 200, headers: new Headers(), json: async () => PAYLOAD };
      }) as typeof fetch,
    });

    assert.equal(posts, 0);
    assert.match(result.lines.join("\n"), /5 advertised model\(s\)/);
    assert.match(result.lines.join("\n"), /probe skipped.*anthropic-messages/i);
  } finally {
    s.cleanup();
  }
});

test("refresh: thinking-off environment allowlists can disable probe parameters", async () => {
  const s = scratch();
  const previousProviders = process.env.PI_THINKING_OFF_PROVIDERS;
  const previousGateways = process.env.PI_THINKING_OFF_GATEWAYS;
  let probeBody: { reasoning_effort?: string } | undefined;
  process.env.PI_THINKING_OFF_PROVIDERS = "";
  process.env.PI_THINKING_OFF_GATEWAYS = "";
  try {
    await refreshProviderModels({
      modelsPath: s.path,
      providerId: "metabolomics",
      apiKey: "k",
      probeModels: true,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
          return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [PAYLOAD.data[0]] }) };
        }
        probeBody = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
      }) as typeof fetch,
    });

    assert.equal(probeBody?.reasoning_effort, undefined);
  } finally {
    if (previousProviders === undefined) delete process.env.PI_THINKING_OFF_PROVIDERS;
    else process.env.PI_THINKING_OFF_PROVIDERS = previousProviders;
    if (previousGateways === undefined) delete process.env.PI_THINKING_OFF_GATEWAYS;
    else process.env.PI_THINKING_OFF_GATEWAYS = previousGateways;
    s.cleanup();
  }
});

test("refresh: zero successful verification probes preserve the last-known-good config", async () => {
  const s = scratch();
  const before = readFileSync(s.path, "utf8");
  try {
    await assert.rejects(
      () =>
        refreshProviderModels({
          modelsPath: s.path,
          providerId: "metabolomics",
          apiKey: "k",
          probeModels: true,
          fetchImpl: (async (input: string | URL | Request) => {
            if (String(input).endsWith("/models")) {
              return { ok: true, status: 200, headers: new Headers(), json: async () => PAYLOAD };
            }
            return { ok: false, status: 503, json: async () => ({ error: { code: "capacity_unavailable" } }) };
          }) as typeof fetch,
        }),
      /none of the 5 advertised models produced a usable completion/,
    );
    assert.equal(readFileSync(s.path, "utf8"), before);
  } finally {
    s.cleanup();
  }
});
