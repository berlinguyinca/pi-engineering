/**
 * Issue #187: caps follow the gateway catalogue, cooldowns scope per model,
 * and the scheduler pass loop sleeps until something happens.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { resolveGatewayConfig } from "../../src/gateway/config.ts";
import { gatewayCapacity, parseGatewayModels } from "../../src/models/gatewayCatalog.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionScheduler, resolveSchedulerLimits } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { StreamStallWatchdog } from "../../src/workers/streamStall.ts";

const catalogue = parseGatewayModels({
  data: [
    { id: "big", ctx_per_request: 1000, slots: 9, x_active_limit: 6 },
    { id: "small", ctx_per_request: 1000, slots: 3 },
  ],
});

function mission(store: MissionStore) {
  const m = store.createMission({
    title: "t",
    goal: "g",
    user_request: "u",
    repository: ".",
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  for (const s of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) store.transitionMission(m.mission_id, s);
  return m;
}

describe("caps follow the catalogue", () => {
  it("parses active_limit and derives capacity from it, falling back to slots", () => {
    assert.equal(catalogue.find((e) => e.id === "big")?.activeLimit, 6);
    assert.equal(gatewayCapacity(catalogue), 6);
    assert.equal(gatewayCapacity(catalogue.filter((e) => e.id === "small")), 3);
    assert.equal(gatewayCapacity([]), undefined);
  });

  it("resolveSchedulerLimits uses capacity unless the env overrides", () => {
    assert.equal(resolveSchedulerLimits({}, 5).maxPerRole, 5);
    assert.equal(resolveSchedulerLimits({}, undefined).maxPerRole, 2);
    assert.equal(resolveSchedulerLimits({ PI_ENGINEERING_MAX_PER_ROLE: "1" }, 5).maxPerRole, 1);
  });

  it("the scheduler runs as many same-role tasks as the catalogue allows", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = mission(store);
    for (let i = 0; i < 5; i++) {
      store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: `t${i}` });
    }
    let active = 0;
    let peak = 0;
    const broker = new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            peak = Math.max(peak, ++active);
            await new Promise((r) => setTimeout(r, 40));
            active--;
            return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxAgents: 10 },
      gatewayCapacity: () => 4,
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(peak, 4);
  });

  it("the admission controller base concurrency follows catalogue capacity", () => {
    const c = new AdmissionController({ maxConcurrency: 4, reservedSlots: 1 });
    assert.equal(c.status().baseConcurrency, 3);
    c.applyGatewayCapacity(9);
    assert.equal(c.status().baseConcurrency, 8);
    const fixed = new AdmissionController({ maxConcurrency: 4, reservedSlots: 1, fixedConcurrency: true });
    fixed.applyGatewayCapacity(9);
    assert.equal(fixed.status().baseConcurrency, 3);
  });
});

describe("cooldown scope", () => {
  it("an unscoped 429 for one model does not block another model", async () => {
    let now = 1_000;
    const slept: number[] = [];
    const c = new AdmissionController({
      maxConcurrency: 4,
      jitterMs: 0,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    c.noteWait({ retryAfterMs: 5_000, retryable: true, source: "body", status: 429, provider: "p", model: "busy" });
    assert.equal(c.cooldownRemainingMs({ provider: "p", model: "other" }), 0);
    assert.equal(c.cooldownRemainingMs({ provider: "p", model: "busy" }), 5_000);
    await c.awaitCooldown({ provider: "p", model: "other" });
    assert.deepEqual(slept, []);
  });

  it("scope global stays process-wide, and an unidentified model falls back to process-wide", () => {
    const c = new AdmissionController({ maxConcurrency: 4, now: () => 0 });
    c.noteWait({ retryAfterMs: 5_000, retryable: true, source: "body", scope: "global", provider: "p", model: "a" });
    assert.equal(c.cooldownRemainingMs({ provider: "p", model: "other" }), 5_000);
    const d = new AdmissionController({ maxConcurrency: 4, now: () => 0 });
    d.noteWait({ retryAfterMs: 5_000, retryable: true, source: "body", status: 429 });
    assert.equal(d.cooldownRemainingMs({ provider: "p", model: "x" }), 5_000);
  });
});

describe("scheduler pass loop is event-driven", () => {
  function countingStore(store: MissionStore) {
    let calls = 0;
    const orig = store.listTasks.bind(store);
    store.listTasks = ((id: string) => {
      calls++;
      return orig(id);
    }) as typeof store.listTasks;
    return () => calls;
  }

  it("does not poll while a task runs, and wakes promptly when it settles", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = mission(store);
    store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "slow" });
    const calls = countingStore(store);
    const broker = new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            await new Promise((r) => setTimeout(r, 300));
            return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const scheduler = new MissionScheduler({ store, broker, passTickMs: 2_000 });
    const started = Date.now();
    await scheduler.runMission(m.mission_id);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `settle must wake the loop, took ${elapsed}ms`);
    assert.ok(calls() < 15, `busy loop detected: ${calls()} listTasks calls`);
  });

  it("the fallback tick still wakes a sleeping loop", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = mission(store);
    const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "slow" });
    const broker = new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            await new Promise((r) => setTimeout(r, 150));
            return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const scheduler = new MissionScheduler({ store, broker, passTickMs: 50 });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(t.task_id)?.status, "SUCCEEDED");
  });
});

describe("follow-ups", () => {
  const ok = { executionId: "e", exitStatus: "succeeded" as const, summary: "ok", artifactRefs: [], usage: {} };

  it("caps are keyed by the task's routed model", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = mission(store);
    for (let i = 0; i < 5; i++) {
      store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: `t${i}` });
    }
    let active = 0;
    let peak = 0;
    const broker = new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: async () => {
            peak = Math.max(peak, ++active);
            await new Promise((r) => setTimeout(r, 30));
            active--;
            return ok;
          },
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxAgents: 10 },
      gatewayCapacity: (model) => (model === "small" ? 2 : 5),
      modelForTask: () => "small",
    });
    await scheduler.runMission(m.mission_id);
    assert.equal(peak, 2);
  });

  it("catalogue capacity never lowers the default ceiling and tolerates active > limit", async () => {
    const c = new AdmissionController({ maxConcurrency: 4, reservedSlots: 1, jitterMs: 0 });
    c.applyGatewayCapacity(9);
    const slots = [];
    for (let i = 0; i < 6; i++) slots.push(await c.acquire());
    c.applyGatewayCapacity(1);
    assert.equal(c.status().baseConcurrency, 3, "floor is the default");
    let got = false;
    const pending = c.acquire().then((s) => {
      got = true;
      return s;
    });
    for (const s of slots.slice(0, 3)) s.release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(got, false, "3 held, limit 3: still waiting");
    slots[3]?.release();
    (await pending).release();
    assert.equal(got, true);
  });

  it("first-token window is longer than the between-token window", () => {
    process.env.PI_GATEWAY_FIRST_TOKEN_STALL_MS = "15m";
    const set: number[] = [];
    let fired = 0;
    const w = new StreamStallWatchdog({
      stallMs: 300_000,
      firstTokenMs: 900_000,
      onStall: () => fired++,
      setTimer: (_fn, ms) => {
        set.push(ms);
        return { clear: () => undefined };
      },
    });
    w.arm();
    w.token();
    assert.deepEqual(set, [900_000, 300_000]);
    assert.equal(resolveGatewayConfig().firstTokenStallMs, 900_000);
    assert.equal(fired, 0);
  });

  it("active_limit=1 with an implementer and a dependent reviewer does not deadlock", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = mission(store);
    const impl = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "i" });
    store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "reviewer",
      objective: "r",
      depends_on: [impl.task_id],
    });
    const broker = new ExecutionBroker({ store, backends: { agent: { runAgent: async () => ok } } });
    const scheduler = new MissionScheduler({ store, broker, gatewayCapacity: () => 1 });
    await scheduler.runMission(m.mission_id);
    assert.ok(store.listTasks(m.mission_id).every((t) => t.status === "SUCCEEDED"));
  });
});
