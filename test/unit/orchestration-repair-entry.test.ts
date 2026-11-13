/**
 * #629 (2/2): `BLOCKED` must have an exit an agent can reach.
 *
 * `MissionStore.transitionMission` refuses BLOCKED -> REPAIRING without a durable
 * recovery decision, which is right — but the run/repair paths called it with no
 * decision at all, so the mission surfaced as
 * "BLOCKED -> REPAIRING requires a durable repair recovery decision ID": a
 * precondition with no door. `enterRepairing` is the single entry point those
 * paths use: it consumes the planned decision for the *current* blocked episode
 * when one exists, and otherwise names the command that actually moves the
 * mission instead of restating the invariant.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import {
  RepairEntryBlockedError,
  enterRepairing,
  plannedRepairDecision,
  repairEntryBlocker,
} from "../../src/orchestration/repairEntry.ts";
import type { FailureClassification, Mission, RecoveryDecision } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildCoreTools } from "../../src/tools/coreTools.ts";

function blockedMission(): { store: MissionStore; mission: Mission } {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "remove the vendored extension",
    goal: "delete the extension and update the manifest",
    user_request: `Remove the vendored split-view extension from the repository`,
    repository: ".",
    base_ref: "main",
    risk_profile: "high",
    workflow_class: "engineering_review",
  });
  store.transitionMission(mission.mission_id, "CLASSIFYING");
  const blocked = store.transitionMission(mission.mission_id, "BLOCKED");
  store.classifyFailure({
    classificationId: "FCL-entry",
    missionId: mission.mission_id,
    taskId: null,
    executionId: null,
    category: "WORKSPACE_SCOPE_MISMATCH",
    evidenceRefs: ["artifact://scope"],
    fingerprint: "scope:read-only-target",
    summary: "no writable workspace: the removal target was scoped read-only",
    classifiedAt: "2026-11-10T00:00:00.000Z",
  } satisfies FailureClassification);
  return { store, mission: blocked };
}

function base(missionId: string): RecoveryDecision {
  return {
    recoveryId: "RCV-entry",
    missionId,
    classificationId: "FCL-entry",
    action: "REPAIR_BLOCKED_MISSION",
    expectedMaterialChange: "the removal target is writable and the mission runs",
    attempt: 1,
    maxAttempts: 2,
    deadline: null,
    nextActionAt: "2026-11-10T00:01:00.000Z",
    status: "planned",
    decidedAt: "2026-11-10T00:00:30.000Z",
    failureFingerprint: "scope:read-only-target",
  };
}

describe("enterRepairing", () => {
  it("consumes the planned decision for the current blocked episode", () => {
    const { store, mission } = blockedMission();
    const planned = store.planRecovery(base(mission.mission_id));

    const repairing = enterRepairing(store, mission.mission_id);

    assert.equal(repairing.status, "REPAIRING");
    assert.equal(
      store.getRecoveryDecision(planned.recoveryId)?.status,
      "started",
      "the transition consumes the decision",
    );
  });

  it("honours an explicitly named decision", () => {
    const { store, mission } = blockedMission();
    store.planRecovery(base(mission.mission_id));
    const named = store.planRecovery({ ...base(mission.mission_id), recoveryId: "RCV-named" });

    const repairing = enterRepairing(store, mission.mission_id, named.recoveryId);

    assert.equal(repairing.status, "REPAIRING");
    assert.equal(store.getRecoveryDecision(named.recoveryId)?.status, "started");
    assert.equal(store.getRecoveryDecision("RCV-entry")?.status, "planned", "the unselected decision stays planned");
  });

  it("names the door when nothing can carry the mission out of BLOCKED", () => {
    const { store, mission } = blockedMission();

    assert.throws(
      () => enterRepairing(store, mission.mission_id),
      (error: Error) =>
        error instanceof RepairEntryBlockedError &&
        /planned repair recovery decision/.test(error.message) &&
        error.message.includes(mission.mission_id) &&
        error.message.includes(`/mission resume ${mission.mission_id}`) &&
        error.message.includes(mission.blocked_episode_id ?? "BLK-unset"),
      "the refusal must name the mission, its episode, and the command that resumes it",
    );
  });

  it("does not treat a waiting action as repair authority", () => {
    const { store, mission } = blockedMission();
    store.planRecovery({ ...base(mission.mission_id), recoveryId: "RCV-wait", action: "WAIT_FOR_REQUIREMENT" });
    store.planRecovery({ ...base(mission.mission_id), recoveryId: "RCV-pause", action: "PAUSE_FOR_PERSISTENCE" });

    assert.equal(plannedRepairDecision(store, mission.mission_id), undefined);
    assert.throws(() => enterRepairing(store, mission.mission_id), /planned repair recovery decision/);
  });

  it("does not carry a decision from a superseded blocked episode", () => {
    const { store, mission } = blockedMission();
    // RCV-stale belongs to the first episode and stays planned; RCV-used carries
    // that episode into repair, and the mission then blocks again. The new
    // episode must not inherit the leftover decision.
    store.planRecovery({ ...base(mission.mission_id), recoveryId: "RCV-stale" });
    store.planRecovery({ ...base(mission.mission_id), recoveryId: "RCV-used" });
    enterRepairing(store, mission.mission_id, "RCV-used");
    const second = store.transitionMission(mission.mission_id, "BLOCKED");
    assert.notEqual(second.blocked_episode_id, mission.blocked_episode_id);

    assert.equal(plannedRepairDecision(store, mission.mission_id)?.recoveryId, undefined);
    assert.throws(() => enterRepairing(store, mission.mission_id), /planned repair recovery decision/);
  });

  it("is a no-op for a mission already in REPAIRING", () => {
    const { store, mission } = blockedMission();
    store.planRecovery(base(mission.mission_id));
    const repairing = enterRepairing(store, mission.mission_id);
    const revision = repairing.revision;

    assert.equal(enterRepairing(store, mission.mission_id).revision, revision);
  });

  it("moves a non-blocked mission into REPAIRING without recovery authority", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "re-run a missing gate",
      goal: "produce the validation evidence",
      user_request: "validate the candidate",
      repository: ".",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    for (const status of [
      "CLASSIFYING",
      "PLANNING",
      "READY",
      "QUEUED",
      "STARTING",
      "EXECUTING",
      "INTEGRATING",
      "VALIDATING",
    ] as const) {
      store.transitionMission(mission.mission_id, status);
    }

    assert.equal(enterRepairing(store, mission.mission_id).status, "REPAIRING");
  });

  it("refuses an unknown mission", () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    assert.throws(() => enterRepairing(store, "MSN-missing"), /unknown mission MSN-missing/);
  });
});

describe("repairEntryBlocker", () => {
  it("states the precondition and both doors", () => {
    const { store, mission } = blockedMission();
    const current = store.getMission(mission.mission_id)!;

    const message = repairEntryBlocker(current);

    assert.match(message, /BLOCKED/);
    assert.ok(message.includes(current.blocked_episode_id ?? ""));
    assert.ok(message.includes(`/mission resume ${mission.mission_id}`));
    assert.ok(message.includes(`/mission cancel ${mission.mission_id}`));
  });
});

describe("the durable gate's own refusal", () => {
  it("names the command instead of only the invariant", () => {
    const { store, mission } = blockedMission();

    assert.throws(
      () => store.transitionMission(mission.mission_id, "REPAIRING"),
      (error: Error) =>
        /requires a durable repair recovery decision ID/.test(error.message) &&
        error.message.includes(`/mission resume ${mission.mission_id}`),
      "an operator reading the raw store error still finds the door",
    );
  });
});

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;

describe("the mission tool's answer", () => {
  it("returns the door as structured detail, not a bare resume failure", async () => {
    const { store, mission } = blockedMission();
    const orchestrator = new Orchestrator({
      store,
      backends: {},
      planner: async () => [],
      limitsProvider: async () => ({ worker_inactivity_ms: 3_600_000 }),
    });
    const tools = buildCoreTools(async () => ({
      ledger: {} as never,
      artifacts: {} as never,
      broker: null,
      currentWorkItemId: () => null,
      actor: () => ({ type: "user" }),
      orchestrator,
      // The real resume wiring: EngineeringRuntime's operator/model resume ends
      // at the same repair entry, so the tool sees the same typed refusal.
      resumeMission: async (missionId: string) => enterRepairing(store, missionId),
    }));
    const execute = tools.find((tool) => tool.name === "mission")!.execute as unknown as Execute;

    const result = await execute("tool-1", { action: "resume", missionId: mission.mission_id }, undefined, undefined, {
      cwd: ".",
    });

    const answer = result.content[0]?.text ?? "";

    assert.equal(result.details.recoveryBlocked, true);
    assert.equal(result.details.resumeCommand, `/mission resume ${mission.mission_id}`);
    assert.equal(result.details.missionId, mission.mission_id);
    assert.match(answer, new RegExp(`/mission resume ${mission.mission_id}`));
    assert.match(answer, new RegExp(`/mission cancel ${mission.mission_id}`));
  });
});
