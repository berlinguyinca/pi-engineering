/**
 * A real `RoleRouter` over a fixed model inventory, shared by the takeover unit
 * tests and the end-to-end outage tests (#96).
 *
 * Hand-written routers in tests route by array position and never consult
 * capability ranking, provider ordering, or the exclusion set the way production
 * does — so a takeover test could pass against a router that could not place a
 * role at all. This builds the same `ModelCapabilityRegistry` + `RoleRouter` pair
 * `EngineeringRuntime` wires, over records that are all equally capable, so
 * ranking falls back to provider/model-name order (model-a before model-b).
 */
import { tmpdir } from "node:os";
import type { RoleRouterAdapter } from "../../src/capability/adapter.ts";
import type { ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import type { ModelRecord, ModelRef } from "../../src/lifecycle/types.ts";

class InventorySource implements ModelSource {
  readonly name = "test-inventory";
  private readonly records: ModelRecord[];
  constructor(records: ModelRecord[]) {
    this.records = records;
  }
  async discover(): Promise<ModelRecord[]> {
    return this.records;
  }
}

/** Route worker roles over `models` with the production router. */
export async function realRouter(models: ModelRef[]): Promise<Pick<RoleRouterAdapter, "route">> {
  const records = models.map((m) =>
    normalizeModelRecord({ ...m, source: "test", toolCall: true, contextWindow: 200_000 }),
  );
  const registry = await ModelCapabilityRegistry.open({
    sources: [new InventorySource(records)],
    context: { cwd: tmpdir(), agentDir: tmpdir() },
  });
  await registry.refresh();
  const router = new RoleRouter({ registry, policy: DEFAULT_POLICY });
  return {
    route: async (role, query) => {
      const selected = (await router.select({ ...(query ?? {}), role })).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
    },
  };
}
