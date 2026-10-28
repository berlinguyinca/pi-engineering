import assert from "node:assert/strict";
import { test } from "node:test";

import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import type { Mission, MissionStatus } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

/**
 * Esc pauses the turn the operator is watching. Dozens of missions run at once,
 * so the mission worth stopping is rarely the one on screen: `/mission pause
 * <id>` names it. These tests pin what naming a mission means — it stops, it
 * keeps its work, and nothing picks it up again until the operator says so.
 */

function harness() {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const orchestrator = new Orchestrator({ store, backends: {}, planner: async () => [] });
  return { store, orchestrator };
}

function missionIn(store: MissionStore, missionId: string, ...through: MissionStatus[]): Mission {
  const created = store.createMission({
    mission_id: missionId,
    title: missionId,
    goal: "pause semantics",
    user_request: "pause semantics",
    repository: ".",
    base_ref: "HEAD",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  return through.reduce((mission, status) => store.transitionMission(mission.mission_id, status), created);
}

/** A mission that has work queued: pausing it must park it, not lose it. */
test("a named mission that is queued is parked with a resume condition", async () => {
  const { store, orchestrator } = harness();
  const queued = missionIn(store, "MSN-pause-queued", "CLASSIFYING", "READY", "QUEUED");

  const paused = await orchestrator.pauseMission(queued.mission_id);

  assert.equal(paused.status, "PAUSED_INFRASTRUCTURE", "it stopped, and it is a resumable park");
  assert.ok(store.getMission(queued.mission_id)?.operator_paused_at, "the pause is durable");
  const stop = store.listMissionStops(queued.mission_id).at(-1);
  assert.match(stop?.resumeCondition ?? "", /\/mission resume/, "the way back is recorded with the stop");
});

/**
 * The interrupted-run path cancels a mission that was paused before anything
 * dispatched, because an Esc during planning preserves nothing. A *named* pause
 * must not do that: the operator asked to stop the mission, not to destroy it.
 */
test("a mission that has not dispatched is paused, not canceled", async () => {
  const { store, orchestrator } = harness();
  const planned = missionIn(store, "MSN-pause-new");

  const paused = await orchestrator.pauseMission(planned.mission_id);

  assert.equal(paused.status, "NEW", "nothing was dispatched, so nothing had to be parked");
  assert.notEqual(paused.status, "CANCELED", "a pause is not a cancel");
  assert.ok(store.getMission(planned.mission_id)?.operator_paused_at, "the pause is durable");
});

/** The pause has to survive the process: the supervisor reads the store. */
test("the supervisor will not resume a mission the operator paused", async () => {
  const { store, orchestrator } = harness();
  const queued = missionIn(store, "MSN-pause-supervisor", "CLASSIFYING", "READY", "QUEUED");
  await orchestrator.pauseMission(queued.mission_id);

  const supervisor = new MissionSupervisor({ store });
  const statuses = await supervisor.tick();

  const noted = statuses.find((entry) => entry.missionId === queued.mission_id);
  assert.ok(noted, "the paused mission is still watched");
  assert.match(noted.reason, /Paused by the operator/, "and it is watched without being touched");
  assert.equal(store.getMission(queued.mission_id)?.status, "PAUSED_INFRASTRUCTURE", "the tick did not move it");
});

test("a live run is stopped by the named pause", async () => {
  const { store, orchestrator } = harness();
  const queued = missionIn(store, "MSN-pause-live", "CLASSIFYING", "READY", "QUEUED", "STARTING");
  const controller = new AbortController();
  // Stand in for a dispatched pipeline: the orchestrator's pause path parks the
  // mission when the signal carries the pause reason.
  (orchestrator as unknown as { liveRuns: Map<string, AbortController> }).liveRuns.set(queued.mission_id, controller);

  await orchestrator.pauseMission(queued.mission_id);

  assert.equal(controller.signal.aborted, true, "the running pipeline was signalled");
  assert.ok(store.getMission(queued.mission_id)?.operator_paused_at, "the pause is recorded before the abort");
});

test("a terminal mission is not rewritten and an unknown one is refused", async () => {
  const { store, orchestrator } = harness();
  const canceled = missionIn(store, "MSN-pause-terminal", "CLASSIFYING", "CANCELED");

  assert.equal((await orchestrator.pauseMission(canceled.mission_id)).status, "CANCELED", "idempotent");
  assert.ok(!store.getMission(canceled.mission_id)?.operator_paused_at, "a finished mission is not marked paused");
  await assert.rejects(() => orchestrator.pauseMission("MSN-does-not-exist"), /unknown mission/);
});
