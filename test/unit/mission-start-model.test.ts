/**
 * A mission runs on the model its session started on (owner direction after
 * missions were routed to a model other than the one that launched them and
 * blocked on it). The session's starting model becomes the mission's persisted
 * pin; the exceptions are the ones that must stay: a pin the router cannot use
 * for a role, and the independent reviewer under separation of duties. Both
 * show up as visible deviations on the placement, never silently.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RoleRouterAdapter } from "../../src/capability/adapter.ts";
import type { ModelSource } from "../../src/capability/discovery.ts";
import { normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter } from "../../src/capability/router.ts";
import { DEFAULT_POLICY } from "../../src/lifecycle/policy.ts";
import type { ModelRecord, ModelRef } from "../../src/lifecycle/types.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";
import {
  adoptOperatorModelPin,
  clearOperatorModelPin,
  onOperatorModelSelect,
  releaseMissionModelPin,
  resetSessionModelChoice,
} from "../../src/runtime/operatorModelPin.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "mission-start-model-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
// The router prefers FLINT for the implementer; the session started on QWEN.
const QWEN: ModelRef = { provider: "gw", id: "qwen3.8-27b" };
const FLINT: ModelRef = { provider: "gw", id: "flint-40b" };
const DEEPSEEK: ModelRef = { provider: "gw", id: "deepseek_v4-flash" };

class Inventory implements ModelSource {
  readonly name = "test-inventory";
  async discover(): Promise<ModelRecord[]> {
    return [QWEN, FLINT, DEEPSEEK].map((m) =>
      normalizeModelRecord({ ...m, source: "test", toolCall: true, contextWindow: 262_144, input: ["text"] }),
    );
  }
}

async function router(): Promise<Pick<RoleRouterAdapter, "route" | "select">> {
  const registry = await ModelCapabilityRegistry.open({
    sources: [new Inventory()],
    context: { cwd: SCRATCH, agentDir: SCRATCH },
  });
  await registry.refresh();
  const policy = structuredClone(DEFAULT_POLICY);
  policy.routing.roles.implementer = { ...(policy.routing.roles.implementer ?? {}), model: `gw/${FLINT.id}` };
  const r = new RoleRouter({ registry, policy });
  return {
    select: (role, query) => r.select({ ...(query ?? {}), role }),
    route: async (role, query) => {
      const selected = (await r.select({ ...(query ?? {}), role })).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
    },
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mission-start-store-"));
  const backend = await JsonlEventStore.open(join(dir, "events.jsonl"));
  const store = MissionStore.open(backend);
  const mission = (parent: string | null) =>
    store.createMission({
      title: "t",
      goal: "g",
      user_request: "g",
      repository: dir,
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering",
      parent_session_id: parent,
    }).mission_id;
  return {
    store,
    backend,
    mission,
    cleanup: async () => {
      await store.flush();
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("a mission starts on its session's model", () => {
  it("adopts the starting model, persists it, and reports one transition", async () => {
    const f = await fixture();
    try {
      resetSessionModelChoice("S1", QWEN);
      const id = f.mission("S1");
      const seen: string[] = [];
      const adopt = () =>
        adoptOperatorModelPin({
          store: f.store,
          missionId: id,
          sessionId: "S1",
          onTransition: (t) => seen.push(`${t.from}->${t.to}:${t.reason}`),
        });
      assert.equal(adopt()?.id, QWEN.id);
      assert.equal(adopt()?.id, QWEN.id);
      assert.deepEqual(seen, [`null->gw/${QWEN.id}:session starting model`], "adopted once");
      await f.store.flush();
      const replayed = MissionStore.open(f.backend);
      assert.equal(replayed.getMission(id)?.operator_model_pin?.id, QWEN.id, "survives a restart");
    } finally {
      await f.cleanup();
    }
  });

  it("does not touch another session's mission or a session with no known starting model", async () => {
    const f = await fixture();
    try {
      resetSessionModelChoice("S2", QWEN);
      const other = f.mission("S-other");
      assert.equal(adoptOperatorModelPin({ store: f.store, missionId: other, sessionId: "S2" }), null);
      resetSessionModelChoice("S3");
      const unknown = f.mission("S3");
      assert.equal(adoptOperatorModelPin({ store: f.store, missionId: unknown, sessionId: "S3" }), null);
    } finally {
      await f.cleanup();
    }
  });

  it("an operator switch still wins, and a released or auto mission is never re-seeded", async () => {
    const f = await fixture();
    try {
      resetSessionModelChoice("S4", QWEN);
      const switched = f.mission("S4");
      assert.equal(adoptOperatorModelPin({ store: f.store, missionId: switched, sessionId: "S4" })?.id, QWEN.id);
      onOperatorModelSelect("S4", { model: FLINT, source: "set" }, new Date(Date.now() + 1000));
      assert.equal(adoptOperatorModelPin({ store: f.store, missionId: switched, sessionId: "S4" })?.id, FLINT.id);

      resetSessionModelChoice("S5", QWEN);
      const released = f.mission("S5");
      adoptOperatorModelPin({ store: f.store, missionId: released, sessionId: "S5" });
      releaseMissionModelPin({ store: f.store, missionId: released });
      assert.equal(adoptOperatorModelPin({ store: f.store, missionId: released, sessionId: "S5" }), null);

      resetSessionModelChoice("S6", QWEN);
      clearOperatorModelPin("S6");
      const auto = f.mission("S6");
      assert.equal(adoptOperatorModelPin({ store: f.store, missionId: auto, sessionId: "S6" }), null);
    } finally {
      await f.cleanup();
    }
  });
});

describe("placement under a starting-model pin", () => {
  const pinOf = (key: string) => (id: string) => (id === key ? QWEN : null);

  it("places the implementer on the session model even though the router prefers another", async () => {
    const routeModel = createRouteModel({
      router: await router(),
      unavailable: new UnavailableModels(),
      operatorPin: pinOf("MSN-1"),
    });
    assert.equal(
      (await routeModel("implementer", { missionId: "MSN-other" }))?.id,
      FLINT.id,
      "unpinned: router choice",
    );
    const placed = await routeModel("implementer", { missionId: "MSN-1" });
    assert.equal(placed?.id, QWEN.id);
    assert.equal(placed?.operatorPin, true);
  });

  it("keeps the reviewer on a distinct model and says why", async () => {
    const routeModel = createRouteModel({
      router: await router(),
      unavailable: new UnavailableModels(),
      reviewFallbackModel: QWEN,
      operatorPin: pinOf("MSN-1"),
    });
    const review = await routeModel("reviewer", { missionId: "MSN-1" });
    assert.equal(review?.id, DEEPSEEK.id, "separation of duties: neither the session model nor the implementer's");
    assert.match(review?.pinNotice ?? "", /cannot serve reviewer/);
    assert.equal(review?.pinRefused, `gw/${QWEN.id}`);
  });

  it("when the pinned model is unavailable the move is recorded as a deviation, not silent", async () => {
    const unavailable = new UnavailableModels();
    const routeModel = createRouteModel({ router: await router(), unavailable, operatorPin: pinOf("MSN-1") });
    const moved = await routeModel("implementer", { missionId: "MSN-1", exclude: [QWEN] });
    assert.equal(moved?.id, FLINT.id);
    assert.equal(moved?.pinRefused, `gw/${QWEN.id}`, "the deviation names the pin that was abandoned");
    assert.notEqual(moved?.operatorPin, true);
  });
});

describe("holding the mission on its pin (execution.hold_mission_model)", () => {
  const pinOf = (key: string) => (id: string) => (id === key ? QWEN : null);
  const hold = async (holdPin: boolean) =>
    createRouteModel({
      router: await router(),
      unavailable: new UnavailableModels(),
      reviewFallbackModel: QWEN,
      operatorPin: pinOf("MSN-1"),
      holdPin,
    });

  it("retries the pin on the next dispatch and offers no replacement model", async () => {
    const routeModel = await hold(true);
    const retry = await routeModel("implementer", { missionId: "MSN-1", exclude: [QWEN] });
    assert.equal(retry?.id, QWEN.id, "the pin is tried again, not abandoned");
    assert.equal(retry?.operatorPin, true);
    const replacement = await routeModel("implementer", { missionId: "MSN-1", exclude: [QWEN], replacement: true });
    assert.equal(replacement, undefined, "no other model is offered, so the task fails with the pin's own error");
  });

  it("still routes the independent reviewer away from the pin", async () => {
    const routeModel = await hold(true);
    const review = await routeModel("reviewer", { missionId: "MSN-1", exclude: [QWEN] });
    assert.equal(review?.id, DEEPSEEK.id);
    assert.notEqual(review?.operatorPin, true);
  });

  it("with hold off, the previous failover is unchanged", async () => {
    const routeModel = await hold(false);
    const moved = await routeModel("implementer", { missionId: "MSN-1", exclude: [QWEN] });
    assert.equal(moved?.id, FLINT.id);
    assert.equal(moved?.pinRefused, `gw/${QWEN.id}`);
  });
});
