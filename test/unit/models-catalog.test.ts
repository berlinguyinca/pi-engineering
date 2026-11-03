/**
 * Reconciling configured models with what a gateway actually serves.
 *
 * The fixtures are real. Measured against `https://llm.example.com/v1`, a
 * working `models.json` had `deepseek-v4-flash` configured at 1,048,576 tokens
 * against a real limit of 262,144, `qwen3.8-27b-q4-250k` at 131,072 against
 * 250,112, and no entry at all for `qwen3.8-27b-vision`.
 *
 * The over-statement is the damaging direction: Pi fills the context believing
 * it fits, the request fails, and because Pi's usage percentage is computed from
 * the configured window, compaction fires far too late to save it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConfiguredModel, describeCatalogPlan, planCatalogUpdate } from "../../src/models/catalogPlan.ts";
import { CatalogFetchError, fetchGatewayModels, parseGatewayModels } from "../../src/models/gatewayCatalog.ts";

/** A verbatim response from the gateway. */
const LIVE_PAYLOAD = {
  data: [
    {
      id: "deepseek-v4-flash",
      object: "model",
      owned_by: "",
      created: 1789507634,
      x_context_window: 262144,
      x_state: "warm",
      ctx_per_request: 262144,
      ctx_total: 2359296,
      slots: 9,
    },
    {
      id: "qwen3.8-27b",
      object: "model",
      x_context_window: 262144,
      ctx_per_request: 262144,
      x_state: "warm",
      slots: 3,
    },
    {
      id: "qwen3.8-27b-q4-250k",
      object: "model",
      x_context_window: 250112,
      ctx_per_request: 250112,
      x_state: "warm",
      slots: 1,
    },
    {
      id: "qwen3.8-27b-vision",
      object: "model",
      x_context_window: 262144,
      ctx_per_request: 262144,
      x_state: "warm",
      slots: 2,
    },
    {
      id: "qwen3.8-flash-next",
      object: "model",
      x_context_window: 262144,
      ctx_per_request: 262144,
      x_state: "warm",
      slots: 1,
    },
  ],
};

/** The configured list, as it actually was — drift included. */
function configured(): ConfiguredModel[] {
  const base = (id: string, contextWindow: number): ConfiguredModel => ({
    id,
    name: `${id} (gateway)`,
    reasoning: true,
    input: ["text"],
    contextWindow,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return [
    base("deepseek-v4-flash", 1_048_576),
    base("qwen3.8-27b", 262_144),
    base("qwen3.8-27b-q4-250k", 131_072),
    base("qwen3.8-flash-next", 262_144),
  ];
}

// ─── Parsing ────────────────────────────────────────────────────────────────

test("catalog: the per-request limit is used, never the gateway's total", () => {
  // ctx_total is 2359296 across nine slots. Configuring that would tell Pi a
  // request nine times too large will fit.
  const models = parseGatewayModels(LIVE_PAYLOAD);
  const flash = models.find((m) => m.id === "deepseek-v4-flash");
  assert.equal(flash?.contextWindow, 262_144);
  assert.equal(flash?.contextTotal, 2_359_296);
});

test("catalog: readiness and slot count are carried through", () => {
  const flash = parseGatewayModels(LIVE_PAYLOAD).find((m) => m.id === "deepseek-v4-flash");
  assert.equal(flash?.state, "warm");
  assert.equal(flash?.slots, 9);
});

test("catalog: an entry with no usable context size is skipped, not invented", () => {
  const models = parseGatewayModels({ data: [{ id: "bare", object: "model" }, ...LIVE_PAYLOAD.data] });
  assert.equal(
    models.some((m) => m.id === "bare"),
    false,
    "a fabricated window is how a session gets configured to overflow",
  );
  assert.equal(models.length, 5);
});

test("catalog: malformed payloads yield nothing rather than throwing", () => {
  assert.deepEqual(parseGatewayModels(null), []);
  assert.deepEqual(parseGatewayModels({}), []);
  assert.deepEqual(parseGatewayModels({ data: "nope" }), []);
  assert.deepEqual(parseGatewayModels({ data: [null, 3, "x"] }), []);
});

// ─── Planning ───────────────────────────────────────────────────────────────

test("catalog: the real drift is detected and corrected", () => {
  const plan = planCatalogUpdate(configured(), parseGatewayModels(LIVE_PAYLOAD));

  const flash = plan.next.find((m) => m.id === "deepseek-v4-flash");
  assert.equal(flash?.contextWindow, 262_144, "a 4x over-statement is the one that silently breaks sessions");

  const q4 = plan.next.find((m) => m.id === "qwen3.8-27b-q4-250k");
  assert.equal(q4?.contextWindow, 250_112, "under-statement wastes half the window");

  assert.ok(
    plan.next.some((m) => m.id === "qwen3.8-27b-vision"),
    "a model on the gateway but absent locally cannot be selected",
  );
  assert.equal(plan.dirty, true);
});

test("catalog: configuration the gateway knows nothing about survives", () => {
  // /models reports an id and a size. Everything else in the entry is the
  // operator's, and a refresh that quietly dropped it would be a downgrade.
  const existing = configured().map((m) => ({
    ...m,
    compat: { supportsReasoningEffort: true },
    name: "My Custom Name",
  }));
  const plan = planCatalogUpdate(existing, parseGatewayModels(LIVE_PAYLOAD));
  const flash = plan.next.find((m) => m.id === "deepseek-v4-flash");

  assert.equal(flash?.name, "My Custom Name", "a custom name is not the gateway's business");
  assert.deepEqual(flash?.compat, { supportsReasoningEffort: true }, "unknown keys must be preserved");
  assert.equal(flash?.maxTokens, 32_768);
  assert.deepEqual(flash?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("catalog: an output limit larger than the shrunken window is clamped", () => {
  // Left alone, this configures a model to be asked for more output than it can
  // hold in total — unsatisfiable on every call.
  const existing: ConfiguredModel[] = [{ id: "qwen3.8-27b-q4-250k", contextWindow: 1_000_000, maxTokens: 400_000 }];
  const plan = planCatalogUpdate(existing, parseGatewayModels(LIVE_PAYLOAD));
  const m = plan.next.find((x) => x.id === "qwen3.8-27b-q4-250k");

  assert.equal(m?.contextWindow, 250_112);
  assert.equal(m?.maxTokens, 250_112);
  assert.ok(plan.changes.find((c) => c.id === m?.id)?.details.some((d) => /clamped/.test(d)));
});

test("catalog: an added model inherits its siblings' conventions", () => {
  const plan = planCatalogUpdate(configured(), parseGatewayModels(LIVE_PAYLOAD));
  const added = plan.next.find((m) => m.id === "qwen3.8-27b-vision");

  assert.equal(added?.maxTokens, 32_768, "matches the other configured models");
  assert.equal(added?.reasoning, true);
});

test("catalog: a vision model gets image input, and the guess is declared", () => {
  const plan = planCatalogUpdate(configured(), parseGatewayModels(LIVE_PAYLOAD));
  const added = plan.next.find((m) => m.id === "qwen3.8-27b-vision");
  const change = plan.changes.find((c) => c.id === "qwen3.8-27b-vision");

  assert.deepEqual(added?.input, ["text", "image"]);
  // /models reports no modality. Claiming image support a model lacks fails
  // every image request, so the inference is surfaced rather than buried.
  assert.ok(change?.inferred?.includes("input"), "an inferred field must be reported as inferred");
});

test("catalog: a non-vision model is not given image support on a guess", () => {
  const plan = planCatalogUpdate([], parseGatewayModels(LIVE_PAYLOAD));
  const plain = plan.next.find((m) => m.id === "qwen3.8-27b");
  assert.deepEqual(plain?.input, ["text"]);
  assert.equal(plan.changes.find((c) => c.id === "qwen3.8-27b")?.inferred?.includes("input"), false);
});

test("catalog: a model the gateway stopped listing is kept by default", () => {
  // Absent from one poll may mean unloaded, not retired. Deleting an operator's
  // configuration on that basis is not recoverable from this tool's output.
  const existing = [...configured(), { id: "retired-model", contextWindow: 8192, maxTokens: 1024 }];
  const plan = planCatalogUpdate(existing, parseGatewayModels(LIVE_PAYLOAD));

  assert.ok(plan.next.some((m) => m.id === "retired-model"));
  assert.equal(plan.changes.find((c) => c.id === "retired-model")?.kind, "missing");
});

test("catalog: pruning is available but opt-in", () => {
  const existing = [...configured(), { id: "retired-model", contextWindow: 8192 }];
  const plan = planCatalogUpdate(existing, parseGatewayModels(LIVE_PAYLOAD), { pruneMissing: true });

  assert.equal(
    plan.next.some((m) => m.id === "retired-model"),
    false,
  );
  assert.equal(plan.dirty, true);
});

test("catalog: a run with nothing to do reports itself as clean", () => {
  const first = planCatalogUpdate(configured(), parseGatewayModels(LIVE_PAYLOAD));
  const second = planCatalogUpdate(first.next, parseGatewayModels(LIVE_PAYLOAD));

  assert.equal(second.dirty, false, "refreshing twice must not keep rewriting the file");
  assert.match(describeCatalogPlan(second).join("\n"), /already matches/);
});

test("catalog: the summary names what changed and by how much", () => {
  const out = describeCatalogPlan(planCatalogUpdate(configured(), parseGatewayModels(LIVE_PAYLOAD))).join("\n");
  assert.match(out, /contextWindow 1048576 → 262144/);
  assert.match(out, /qwen3\.8-27b-vision/);
});

// ─── Fetching ───────────────────────────────────────────────────────────────

test("catalog: a fetch sends the key and reads the gateway's list", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const models = await fetchGatewayModels({
    baseUrl: "https://llm.example.com/v1/",
    apiKey: "secret-key",
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).Authorization ?? "");
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    }) as unknown as typeof fetch,
  });

  assert.equal(seenUrl, "https://llm.example.com/v1/models", "a trailing slash must not double up");
  assert.equal(seenAuth, "Bearer secret-key");
  assert.equal(models.length, 5);
});

test("catalog: a null Authorization header suppresses the default bearer credential", async () => {
  let seenHeaders: Record<string, string> = {};
  await fetchGatewayModels({
    baseUrl: "https://llm.example.com/v1",
    apiKey: "must-not-leak",
    headers: { Authorization: null },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    }) as unknown as typeof fetch,
  });

  assert.equal(
    Object.keys(seenHeaders).some((name) => name.toLowerCase() === "authorization"),
    false,
  );
});

test("catalog: a pre-aborted signal performs no request", async () => {
  let fetched = false;
  await assert.rejects(() =>
    fetchGatewayModels({
      baseUrl: "https://gateway.invalid/v1",
      signal: AbortSignal.abort(),
      fetchImpl: (async () => {
        fetched = true;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    }),
  );
  assert.equal(fetched, false);
});

test("catalog: an HTTP failure is reported with its status, not swallowed", async () => {
  await assert.rejects(
    () =>
      fetchGatewayModels({
        baseUrl: "https://example.invalid/v1",
        fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
      }),
    (err: unknown) => err instanceof CatalogFetchError && err.status === 503,
  );
});

test("catalog: an empty catalogue is an error, never a reason to erase the config", async () => {
  await assert.rejects(
    () =>
      fetchGatewayModels({
        baseUrl: "https://example.invalid/v1",
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })) as unknown as typeof fetch,
      }),
    /no usable models/,
  );
});

test("catalog: a string-valued context size is accepted", () => {
  // Gateways differ; a JSON number is not guaranteed.
  const models = parseGatewayModels({ data: [{ id: "m", ctx_per_request: "262144" }] });
  assert.equal(models[0]?.contextWindow, 262_144);
});

test("catalog: per-request wins over the window field when both are present", () => {
  // The precedence that keeps a session from being configured past what one
  // call may send.
  const models = parseGatewayModels({ data: [{ id: "m", ctx_per_request: 100, x_context_window: 999_999 }] });
  assert.equal(models[0]?.contextWindow, 100);
});

test("catalog: x_context_window is used when no per-request limit is reported", () => {
  const models = parseGatewayModels({ data: [{ id: "m", x_context_window: 4096 }] });
  assert.equal(models[0]?.contextWindow, 4096);
});

test("catalog: a zero or negative context size is not usable", () => {
  assert.deepEqual(parseGatewayModels({ data: [{ id: "m", ctx_per_request: 0 }] }), []);
  assert.deepEqual(parseGatewayModels({ data: [{ id: "m", ctx_per_request: -1 }] }), []);
});

test("catalog: an added model declares its fabricated cost and name", () => {
  // A zero cost is a claim the model is free. True here, but /models never said
  // so, and an undeclared fabrication is what the inferred list exists to stop.
  const plan = planCatalogUpdate([], parseGatewayModels(LIVE_PAYLOAD));
  const change = plan.changes.find((c) => c.id === "qwen3.8-27b");
  assert.ok(change?.inferred?.includes("cost"));
  assert.ok(change?.inferred?.includes("name"));
});

test("catalog: route rows keep alias metadata and inherit the backing model's window", () => {
  const models = parseGatewayModels({
    data: [
      { id: "coding-implementation", x_alias: true, x_backing_model: "qwen", x_state: "hot" },
      { id: "qwen", x_context_window: 8192, x_aliases: ["coding-implementation", ""] },
      { id: "orphan-route", x_alias: true, x_backing_model: "missing" },
    ],
  });
  const route = models.find((m) => m.id === "coding-implementation");
  assert.equal(route?.alias, true);
  assert.equal(route?.backingModel, "qwen");
  assert.equal(route?.contextWindow, 8192);
  assert.deepEqual(models.find((m) => m.id === "qwen")?.aliases, ["coding-implementation"]);
  assert.equal(models.find((m) => m.id === "qwen")?.alias, undefined);
  // No size anywhere: still not invented.
  assert.equal(
    models.find((m) => m.id === "orphan-route"),
    undefined,
  );
});

test("new aliases use their configured backing model metadata while retaining their route identity", () => {
  const plan = planCatalogUpdate(
    [
      {
        id: "vision-backend",
        reasoning: false,
        input: ["text", "image"],
        maxTokens: 4096,
        contextWindow: 131072,
        compat: { supportsDeveloperRole: false },
        baseUrl: "https://backend.invalid/v1",
        headers: { "x-backend": "private" },
      },
      { id: "reasoner-a", reasoning: true, maxTokens: 16384 },
      { id: "reasoner-b", reasoning: true, maxTokens: 16384 },
    ],
    [{ id: "fast", alias: true, backingModel: "vision-backend", contextWindow: 8192 }],
  );
  const alias = plan.next.find((model) => model.id === "fast")!;
  assert.equal(alias.id, "fast");
  assert.equal(alias.name, "fast (gateway)");
  assert.equal(alias.contextWindow, 8192);
  assert.equal(alias.reasoning, false);
  assert.deepEqual(alias.input, ["text", "image"]);
  assert.equal(alias.maxTokens, 4096);
  assert.deepEqual(alias.compat, { supportsDeveloperRole: false });
  assert.equal(alias.baseUrl, undefined, "alias requests must continue through the provider gateway");
  assert.equal(alias.headers, undefined);
});

/**
 * The gateway as actually deployed (revision `b5f62ec2`, measured 2026-11-02).
 *
 * The contract describes `x_backing_model` on a route row and `x_aliases` on a
 * concrete row; this gateway states membership the other way round — `x_members`
 * on the ROUTE row — and never advertises `x_aliases`. A parser that reads only
 * the documented direction leaves a route looking like a model with no parent.
 */
const DEPLOYED_PAYLOAD = {
  data: [
    { id: "qwen3.8-27b-modality-vision-quant-q8_k_xl", ctx_per_request: 262_144, x_state: "warm", slots: 1 },
    { id: "qwen3.8-flash_next-modality-text-quant-w3a8", ctx_per_request: 131_072, x_state: "warm", slots: 3 },
    // One member: the route has a definite answer behind it.
    { id: "qwen3.8-text", ctx_per_request: 131_072, slots: 3, x_alias: true, x_members: ["qwen3.8-flash_next-modality-text-quant-w3a8"] },
    // Several members: the gateway picks per request, so no single model is THE backing.
    {
      id: "laya",
      ctx_per_request: 131_072,
      slots: 2,
      x_alias: true,
      x_members: ["qwen3.8-flash_next-modality-text-quant-w3a8", "qwen3.8-27b-modality-vision-quant-q8_k_xl"],
    },
    // A route with no size of its own is bounded by what stands behind it.
    { id: "coding-implementation", slots: 3, x_alias: true, x_members: ["qwen3.8-flash_next-modality-text-quant-w3a8"] },
  ],
};

const TEXT = "qwen3.8-flash_next-modality-text-quant-w3a8";
const VISION = "qwen3.8-27b-modality-vision-quant-q8_k_xl";

test("membership named only on the route row still resolves", () => {
  const entries = parseGatewayModels(DEPLOYED_PAYLOAD);
  const find = (id: string) => entries.find((e) => e.id === id)!;

  assert.equal(find("qwen3.8-text").alias, true);
  assert.equal(find("qwen3.8-text").backingModel, TEXT);
  assert.equal(find("laya").backingModel, undefined, "several members name no single backing");
  // The reverse direction: which routes serve a concrete model, though it says none.
  assert.deepEqual(find(TEXT).aliases, ["qwen3.8-text", "laya", "coding-implementation"]);
  assert.deepEqual(find(VISION).aliases, ["laya"]);
});

test("a route row without its own size inherits its member's window", () => {
  const entries = parseGatewayModels(DEPLOYED_PAYLOAD);
  assert.equal(entries.find((e) => e.id === "coding-implementation")!.contextWindow, 131_072);
});

test("a route row is a route even when the gateway sets no x_alias flag", () => {
  const entries = parseGatewayModels({
    data: [{ id: TEXT, ctx_per_request: 131_072 }, { id: "solo", x_members: [TEXT] }],
  });
  assert.equal(entries.find((e) => e.id === "solo")!.alias, true);
});

test("an alias is named for the model it resolves to", () => {
  const entries = parseGatewayModels(DEPLOYED_PAYLOAD);
  const plan = planCatalogUpdate([], entries);
  const byId = new Map(plan.next.map((m) => [m.id, m]));
  // One member names the model outright.
  assert.equal(byId.get("qwen3.8-text")!.name, `qwen3.8-text → ${TEXT} (gateway alias)`);
  // Several members name the sizes it can land on.
  assert.equal(byId.get("laya")!.name, "laya → 27b/flash_next ×2 (gateway alias)");
  // A concrete model keeps the plain name.
  assert.equal(byId.get(TEXT)!.name, `${TEXT} (gateway)`);
});

test("a refresh repairs a stale alias name but never an operator's own", () => {
  const configured = (name: string): ConfiguredModel => ({
    id: "qwen3.8-text",
    name,
    api: "openai-completions",
    provider: "metabolomics",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 32_768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const entry = parseGatewayModels(DEPLOYED_PAYLOAD).find((e) => e.id === "qwen3.8-text")!;

  // Written by an earlier refresh, when Flash-Next's q4 quant was the member and
  // the w3a8 quant had not been loaded yet.
  const stale = planCatalogUpdate(
    [configured("qwen3.8-text → qwen3.8-flash_next-modality-text-quant-q4_k_xl (gateway alias)")],
    [entry],
  );
  assert.equal(stale.dirty, true);
  assert.equal(stale.next[0]!.name, `qwen3.8-text → ${TEXT} (gateway alias)`);
  assert.ok(stale.changes[0]!.details.some((d) => d.startsWith("name \"")));

  // The name written before members were known is generated too, so it is updated.
  const plain = planCatalogUpdate([configured("qwen3.8-text (gateway)")], [entry]);
  assert.equal(plain.next[0]!.name, `qwen3.8-text → ${TEXT} (gateway alias)`);

  // A name someone typed is theirs.
  const custom = planCatalogUpdate([configured("Qwen 3.8 (27B, vision)")], [entry]);
  assert.equal(custom.next[0]!.name, "Qwen 3.8 (27B, vision)");
  assert.equal(custom.dirty, false);
});
