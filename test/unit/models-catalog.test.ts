/**
 * Reconciling configured models with what a gateway actually serves.
 *
 * The fixtures are real. Measured against `https://llm.metabolomics.us/v1`, a
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
    baseUrl: "https://llm.metabolomics.us/v1/",
    apiKey: "secret-key",
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).Authorization ?? "");
      return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
    }) as unknown as typeof fetch,
  });

  assert.equal(seenUrl, "https://llm.metabolomics.us/v1/models", "a trailing slash must not double up");
  assert.equal(seenAuth, "Bearer secret-key");
  assert.equal(models.length, 5);
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
