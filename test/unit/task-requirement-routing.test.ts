/**
 * P3 — planner-assigned per-task execution requirements must actually route.
 * The broker records a task's `execution_requirements.model` / `.capabilities`
 * on the execution and hands them to the backend as `modelRequirements`; the
 * capability router already understands `taskOverride` (highest-precedence
 * model) and `extraRequires` (hard capability requirements). `createRouteModel`
 * must thread both through so a per-task requirement changes the placement,
 * not just the record.
 *
 * Routing runs on a real RoleRouter over an in-memory capability registry.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { type ModelRef } from "../../src/lifecycle/types.ts";
import { UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "task-req-routing-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const GLM: ModelRef = { provider: "gw", id: "glm5.3-flash" };
const QWEN: ModelRef = { provider: "gw", id: "qwen3.8-27b" };
const VISION: ModelRef = { provider: "gw", id: "vision-model" };

class InventorySource implements ModelSource {
  readonly name = "test-inventory";
  private readonly records: ReturnType<typeof normalizeModelRecord>[];
  constructor(records: ReturnType<typeof normalizeModelRecord>[]) {
    this.records = records;
  }
  async discover(): Promise<ReturnType<typeof normalizeModelRecord>[]> {
    return this.records;
  }
}

async function routerFixture() {
  const records = [
    normalizeModelRecord({ ...GLM, source: "test", toolCall: true, contextWindow: 262_144, input: ["text"] }),
    normalizeModelRecord({ ...QWEN, source: "test", toolCall: true, contextWindow: 262_144, input: ["text"] }),
    normalizeModelRecord({
      ...VISION,
      source: "test",
      toolCall: true,
      contextWindow: 262_144,
      input: ["text", "image"],
    }),
  ];
  const registry = await ModelCapabilityRegistry.open({
    sources: [new InventorySource(records)],
    context: { cwd: SCRATCH, agentDir: SCRATCH },
  });
  await registry.refresh();
  const policy = structuredClone(DEFAULT_POLICY);
  // Pin the implementer onto GLM so a task requirement must beat a role pin.
  // (Only the implementer: pinning the reviewer too would reserve GLM for it
  // through separation of duties and change what "the role pin wins" means.)
  policy.routing.roles["implementer"] = {
    ...(policy.routing.roles["implementer"] ?? {}),
    model: `${GLM.provider}/${GLM.id}`,
  };
  const router = new RoleRouter({ registry, policy });
  return {
    select: (role: string, query?: Record<string, unknown>) => router.select({ ...(query ?? {}), role } as never),
    route: async (role: string, query?: Record<string, unknown>) => {
      const selected = (await router.select({ ...(query ?? {}), role } as never)).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
    },
  };
}

describe("P3 — per-task execution requirements route", () => {
  it("a task model override beats a role pin (taskOverride)", async () => {
    const routeModel = createRouteModel({ router: await routerFixture(), unavailable: new UnavailableModels() });
    const base = await routeModel("implementer");
    assert.equal(base?.id, GLM.id, "without a requirement the role pin wins");
    const routed = await routeModel("implementer", { taskOverride: `${QWEN.provider}/${QWEN.id}` });
    assert.equal(routed?.id, QWEN.id, "the task's required model is honoured over the role pin");
  });

  it("a task capability requirement filters candidates (extraRequires)", async () => {
    const routeModel = createRouteModel({ router: await routerFixture(), unavailable: new UnavailableModels() });
    const routed = await routeModel("implementer", { extraRequires: ["vision"] });
    assert.equal(routed?.id, VISION.id, "a vision-required task is placed on the only vision-capable model");
  });

  it("an unsatisfiable task requirement degrades gracefully, never throws", async () => {
    const routeModel = createRouteModel({ router: await routerFixture(), unavailable: new UnavailableModels() });
    // No model in the registry has this capability: the requirement eliminates
    // every candidate, the role is simply left unrouted (the worker then runs
    // on the executor default), and nothing throws.
    assert.doesNotThrow(() => routeModel("implementer", { extraRequires: ["nonexistent_capability"] }));
  });
});
