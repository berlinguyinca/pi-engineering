/**
 * Planner/worker (PW-) missions follow the operator pin at every role
 * resolution — contract dispatch, replan, review — while keeping the planner
 * and implementer apart when another capable model exists, and honouring the
 * catalogue's hard checks (readiness, context, tools).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CatalogModel } from "../../src/plannerWorker/gateway.ts";
import type { ModelRef } from "../../src/plannerWorker/planner.ts";
import { RoleResolver } from "../../src/plannerWorker/resolver.ts";
import { DEFAULT_ROLE_CONFIG } from "../../src/plannerWorker/roles.ts";

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  alias: false,
  aliases: [],
  capabilities: ["coding.planning", "coding.implementation", "coding.review"],
  modalities: ["text"],
  contextWindow: 262_144,
  tools: true,
  state: "warm",
  ...extra,
});

const GLM = "glm5.3-flash-modality-vision-quant-q6_k_xl";
const DEEPSEEK = "deepseek_v4-flash-modality-text-quant-mxfp4";
const QWEN = "qwen3.8-27b";

function resolver(catalog: CatalogModel[], pin: () => ModelRef | null): RoleResolver {
  return new RoleResolver({ provider: "gw", catalog, operatorPin: pin });
}

describe("planner-worker: operator pin", () => {
  it("places every role on the pin, re-read at each resolution", async () => {
    let pin: ModelRef | null = null;
    // Unpinned ranking prefers the warm GLM over the cold DeepSeek.
    const r = resolver([model(GLM), model(DEEPSEEK, { state: "cold" })], () => pin);
    assert.equal((await r.resolve("reviewer"))?.model.id, GLM, "no pin: ranking as before");
    pin = { provider: "gw", id: DEEPSEEK };
    for (const role of ["planner", "implementer", "reviewer", "researcher", "debugger"] as const) {
      const resolved = await r.resolve(role);
      assert.equal(resolved?.model.id, DEEPSEEK, role);
      assert.ok(
        resolved?.notes.some((note) => /operator pin/.test(note)),
        role,
      );
    }
  });

  it("keeps planner and implementer on different models when another capable one exists", async () => {
    const r = resolver([model(GLM), model(QWEN), model(DEEPSEEK)], () => ({ provider: "gw", id: DEEPSEEK }));
    const planner = await r.resolve("planner");
    assert.equal(planner?.model.id, DEEPSEEK);
    const implementer = await r.resolve("implementer", [DEEPSEEK]);
    assert.notEqual(implementer?.model.id, DEEPSEEK);
    assert.ok(implementer?.notes.some((note) => /operator pin .* also serves a role .* must differ/.test(note)));
  });

  it("uses the pin for both roles when it is the only capable model, and says why", async () => {
    const r = resolver([model(DEEPSEEK), model(GLM, { state: "unavailable" })], () => ({
      provider: "gw",
      id: DEEPSEEK,
    }));
    const implementer = await r.resolve("implementer", [DEEPSEEK]);
    assert.equal(implementer?.model.id, DEEPSEEK);
    assert.ok(implementer?.notes.some((note) => /only the operator-pinned model/.test(note)));
  });

  it("does not place a role on a pinned model the catalogue says cannot serve it", async () => {
    const r = new RoleResolver({
      provider: "gw",
      catalog: [model(GLM), model(DEEPSEEK, { contextWindow: 8_192 })],
      config: { ...DEFAULT_ROLE_CONFIG, implementer: { ...DEFAULT_ROLE_CONFIG.implementer, min_context: 100_000 } },
      operatorPin: () => ({ provider: "gw", id: DEEPSEEK }),
    });
    const implementer = await r.resolve("implementer");
    assert.equal(implementer?.model.id, GLM);
    assert.ok(implementer?.notes.some((note) => /operator pin gw\/deepseek\S* cannot serve implementer/.test(note)));
  });
});
