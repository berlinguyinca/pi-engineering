import assert from "node:assert/strict";
import { test } from "node:test";
import { type CatalogModel, parseAvailabilityError } from "../../src/plannerWorker/gateway.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { DEFAULT_ROLE_CONFIG, resolveRole } from "../../src/plannerWorker/roles.ts";

const model = (extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id: "candidate",
  alias: false,
  aliases: [],
  capabilities: [],
  modalities: ["text"],
  contextWindow: 131_072,
  tools: true,
  state: "hot",
  ...extra,
});
const config = {
  ...DEFAULT_ROLE_CONFIG,
  implementer: { capability: "coding.implementation", min_context: 128_000, tools: true },
};

for (const extra of [
  { state: "draining" },
  { state: "lost" },
  { state: "unavailable" },
  { contextWindow: 4096 },
  { tools: false },
]) {
  test(`static role routing rejects known hard constraint failure ${JSON.stringify(extra)}`, async () => {
    const result = await resolveRole("implementer", {
      provider: "gw",
      config,
      catalog: [model(extra)],
      fallback: async () => ({ provider: "gw", id: "candidate" }),
    });
    assert.equal(result, null);
  });
}

test("static role routing cannot reselect an excluded model or alias backing", async () => {
  for (const entry of [model(), model({ alias: true, backing: "failed" })]) {
    const result = await resolveRole("implementer", {
      provider: "gw",
      config,
      catalog: [entry],
      exclude: entry.alias ? ["failed"] : ["candidate"],
      fallback: async () => ({ provider: "gw", id: "candidate" }),
    });
    assert.equal(result, null);
  }
});

test("static fallback receives role context and tool requirements", async () => {
  let received: unknown;
  const result = await resolveRole("implementer", {
    provider: "gw",
    config,
    catalog: [],
    fallback: async (...args) => {
      received = args;
      return { provider: "other", id: "standalone" };
    },
  });
  assert.equal(result?.via, "static");
  assert.deepEqual(received, [
    "implementer",
    [],
    { capability: "coding.implementation", min_context: 128_000, tools: true },
  ]);
});

test("static fallback only uses catalogue metadata from its own provider", async () => {
  const result = await resolveRole("implementer", {
    provider: "gw",
    config,
    catalog: [model({ state: "lost" })],
    fallback: async () => ({ provider: "other", id: "candidate" }),
  });
  assert.equal(result?.via, "static");
  assert.equal(result?.entry, undefined);
});

test("failover refreshes known candidate readiness, context and tool support", async () => {
  const resolver = new RoleResolver({
    provider: "gw",
    config,
    catalog: [model({ capabilities: ["coding.implementation"] })],
  });
  assert.equal((await resolver.resolve("implementer"))?.via, "capability");
  resolver.mergeCandidates([
    model({ capabilities: ["coding.implementation"], state: "draining", contextWindow: 4096, tools: false }),
  ]);
  assert.equal((await resolver.resolve("implementer"))?.via, "query");
  assert.equal(resolver.catalog()[0]?.state, "draining");
  assert.equal(resolver.catalog()[0]?.contextWindow, 4096);
  assert.equal(resolver.catalog()[0]?.tools, false);
  resolver.mergeCandidates([model({ capabilities: ["coding.implementation"], state: "hot" })]);
  const ready = await resolver.resolve("implementer");
  assert.equal(ready?.via, "capability");
  assert.equal(ready?.contextWindow, 131_072);
  assert.equal(resolver.catalog().length, 1);
});

test("sparse refusal candidates preserve known capabilities and recover role dispatch", async () => {
  const resolver = new RoleResolver({
    provider: "gw",
    config,
    catalog: [
      model({ capabilities: ["coding.implementation"], aliases: ["coding-implementation"], state: "draining" }),
    ],
  });
  const refusal = parseAvailabilityError(503, {
    error: {
      code: "model_not_found",
      x_fallback_candidates: [{ id: "candidate", x_state: "hot", x_context_window: 131_072 }],
    },
  });
  assert.ok(refusal);
  resolver.mergeCandidates(refusal.candidates);
  const resolved = await resolver.resolve("implementer");
  assert.equal(resolved?.model.id, "candidate");
  assert.equal(resolved?.via, "capability");
  assert.deepEqual(resolved?.entry?.capabilities, ["coding.implementation"]);
  assert.deepEqual(resolved?.entry?.aliases, ["coding-implementation"]);
  assert.deepEqual(resolved?.entry?.modalities, ["text"]);
});

test("sparse refusal candidates preserve logical alias identity", async () => {
  const resolver = new RoleResolver({
    provider: "gw",
    config,
    catalog: [model({ id: "coding-implementation", alias: true, backing: "underlying", state: "draining" })],
  });
  const refusal = parseAvailabilityError(503, {
    error: { code: "model_not_found", x_fallback_candidates: [{ id: "coding-implementation", x_state: "hot" }] },
  });
  assert.ok(refusal);
  resolver.mergeCandidates(refusal.candidates);
  const resolved = await resolver.resolve("implementer");
  assert.equal(resolved?.via, "alias");
  assert.equal(resolved?.backing, "underlying");
  assert.equal(resolved?.entry?.alias, true);
});

test("explicit empty refusal capability metadata replaces previous declarations", async () => {
  const resolver = new RoleResolver({
    provider: "gw",
    config,
    catalog: [model({ capabilities: ["coding.implementation"], alias: true, backing: "old-backing" })],
  });
  const refusal = parseAvailabilityError(503, {
    error: {
      code: "model_not_found",
      x_fallback_candidates: [{ id: "candidate", x_alias: false, x_capabilities: [], x_aliases: [], x_modalities: [] }],
    },
  });
  assert.ok(refusal);
  resolver.mergeCandidates(refusal.candidates);
  assert.equal(await resolver.resolve("implementer"), null);
  assert.deepEqual(resolver.catalog()[0]?.capabilities, []);
  assert.deepEqual(resolver.catalog()[0]?.modalities, []);
  assert.equal(resolver.catalog()[0]?.alias, false);
  assert.equal(resolver.catalog()[0]?.backing, undefined);
});
