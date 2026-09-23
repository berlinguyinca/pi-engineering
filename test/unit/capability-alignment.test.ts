import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DiscoveryContext, ModelSource } from "../../src/capability/discovery.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { DEFAULT_POLICY, deepMerge, validatePolicy } from "../../src/lifecycle/policy.ts";
import type { EngineeringPolicy } from "../../src/lifecycle/policy.ts";
import type { ModelRecord } from "../../src/lifecycle/types.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";

function record(provider: string, id: string): ModelRecord {
  return normalizeModelRecord({
    source: "test",
    toolCall: true,
    contextWindow: 200_000,
    provider,
    id,
    available: true,
    healthy: true,
  });
}

class FakeSource implements ModelSource {
  readonly name = "fake";
  private readonly records: ModelRecord[];
  constructor(records: ModelRecord[]) {
    this.records = records;
  }
  async discover(): Promise<ModelRecord[]> {
    return this.records;
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-eng-cap-align-"));
}

/**
 * The cross-check createRoleRouter installs: demote every record the
 * execution ModelRuntime cannot actually run (its available snapshot).
 */
function executionCrossCheck(runnable: Array<{ provider: string; id: string }>) {
  const keys = new Set(runnable.map((m) => `${m.provider}/${m.id}`));
  return (records: ModelRecord[]) => {
    for (const rec of records) {
      if (!keys.has(`${rec.provider}/${rec.id}`)) {
        rec.available = false;
        rec.healthy = false;
        rec.healthReason = "not registered in the execution ModelRuntime";
      }
    }
  };
}

function policy(): EngineeringPolicy {
  const clone = deepMerge(structuredClone(DEFAULT_POLICY), {}) as EngineeringPolicy;
  assert.deepEqual(validatePolicy(clone).filter((i) => i.severity === "error"), []);
  return clone;
}

test("registry onInventory hook corrects records after a refresh", async () => {
  const cwd = await tempDir();
  try {
    const registry = await ModelCapabilityRegistry.open({
      sources: [
        new FakeSource([
          record("alpha", "runnable"),
          record("beta", "catalog-only"),
        ]),
      ],
      context: { cwd, agentDir: cwd } satisfies DiscoveryContext,
      onInventory: executionCrossCheck([{ provider: "alpha", id: "runnable" }]),
    });
    await registry.refresh();

    const all = registry.all();
    const runnable = all.find((r) => r.id === "runnable");
    const catalogOnly = all.find((r) => r.id === "catalog-only");
    assert.ok(runnable && catalogOnly);
    assert.equal(runnable.available, true);
    assert.equal(runnable.healthy, true);
    assert.equal(catalogOnly.available, false, "catalog-only model must be demoted");
    assert.equal(catalogOnly.healthy, false, "catalog-only model must be unhealthy");
    assert.match(catalogOnly.healthReason ?? "", /execution ModelRuntime/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("registry onInventory hook also corrects a restored cache", async () => {
  const cwd = await tempDir();
  try {
    // Seed a cache file whose inventory claims a model is available even
    // though the execution runtime no longer registers it.
    const file = join(cwd, "capability-cache.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        penalties: [],
        inventory: [
          { ...record("alpha", "runnable") },
          { ...record("beta", "stale-entry"), available: true, healthy: true },
        ],
      }),
      "utf-8",
    );
    const registry = await ModelCapabilityRegistry.open({
      sources: [],
      context: { cwd, agentDir: cwd } satisfies DiscoveryContext,
      file,
      onInventory: executionCrossCheck([{ provider: "alpha", id: "runnable" }]),
    });

    const stale = registry.get({ provider: "beta", id: "stale-entry" });
    assert.ok(stale);
    assert.equal(
      stale.available,
      false,
      "restored stale entry must be demoted before routing reads it",
    );
    assert.equal(stale.healthy, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("router never selects a model the execution runtime cannot run", async () => {
  const cwd = await tempDir();
  try {
    const registry = await ModelCapabilityRegistry.open({
      sources: [
        new FakeSource([
          record("alpha", "runnable"),
          record("beta", "catalog-only"),
        ]),
      ],
      context: { cwd, agentDir: cwd } satisfies DiscoveryContext,
      onInventory: executionCrossCheck([{ provider: "alpha", id: "runnable" }]),
    });
    await registry.refresh();
    const router = new RoleRouter({ registry, policy: policy() });

    for (const role of ["orchestrator", "planner", "implementer", "reviewer", "test_reviewer", "verifier"] as const) {
      const decision = await router.select({ role });
      const picked = decision.selected;
      if (picked) {
        assert.notEqual(
          picked.id,
          "catalog-only",
          `${role} must not be routed to a model the runtime cannot run`,
        );
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
