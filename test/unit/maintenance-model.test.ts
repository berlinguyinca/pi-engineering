import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import { validateMaintenanceModel } from "../../src/runtime/maintenanceModel.ts";
import { UnavailableModels } from "../../src/runtime/modelRouting.ts";

const selectedModel = { provider: "gw", id: "working" };
async function fixture(options: { contextWindow?: number; input?: string[]; toolCall?: boolean } = {}) {
  const records = [
    normalizeModelRecord({
      ...selectedModel,
      source: "test",
      contextWindow: 262144,
      input: ["text", "image"],
      toolCall: true,
      ...options,
    }),
    normalizeModelRecord({
      provider: "gw",
      id: "old",
      source: "test",
      contextWindow: 262144,
      input: ["text", "image"],
      toolCall: true,
    }),
  ];
  const registry = await ModelCapabilityRegistry.open({
    sources: [{ name: "test", discover: async () => records }],
    context: { cwd: "/tmp", agentDir: "/tmp" },
  });
  await registry.refresh();
  const router = new RoleRouter({ registry, policy: structuredClone(DEFAULT_POLICY) });
  return {
    registry,
    select: (role: Parameters<typeof router.select>[0]["role"], query: object) => router.select({ ...query, role }),
  };
}
const task = { role: "implementer", kind: "agent", status: "PENDING", execution_requirements: {} } as const;

test("maintenance exact model accepts registered capable replacement and refuses unavailable or unknown models", async () => {
  const router = await fixture();
  const unavailable = new UnavailableModels();
  const options = {
    router,
    unavailable,
    selectedModel,
    tasks: [task],
    baseline: { contextWindow: 262144, input: ["text", "image"] },
  };
  assert.equal(await validateMaintenanceModel(options), undefined);
  assert.match(
    (await validateMaintenanceModel({ ...options, selectedModel: { provider: "gw", id: "missing" } }))!,
    /registered/,
  );
  unavailable.mark(selectedModel);
  assert.match((await validateMaintenanceModel(options))!, /unavailable/);
  assert.match((await validateMaintenanceModel({ ...options, router: undefined }))!, /catalogue/);
});

test("maintenance model refuses context, modality, tool and exact task contract downgrades", async () => {
  for (const [changes, reason] of [
    [{ contextWindow: 32768 }, /context/],
    [{ input: ["text"] }, /vision/],
    [{ toolCall: false }, /tool_calling/],
  ] as const) {
    const router = await fixture(changes as never);
    const refusal = await validateMaintenanceModel({
      router,
      unavailable: new UnavailableModels(),
      selectedModel,
      tasks: [task],
      baseline: { contextWindow: 262144, input: ["text", "image"] },
    });
    assert.match(refusal!, reason);
  }
  const router = await fixture();
  const options = {
    router,
    unavailable: new UnavailableModels(),
    selectedModel,
    tasks: [{ ...task, execution_requirements: { model: "gw/exact-other" } }],
  };
  assert.match((await validateMaintenanceModel(options))!, /exact model/);
  assert.match(
    (await validateMaintenanceModel({
      ...options,
      tasks: [{ ...task, execution_requirements: { capabilities: ["unsupported-capability"] } }],
    }))!,
    /unsupported-capability/,
  );
  assert.match((await validateMaintenanceModel({ ...options, tasks: [{ ...task, role: "unknown-role" }] }))!, /role/);
});

test("maintenance preserves the previous model reasoning requirement", async () => {
  const router = await fixture();
  const refusal = await validateMaintenanceModel({
    router,
    unavailable: new UnavailableModels(),
    selectedModel,
    tasks: [task],
    baseline: { reasoning: true },
  });
  assert.match(refusal!, /reasoning/);
});
