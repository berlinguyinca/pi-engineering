import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { DispatchAuthority } from "../../src/orchestration/ownership.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

/**
 * #95 — a task loses dispatch authority mid-run (fencing or ownership taken by
 * another holder). The task is left non-terminal on purpose: orphan-recovery on
 * the NEW holder must re-run the same task. But that leaves the mission parked
 * in whatever `WAITING_*` state the resilience window put it in, and the
 * orchestrator used to carry on finalizing it anyway — `postExecution` then tried
 * `WAITING_FOR_LLM -> INTEGRATING`, an illegal transition that threw out of
 * `finalizeMission`.
 *
 * A process that no longer holds authority does not get to finalize the mission.
 * It reports the loss and makes no mission transitions at all — un-parking a
 * mission another owner holds would be the same bug pointed the other way.
 */

function missionIn(store: MissionStore, status: string) {
  const mission = store.createMission({
    title: "authority loss",
    goal: "authority loss",
    user_request: "authority loss",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  for (const next of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"]) {
    store.transitionMission(mission.mission_id, next as never);
  }
  return status === "EXECUTING" ? mission : store.transitionMission(mission.mission_id, status as never);
}

function taskIn(store: MissionStore, missionId: string) {
  return store.createTask({ mission_id: missionId, kind: "agent", role: "implementer", objective: "do the work" });
}

/** An authority that has already been fenced: every assertion of it throws. */
function fencedAuthority(missionId: string): DispatchAuthority {
  const identity = {
    missionId,
    ownerId: "other-holder",
    generation: 1,
    fencingToken: 1,
    acquiredAt: new Date().toISOString(),
    renewBy: new Date().toISOString(),
  };
  return {
    missionIdentity: identity,
    assertAuthoritative: () => {
      throw new Error(`stale mission lease for ${missionId}: token=1 current=2`);
    },
    onInvalidated: () => {},
    close: async () => undefined,
  };
}

/** An authority that is still ours: assertions pass. */
function liveAuthority(missionId: string): DispatchAuthority {
  const identity = {
    missionId,
    ownerId: "this-holder",
    generation: 1,
    fencingToken: 1,
    acquiredAt: new Date().toISOString(),
    renewBy: new Date().toISOString(),
  };
  return {
    missionIdentity: identity,
    assertAuthoritative: () => {},
    onInvalidated: () => {},
    close: async () => undefined,
  };
}

/** A wall clock the test drives, so retry backoff never sleeps for real. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function clockOptions() {
  const clk = clock();
  return { now: clk.now, sleep: clk.sleep };
}

function brokerFailing(message: string): ExecutionBroker {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  return new ExecutionBroker({
    store,
    backends: {
      agent: {
        runAgent: async () => {
          throw new Error(message);
        },
      },
    } as never,
  });
}

describe("dispatch authority lost mid-run (#95)", () => {
  it("marks the mission's authority lost instead of settling the task", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    // The resilience window parked the mission here before this attempt started.
    const mission = missionIn(store, "WAITING_FOR_LLM");
    const task = taskIn(store, mission.mission_id);
    const scheduler = new MissionScheduler({
      store,
      broker: brokerFailing("provider exploded"),
      acquireAuthority: async () => fencedAuthority(mission.mission_id),
      ...clockOptions(),
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(scheduler.authorityLostFor(mission.mission_id), true, "the loss is reportable");
    assert.equal(
      store.getMission(mission.mission_id)?.status,
      "WAITING_FOR_LLM",
      "a fenced process leaves the park exactly as it found it",
    );
    const settled = store.getTask(task.task_id)?.status;
    assert.ok(
      settled === "READY" || settled === "RETRYING" || settled === "RUNNING",
      `the task stays non-terminal so the new holder can re-run it, got ${settled}`,
    );
  });

  it("does not record a terminal failure for a task whose authority was lost", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = missionIn(store, "WAITING_FOR_LLM");
    const task = taskIn(store, mission.mission_id);
    const scheduler = new MissionScheduler({
      store,
      broker: brokerFailing("provider exploded"),
      acquireAuthority: async () => fencedAuthority(mission.mission_id),
      ...clockOptions(),
    });

    await scheduler.runMission(mission.mission_id);

    assert.ok(
      !["FAILED", "SUCCEEDED", "CANCELED", "BLOCKED", "SKIPPED"].includes(store.getTask(task.task_id)?.status ?? ""),
      `no terminal failure is recorded for a task this process cannot settle, got ${store.getTask(task.task_id)?.status}`,
    );
    assert.ok(
      store.listExecutions().every((execution) => execution.status !== "FAILED"),
      "nothing is settled as a failure by a process that cannot settle it",
    );
  });

  it("leaves the flag clear when authority was held throughout", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = missionIn(store, "EXECUTING");
    const task = taskIn(store, mission.mission_id);
    const scheduler = new MissionScheduler({
      store,
      broker: brokerFailing("provider exploded"),
      acquireAuthority: async () => liveAuthority(mission.mission_id),
      ...clockOptions(),
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(scheduler.authorityLostFor(mission.mission_id), false);
    assert.equal(store.getTask(task.task_id)?.status, "FAILED", "an owned run still settles its own failures");
  });
});
