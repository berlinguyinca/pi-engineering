import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { RecoveryPlanner } from "../../src/orchestration/recovery.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function harness(strategyMaxAttempts: number) {
  let now = Date.parse("2026-09-27T12:00:00.000Z");
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "capped mission",
    goal: "finish",
    user_request: "finish",
    repository: "/repo",
    base_ref: "main",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(mission.mission_id, status);
  }
  const task = store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "runnable work",
    repo_id: "repo-1",
  });
  store.transitionTask(task.task_id, "READY");
  const supervisor = new MissionSupervisor({
    store,
    now: () => now,
    recoveryPlanner: new RecoveryPlanner({ missionCeiling: 1_000, strategyMaxAttempts }),
  });
  return {
    backend,
    store,
    missionId: mission.mission_id,
    supervisor,
    advance(ms: number) {
      now += ms;
    },
  };
}

/** One automatic attempt that ran and did not restore progress. */
function failOpenAttempts(store: MissionStore, missionId: string): void {
  for (const decision of store.listRecoveryDecisions(missionId)) {
    if (decision.status === "planned" || decision.status === "started")
      store.transitionRecovery(decision.recoveryId, "failed");
  }
}

describe("recovery cap enforcement", () => {
  it("stops after the cap for a capacity-category failure and adds no further attempts or events", async () => {
    const h = harness(2);
    for (let round = 0; round < 2; round++) {
      await h.supervisor.tick();
      failOpenAttempts(h.store, h.missionId);
      h.advance(60_000);
    }
    const [stopped] = await h.supervisor.tick();
    assert.equal(stopped?.action, "STOP");
    assert.equal(h.store.listMissionStops(h.missionId).length, 1);
    const decisions = h.store.listRecoveryDecisions(h.missionId).length;
    assert.equal(decisions, 3, "two attempts plus the exhausted STOP decision");

    await h.store.flush();
    const events = h.backend.count();
    for (let tick = 0; tick < 25; tick++) {
      h.advance(60_000);
      const [status] = await h.supervisor.tick();
      assert.equal(status?.action, "STOP");
    }
    await h.store.flush();
    assert.equal(h.store.listRecoveryDecisions(h.missionId).length, decisions, "no new decisions after exhaustion");
    assert.equal(h.backend.count(), events, "no new events after exhaustion");
    assert.ok(
      h.store.listRecoveryDecisions(h.missionId).every((decision) => decision.attempt <= 3),
      "the attempt counter never runs past the cap",
    );
  });

  it("gives an operator resume a fresh budget", async () => {
    const h = harness(1);
    await h.supervisor.tick();
    failOpenAttempts(h.store, h.missionId);
    const [stopped] = await h.supervisor.tick();
    assert.equal(stopped?.action, "STOP");

    h.store.resumeMission(h.missionId, "operator requested mission recovery");
    h.advance(60_000);
    const [resumed] = await h.supervisor.tick();
    assert.notEqual(resumed?.action, "STOP");
    assert.equal(resumed?.decision?.attempt, 1);
  });
});
