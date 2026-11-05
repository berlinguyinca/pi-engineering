/**
 * Live bench (default-t4-r3): a Mission implicitly pinned to the session model
 * with EVERY role configured onto that one model started its first implementer
 * worker on a different model. The router's configured role pair
 * (implementer vs reviewer) reserved the pin for the implementer, so the pin
 * was "refused" before the first dispatch.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { type ModelRef, modelKey } from "../../src/lifecycle/types.ts";
import { UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";

const P = "metabolomics";
const PIN: ModelRef = { provider: P, id: "qwen3.8-27b-modality-vision-quant-q8_k_xl" };
const OTHER: ModelRef = { provider: P, id: "qwen3.8-flash_next-modality-text-quant-w3a8" };
const ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "test_reviewer",
  "verifier",
  "orchestrator",
  "spec_verifier",
] as const;

async function adapter(models: Array<ModelRef & { contextWindow: number; toolCall?: boolean }>) {
  const dir = mkdtempSync(join(tmpdir(), "pin-first-dispatch-"));
  const records = models.map((m) => normalizeModelRecord({ toolCall: true, ...m, source: "t", reasoning: true }));
  const registry = await ModelCapabilityRegistry.open({
    sources: [{ name: "t", discover: async () => records } as never],
    context: { cwd: dir, agentDir: dir },
  });
  await registry.refresh();
  const policy = structuredClone(DEFAULT_POLICY);
  for (const role of ROLES)
    policy.routing.roles[role] = { ...(policy.routing.roles[role] ?? {}), model: modelKey(PIN) };
  const router = new RoleRouter({ registry, policy });
  return {
    select: (role: never, query: never) => router.select({ ...((query as object) ?? {}), role }),
    route: async (role: never, query: never) => {
      const selected = (await router.select({ ...((query as object) ?? {}), role })).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
    },
  };
}

for (const holdPin of [true, false]) {
  test(`the first implementer dispatch uses the implicit pin when every role is configured onto it (hold=${holdPin})`, async () => {
    const unavailable = new UnavailableModels();
    const route = createRouteModel({
      router: (await adapter([
        { ...PIN, contextWindow: 262_144 },
        { ...OTHER, contextWindow: 131_072 },
      ])) as never,
      unavailable,
      reviewFallbackModel: PIN,
      operatorPin: () => ({ ...PIN, implicit: true }),
      holdPin,
    });
    // The planner call (whose 400s are classified, never "model gone") comes first.
    assert.equal(modelKey((await route("planner", { missionId: "M" }))!), modelKey(PIN));
    assert.deepEqual(unavailable.list(), [], "a planner failure does not take the pin out of routing");

    const worker = await route("implementer", { missionId: "M" });
    assert.equal(modelKey(worker!), modelKey(PIN));
    assert.equal(worker?.pinRefused, undefined);
    assert.equal(worker?.pinNotice, undefined);

    // The reviewer of that work still avoids the pin (separation of duties).
    const reviewer = await route("reviewer", { missionId: "M" });
    assert.notEqual(reviewer && modelKey(reviewer), modelKey(PIN));
  });
}

test("a pin the router cannot use for a real reason is still refused, with a visible notice", async () => {
  const route = createRouteModel({
    router: (await adapter([
      { ...PIN, contextWindow: 262_144, toolCall: false },
      { ...OTHER, contextWindow: 131_072 },
    ])) as never,
    unavailable: new UnavailableModels(),
    reviewFallbackModel: PIN,
    operatorPin: () => ({ ...PIN, implicit: true }),
    holdPin: true,
  });
  const worker = await route("implementer", { missionId: "M" });
  assert.equal(worker?.id, OTHER.id);
  assert.equal(worker?.pinRefused, modelKey(PIN));
  assert.match(worker?.pinNotice ?? "", /operator pin .* cannot serve implementer \(/);
});
