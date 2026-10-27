import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  fetchGatewayModels,
  gatewayCapacity,
  gatewayCapacityTotal,
  observedGatewayCapacity,
  parseGatewayModels,
} from "../../src/models/gatewayCatalog.ts";
import { ModelHealthProvider } from "../../src/models/health.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionScheduler, resolveSchedulerLimits } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

async function gateway(capacity: number) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ data: [{ id: "shared-model", ctx_per_request: 8192, active_limit: capacity, slots: 8 }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function tasks(store: MissionStore, requirements: Record<string, unknown> = {}) {
  const mission = store.createMission({
    title: "capacity",
    goal: "capacity",
    user_request: "capacity",
    repository: ".",
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  for (const state of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const)
    store.transitionMission(mission.mission_id, state);
  for (let i = 0; i < 5; i++)
    store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: `task ${i}`,
      execution_requirements: requirements,
    });
  return mission;
}

async function startedWorkers(signal: Promise<void>) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("scheduled workers did not start")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

test("catalogue observations remain scoped to the provider and endpoint even for identical model IDs", async () => {
  const a = await gateway(2);
  const b = await gateway(8);
  try {
    await fetchGatewayModels({ baseUrl: a.baseUrl, providerId: "capacity-a" });
    await new ModelHealthProvider({ baseUrl: b.baseUrl, providerId: "capacity-b" }).refresh();
    assert.equal(observedGatewayCapacity({ provider: "capacity-a", baseUrl: a.baseUrl, modelId: "shared-model" }), 2);
    assert.equal(observedGatewayCapacity({ provider: "capacity-b", baseUrl: b.baseUrl, modelId: "shared-model" }), 8);
    assert.equal(
      observedGatewayCapacity({ provider: "capacity-a", baseUrl: b.baseUrl, modelId: "shared-model" }),
      undefined,
    );
    assert.equal(observedGatewayCapacity({ provider: "unknown-provider", modelId: "shared-model" }), undefined);
    assert.equal(
      observedGatewayCapacity(),
      undefined,
      "an unidentified task must not consume the last provider's maximum",
    );
    await fetchGatewayModels({ baseUrl: b.baseUrl, providerId: "capacity-a" });
    assert.equal(
      observedGatewayCapacity({ provider: "capacity-a", modelId: "shared-model" }),
      undefined,
      "a provider seen at multiple endpoints requires the actual endpoint",
    );
    assert.equal(observedGatewayCapacity({ provider: "capacity-a", baseUrl: a.baseUrl, modelId: "shared-model" }), 2);
  } finally {
    await a.close();
    await b.close();
  }
});

test("zero advertised admission remains zero instead of falling back to hardware slots", () => {
  for (const active of [0, "0"]) {
    const parsed = parseGatewayModels({
      data: [{ id: "closed", ctx_per_request: 8192, active_limit: active, slots: 8 }],
    });
    assert.equal(parsed[0]?.activeLimit, 0);
    assert.equal(gatewayCapacity(parsed), 0);
    assert.equal(gatewayCapacityTotal(parsed), 0);
    assert.equal(resolveSchedulerLimits({}, 0).maxPerRole, 0);
    assert.equal(resolveSchedulerLimits({ PI_ENGINEERING_MAX_PER_ROLE: "2" }, 0).maxPerRole, 2);
  }
});

test("an unrelated health refresh cannot raise an authoritative orchestrator route's task limit", async () => {
  const a = await gateway(3);
  const b = await gateway(8);
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = tasks(store, { provider: "production-capacity-a", model: "shared-model" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let threeStarted!: () => void;
  const initial = new Promise<void>((resolve) => {
    threeStarted = resolve;
  });
  const orchestrator = new Orchestrator({
    store,
    planner: async () => [],
    limits: { maxActive: 10, maxAgents: 10 },
    modelForTask: () => ({ provider: "production-capacity-a", baseUrl: a.baseUrl, modelId: "shared-model" }),
    backends: {
      agent: {
        runAgent: async () => {
          if (++started === 3) threeStarted();
          await gate;
          return { executionId: "capacity", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
        },
      },
    },
  });
  let running: Promise<unknown> | undefined;
  try {
    await fetchGatewayModels({ providerId: "production-capacity-a", baseUrl: a.baseUrl });
    running = orchestrator.scheduler.runMission(mission.mission_id);
    await startedWorkers(initial);
    assert.equal(orchestrator.scheduler.runnable(mission.mission_id).length, 0);
    await new ModelHealthProvider({ providerId: "production-capacity-b", baseUrl: b.baseUrl }).refresh();
    assert.equal(
      orchestrator.scheduler.runnable(mission.mission_id).length,
      0,
      "provider B must not admit a fourth provider A worker",
    );
  } finally {
    release();
    await running;
    await a.close();
    await b.close();
  }
});

test("scoped zero capacity blocks automatic dispatch and preserves explicit operator limits", async () => {
  const host = await gateway(0);
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = tasks(store);
  const broker = new ExecutionBroker({ store, backends: {} });
  try {
    await fetchGatewayModels({ providerId: "zero-capacity", baseUrl: host.baseUrl });
    const route = () => ({ provider: "zero-capacity", modelId: "shared-model" });
    const scheduler = new MissionScheduler({ store, broker, modelForTask: route });
    assert.deepEqual(scheduler.runnable(mission.mission_id), []);
    const explicit = new MissionScheduler({ store, broker, modelForTask: route, limits: { maxPerRole: 1 } });
    assert.equal(
      explicit.runnable(mission.mission_id).length,
      5,
      "an explicit operator role limit remains authoritative",
    );
    for (const kind of ["process", "validation", "integration"] as const) {
      const otherStore = MissionStore.open(JsonlEventStore.inMemory());
      const m = tasks(otherStore);
      for (const task of otherStore.listTasks(m.mission_id)) otherStore.transitionTask(task.task_id, "CANCELED");
      otherStore.createTask({ mission_id: m.mission_id, kind, role: "validator", objective: "local check" });
      const local = new MissionScheduler({
        store: otherStore,
        broker: new ExecutionBroker({ store: otherStore, backends: {} }),
        modelForTask: route,
      });
      assert.equal(
        local.runnable(m.mission_id).length,
        1,
        `${kind} work must not inherit a model's zero admission limit`,
      );
    }
  } finally {
    await host.close();
  }
});

test("production tasks without an authoritative route ignore ambient catalogues and requested model pins", async () => {
  const host = await gateway(0);
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = tasks(store, { provider: "unknown-production", model: "shared-model" });
  store.updateMission(mission.mission_id, {
    operator_model_pin: { provider: "unknown-production", id: "shared-model", set_at: new Date().toISOString() },
  });
  const orchestrator = new Orchestrator({ store, planner: async () => [], backends: {} });
  try {
    await fetchGatewayModels({ providerId: "unknown-production", baseUrl: host.baseUrl });
    assert.equal(
      orchestrator.scheduler.runnable(mission.mission_id).length,
      5,
      "a requested pin may fall back at dispatch, so it is not an authoritative zero-capacity route",
    );
  } finally {
    await host.close();
  }
});

test("an unidentified production route retains configured concurrency instead of a catalogue maximum", async () => {
  const host = await gateway(8);
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = tasks(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let ready!: () => void;
  const initial = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const orchestrator = new Orchestrator({
    store,
    planner: async () => [],
    backends: {
      agent: {
        runAgent: async () => {
          if (++started === 2) ready();
          await gate;
          return {
            executionId: "unknown-capacity",
            exitStatus: "succeeded",
            summary: "ok",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    },
  });
  let running: Promise<unknown> | undefined;
  try {
    await fetchGatewayModels({ providerId: "ambient-only", baseUrl: host.baseUrl });
    running = orchestrator.scheduler.runMission(mission.mission_id);
    await startedWorkers(initial);
    assert.equal(
      orchestrator.scheduler.runnable(mission.mission_id).length,
      0,
      "the configured role limit of two remains in force without a resolved route",
    );
  } finally {
    release();
    await running;
    await host.close();
  }
});
