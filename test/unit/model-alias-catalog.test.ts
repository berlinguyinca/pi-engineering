/**
 * Configuring aliases instead of concrete model ids.
 *
 * Concrete ids come and go (a node is preempted, a quant is swapped, a model is
 * renamed from `modality-text` to `modality-vision`). Pi must keep working
 * without reconfiguration, so the catalogue it writes holds only aliases, and an
 * alias's window is the smallest of its members' because the gateway may fail
 * over to any of them.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aliasView } from "../../src/models/aliasCatalog.ts";
import { type GatewayModelEntry, parseGatewayModels } from "../../src/models/gatewayCatalog.ts";
import { refreshProviderModels } from "../../src/models/refresh.ts";

const V27 = "qwen3.8-27b-modality-vision-quant-q8_k_xl";
const FLASH_VISION = "qwen3.8-flash-modality-vision-quant-iq4_xs";
const NEXT_Q4 = "qwen3.8-flash_next-modality-text-quant-q4_k_xl";
const NEXT_W3 = "qwen3.8-flash_next-modality-text-quant-w3a8";

/** `/v1/models` as the gateway served it on 2026-11-02, trimmed to what matters. */
function liveListing() {
  return {
    object: "list",
    data: [
      { id: V27, x_context_window: 262144, ctx_per_request: 262144, x_state: "warm", slots: 1 },
      { id: FLASH_VISION, x_context_window: 262144, ctx_per_request: 262144, x_state: "warm", slots: 2 },
      { id: NEXT_Q4, x_context_window: 262144, ctx_per_request: 262144, x_state: "warm", slots: 3 },
      { id: NEXT_W3, x_context_window: 131072, ctx_per_request: 131072, x_state: "warm", slots: 3 },
      {
        id: "qwen3.8-text",
        x_context_window: 262144,
        ctx_per_request: 262144,
        x_state: "warm",
        slots: 6,
        x_alias: true,
        x_members: [NEXT_Q4, NEXT_W3],
      },
    ],
  };
}

const byId = (entries: GatewayModelEntry[], id: string) => entries.find((e) => e.id === id);

test("only aliases are configured, never concrete ids", () => {
  const view = aliasView(parseGatewayModels(liveListing()));
  const ids = view.entries.map((e) => e.id);
  for (const concrete of [V27, FLASH_VISION, NEXT_Q4, NEXT_W3]) assert.ok(!ids.includes(concrete), concrete);
  for (const alias of ["qwen3.8", "qwen3.8-text", "qwen3.8-vision", "qwen3.8-flash-vision", "qwen3.8-27b-vision"]) {
    assert.ok(ids.includes(alias), `${alias} missing from ${ids.join(", ")}`);
  }
  assert.ok(view.entries.every((e) => e.alias === true));
  assert.deepEqual([...view.droppedConcrete].sort(), [FLASH_VISION, NEXT_Q4, NEXT_W3, V27].sort());
});

test("an alias window is the smallest member window, not the best member's", () => {
  const entries = aliasView(parseGatewayModels(liveListing())).entries;
  // The gateway reports 262144 for qwen3.8-text because its best member has it;
  // the w3a8 member only has 131072 and a failover can land there.
  assert.equal(byId(entries, "qwen3.8-text")?.contextWindow, 131072);
  assert.equal(byId(entries, "qwen3.8")?.contextWindow, 131072);
  assert.equal(byId(entries, "qwen3.8-vision")?.contextWindow, 262144);
});

test("renaming a model never changes which aliases exist", () => {
  const renamed = liveListing();
  // Bender changed id from modality-text to modality-vision. Aliases cover both.
  renamed.data = renamed.data.map((m) =>
    m.id === FLASH_VISION ? { ...m, id: "qwen3.8-flash-modality-text-quant-iq4_xs" } : m,
  );
  const before = aliasView(parseGatewayModels(liveListing())).entries.map((e) => e.id);
  const after = aliasView(parseGatewayModels(renamed)).entries.map((e) => e.id);
  for (const alias of ["qwen3.8", "qwen3.8-text", "qwen3.8-vision", "qwen3.8-flash-vision"]) {
    assert.ok(before.includes(alias), `before: ${alias}`);
  }
  // Same family names; only the modality-specific ones for the renamed model move.
  assert.ok(after.includes("qwen3.8-flash-text"));
  assert.ok(after.includes("qwen3.8-text"));
});

test("a model with no free slot does not give its names", () => {
  const listing = liveListing();
  listing.data = listing.data.map((m) => (m.id === V27 ? { ...m, slots: 0 } : m));
  const ids = aliasView(parseGatewayModels(listing)).entries.map((e) => e.id);
  assert.ok(!ids.includes("qwen3.8-27b-vision"));
});

test("a gateway with ids it cannot alias keeps its concrete list", () => {
  const view = aliasView(
    parseGatewayModels({
      data: [
        { id: "llama-70b", x_context_window: 8192 },
        { id: "mistral", x_context_window: 4096 },
      ],
    }),
  );
  assert.deepEqual(view.entries, []);
  assert.deepEqual(view.droppedConcrete, []);
});

test("refresh writes aliases only and prunes the concrete ids it used to hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-alias-"));
  const modelsPath = join(dir, "models.json");
  const model = (id: string) => ({ id, contextWindow: 131072, maxTokens: 32768, input: ["text"] });
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        gw: {
          baseUrl: "https://gw.example/v1",
          api: "openai-completions",
          apiKey: "k",
          models: [model("qwen3.8-flash-modality-text-quant-iq4_xs"), model(NEXT_W3)],
        },
      },
    }),
  );
  const result = await refreshProviderModels({
    modelsPath,
    providerId: "gw",
    fetchImpl: (async () => new Response(JSON.stringify(liveListing()))) as typeof fetch,
    now: () => new Date("2026-11-02T00:00:00Z"),
  });
  assert.equal(result.written, true);
  const written = JSON.parse(readFileSync(modelsPath, "utf8")).providers.gw.models as Array<{
    id: string;
    maxTokens?: number;
  }>;
  const ids = written.map((m) => m.id);
  assert.ok(ids.includes("qwen3.8-text") && ids.includes("qwen3.8-vision"));
  assert.ok(!ids.includes(NEXT_W3), "a concrete id must not stay configured");
  assert.ok(!ids.includes("qwen3.8-flash-modality-text-quant-iq4_xs"), "the renamed id must be gone");
  assert.ok(result.lines.some((l) => l.startsWith("Alias-only:")));

  // The opt-out restores the concrete list.
  const concrete = await refreshProviderModels({
    modelsPath,
    providerId: "gw",
    aliasesOnly: false,
    dryRun: true,
    fetchImpl: (async () => new Response(JSON.stringify(liveListing()))) as typeof fetch,
  });
  assert.ok(concrete.gateway.some((m) => m.id === NEXT_W3));
});
