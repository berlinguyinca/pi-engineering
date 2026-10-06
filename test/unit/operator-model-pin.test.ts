/**
 * Operator model pin (owner report: "After changing the model, we are still
 * using the old model in the mission"). An explicit `/model` switch becomes
 * the session's operator pin; this session's missions adopt it at their next
 * dispatch, persist it, and it wins over static role pins and router ranking —
 * unless the router knows the pinned model cannot serve the role.
 *
 * Routing runs on a real RoleRouter over an in-memory capability registry and a
 * real MissionStore over a JSONL event store.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
  type PinTransition,
  adoptOperatorModelPin,
  claimMissionForSession,
  clearOperatorModelPin,
  describeMissionModel,
  describeModelChoice,
  onOperatorModelSelect,
  resetSessionModelChoice,
  sessionModelChoice,
} from "../../src/runtime/operatorModelPin.ts";
import { missionReportLines } from "../../src/tools/missionReport.ts";

const GLM: ModelRef = { provider: "gw", id: "glm5.3-flash-modality-vision-quant-q6_k_xl" };
const DEEPSEEK: ModelRef = { provider: "gw", id: "deepseek_v4-flash-modality-text-quant-mxfp4" };

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

/** A real router whose policy pins every role engineering.yaml-style onto GLM. */
async function pinnedPolicyRouter(): Promise<Pick<RoleRouterAdapter, "route" | "select">> {
  const records = [
    normalizeModelRecord({ ...GLM, source: "test", toolCall: true, contextWindow: 262_144, input: ["text", "image"] }),
    normalizeModelRecord({ ...DEEPSEEK, source: "test", toolCall: true, contextWindow: 262_144, input: ["text"] }),
  ];
  const registry = await ModelCapabilityRegistry.open({
    sources: [new InventorySource(records)],
    context: { cwd: tmpdir(), agentDir: tmpdir() },
  });
  await registry.refresh();
  const policy = structuredClone(DEFAULT_POLICY);
  for (const role of ["implementer", "planner", "vision_reviewer"]) {
    policy.routing.roles[role] = { ...(policy.routing.roles[role] ?? {}), model: `${GLM.provider}/${GLM.id}` };
  }
  const router = new RoleRouter({ registry, policy });
  return {
    select: (role, query) => router.select({ ...(query ?? {}), role }),
    route: async (role, query) => {
      const selected = (await router.select({ ...(query ?? {}), role })).selected;
      return selected ? { provider: selected.provider, id: selected.id } : undefined;
    },
  };
}

async function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "operator-pin-"));
  const backend = await JsonlEventStore.open(join(dir, "events.jsonl"));
  const store = MissionStore.open(backend);
  const mission = (parent: string | null) =>
    store.createMission({
      title: "propagate the hang fix",
      goal: "propagate the hang fix",
      user_request: "propagate the hang fix",
      repository: dir,
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering",
      parent_session_id: parent,
    }).mission_id;
  const cleanup = async () => {
    await store.flush();
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, backend, store, mission, cleanup };
}

describe("operator model pin: session choice", () => {
  it("an operator /model switch pins; restore and our own automatic fallback do not", () => {
    const session = "S-select";
    resetSessionModelChoice(session, GLM);
    assert.equal(onOperatorModelSelect(session, { model: DEEPSEEK, source: "restore" }).action, "ignored");
    assert.equal(onOperatorModelSelect(session, { model: DEEPSEEK, source: "set", automatic: true }).action, "ignored");
    assert.equal(sessionModelChoice(session), undefined);
    const pinned = onOperatorModelSelect(session, { model: DEEPSEEK, source: "set" });
    assert.equal(pinned.action, "pinned");
    assert.equal(describeModelChoice(sessionModelChoice(session)), `model: gw/${DEEPSEEK.id} (operator pin)`);
  });

  it("switching back to the session's starting model clears the pin, as does /engineering-model auto", () => {
    const session = "S-back";
    resetSessionModelChoice(session, GLM);
    onOperatorModelSelect(session, { model: DEEPSEEK, source: "cycle" });
    assert.equal(onOperatorModelSelect(session, { model: GLM, source: "set" }).action, "cleared");
    assert.equal(sessionModelChoice(session)?.kind, "auto");
    onOperatorModelSelect(session, { model: DEEPSEEK, source: "set" });
    clearOperatorModelPin(session);
    assert.match(describeModelChoice(sessionModelChoice(session)), /^model: auto/);
  });
});

describe("operator model pin: mission adoption", () => {
  it("this session's missions adopt the pin once, persist it, and report a MODEL_TRANSITION", async () => {
    const f = await storeFixture();
    try {
      const session = "S-adopt";
      resetSessionModelChoice(session, GLM);
      const ours = f.mission(session);
      const theirs = f.mission("S-other");
      onOperatorModelSelect(session, { model: DEEPSEEK, source: "set" });
      const transitions: PinTransition[] = [];
      const adopt = (missionId: string) =>
        adoptOperatorModelPin({
          store: f.store,
          missionId,
          sessionId: session,
          onTransition: (t) => transitions.push(t),
        });

      assert.deepEqual(
        { provider: adopt(ours)?.provider, id: adopt(ours)?.id },
        { provider: DEEPSEEK.provider, id: DEEPSEEK.id },
      );
      assert.equal(adopt(theirs), null, "another session's mission is not affected");
      assert.deepEqual(
        transitions.map((t) => [t.missionId, t.from, t.to]),
        [[ours, null, `gw/${DEEPSEEK.id}`]],
        "adopted exactly once",
      );
      assert.equal(describeMissionModel(f.store.getMission(ours)!), `model: gw/${DEEPSEEK.id} (operator pin)`);
      assert.ok(missionReportLines(f.store, ours).includes(`model: gw/${DEEPSEEK.id} (operator pin)`));

      // Restart: a fresh store replays the pin, and a session with no opinion keeps it.
      await f.store.flush();
      const replayed = MissionStore.open(f.backend);
      assert.equal(replayed.getMission(ours)?.operator_model_pin?.id, DEEPSEEK.id);
      assert.equal(
        adoptOperatorModelPin({ store: replayed, missionId: ours, sessionId: "S-after-restart" })?.id,
        DEEPSEEK.id,
      );

      // A mission this session resumes follows it too; auto clears the persisted pin.
      claimMissionForSession(session, theirs);
      assert.equal(adopt(theirs)?.id, DEEPSEEK.id);
      clearOperatorModelPin(session);
      assert.equal(adopt(ours), null);
      assert.equal(f.store.getMission(ours)?.operator_model_pin, null);
      assert.equal(transitions.at(-1)?.to, null);
    } finally {
      await f.cleanup();
    }
  });
});

describe("operator model pin: routing", () => {
  it("the pin wins over an engineering.yaml role pin for every worker role", async () => {
    const routeModel = createRouteModel({
      router: await pinnedPolicyRouter(),
      unavailable: new UnavailableModels(),
      operatorPin: (missionId) => (missionId === "MSN-pinned" ? DEEPSEEK : null),
    });
    assert.equal((await routeModel("implementer", { missionId: "MSN-unpinned" }))?.id, GLM.id, "role pin as before");
    for (const role of ["implementer", "planner", "investigator", "scout"]) {
      const routed = await routeModel(role, { missionId: "MSN-pinned" });
      assert.equal(routed?.id, DEEPSEEK.id, role);
      assert.equal(routed?.operatorPin, true, role);
    }
  });

  it("a role the pinned model cannot serve falls back per router rules and says why", async () => {
    const routeModel = createRouteModel({
      router: await pinnedPolicyRouter(),
      unavailable: new UnavailableModels(),
      operatorPin: () => DEEPSEEK,
    });
    const routed = await routeModel("vision_reviewer", { missionId: "MSN-pinned" });
    assert.equal(routed?.id, GLM.id);
    assert.notEqual(routed?.operatorPin, true);
    assert.match(routed?.warning ?? "", /operator pin gw\/deepseek\S* cannot serve vision_reviewer \(missing vision/);
  });

  it("a pinned model already tried or confirmed gone is not forced back", async () => {
    const unavailable = new UnavailableModels();
    const routeModel = createRouteModel({
      router: await pinnedPolicyRouter(),
      unavailable,
      operatorPin: () => DEEPSEEK,
    });
    assert.equal((await routeModel("implementer", { missionId: "M", exclude: [DEEPSEEK] }))?.id, GLM.id);
    unavailable.mark(DEEPSEEK);
    assert.equal((await routeModel("implementer", { missionId: "M" }))?.id, GLM.id);
  });
});
