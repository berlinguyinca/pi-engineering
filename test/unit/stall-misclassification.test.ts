/**
 * Regression tests for live-worker stall misclassification.
 *
 * A worker actively running tools emits raw activity (WORKER_ACTIVITY /
 * WORKER_HEARTBEAT) whose meaningfulProgress is false by design (see
 * src/workers/activity.ts). That raw activity keeps lastHeartbeatAt fresh but
 * leaves lastMeaningfulProgressAt stale. Such a worker must be SLOW, never
 * STALLED — and the supervisor must not fence it on a single stale projection
 * tick. A genuinely dead worker (stale raw activity too) is still recovered,
 * one tick later.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import type { HealthInput } from "../../src/orchestration/observability/health.ts";
import { deriveHealth } from "../../src/orchestration/observability/health.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const STALL_MS = 300_000;
const SLOW_MS = 120_000;

function baseInput(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    missionStatus: "EXECUTING",
    blocked: false,
    failed: false,
    complete: false,
    verifiedComplete: false,
    alive: true,
    slowAfterMs: SLOW_MS,
    stallAfterMs: STALL_MS,
    ...overrides,
  };
}

test("deriveHealth: recent raw activity + stale meaningful progress => slow, never stalled", () => {
  // Meaningful progress stopped >5min ago, but raw activity (lastHeartbeatAt)
  // is fresh: the worker is alive and doing things — at most SLOW.
  const result = deriveHealth(
    baseInput({
      now: "2024-01-01T00:06:00Z",
      lastHeartbeatAt: "2024-01-01T00:05:50Z",
      lastMeaningfulProgressAt: "2024-01-01T00:00:00Z",
    }),
  );
  assert.equal(result.health, "slow");
});

test("deriveHealth: stale meaningful progress AND stale heartbeat => stalled", () => {
  // Both meaningful progress and raw activity are older than the stall
  // threshold: genuinely dead worker, so STALLED.
  const result = deriveHealth(
    baseInput({
      now: "2024-01-01T00:06:00Z",
      lastHeartbeatAt: "2024-01-01T00:00:30Z",
      lastMeaningfulProgressAt: "2024-01-01T00:00:00Z",
    }),
  );
  assert.equal(result.health, "stalled");
});

function supervisorHarness(initialNow = Date.parse("2026-09-27T12:00:00.000Z")) {
  let currentNow = initialNow;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "stall debounce mission",
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
  const observability = new MissionObservability({
    backend,
    store,
    now: () => new Date(currentNow).toISOString(),
    config: { slowAfterMs: SLOW_MS, stallAfterMs: STALL_MS },
  });
  observability.missionCreated(mission.mission_id, mission.title);
  const supervisor = new MissionSupervisor({ store, observability, now: () => currentNow });
  return {
    store,
    mission,
    observability,
    supervisor,
    setNow(value: number) {
      currentNow = value;
    },
  };
}

test("supervisor: single stale tick is not classified, two consecutive ticks are", async () => {
  const h = supervisorHarness();
  // A worker starts (meaningful progress at T0) and then goes silent — no raw
  // activity for >5min, so the observability projection is genuinely STALLED.
  h.observability.workerStarted(h.mission.mission_id, "W1");

  const t0 = Date.parse("2026-09-27T12:00:00.000Z");
  h.setNow(t0 + STALL_MS + 60_000);

  // Tick 1: single stale projection — debounced, no ORPHANED_EXECUTION.
  const [first] = await h.supervisor.tick();
  assert.equal(first?.health, "HEALTHY");
  const classificationsAfterFirst = h.store.listFailureClassifications(h.mission.mission_id);
  assert.equal(
    classificationsAfterFirst.some((c) => c.category === "ORPHANED_EXECUTION"),
    false,
    "a single stale tick must not classify ORPHANED_EXECUTION",
  );

  // Tick 2: projection persists — now classified and recovered.
  const [second] = await h.supervisor.tick();
  assert.equal(second?.health, "STALLED");
  const classificationsAfterSecond = h.store.listFailureClassifications(h.mission.mission_id);
  assert.equal(
    classificationsAfterSecond.some((c) => c.category === "ORPHANED_EXECUTION"),
    true,
    "two consecutive stale ticks must classify ORPHANED_EXECUTION",
  );
});

test("supervisor: fresh raw activity keeps a stale-progress worker unclassified", async () => {
  const h = supervisorHarness();
  h.observability.workerStarted(h.mission.mission_id, "W1");

  const t0 = Date.parse("2026-09-27T12:00:00.000Z");
  // Worker keeps emitting raw (meaningfulProgress:false) tool activity.
  h.observability.activity(h.mission.mission_id, {
    type: "tool_invocation",
    summary: "running a long build",
    workerId: "W1",
    meaningfulProgress: false,
  });
  h.setNow(t0 + STALL_MS + 60_000);

  const [first] = await h.supervisor.tick();
  // Recent raw activity => observability health is SLOW, so no STALLED branch.
  assert.equal(first?.health, "HEALTHY");
  const classifications = h.store.listFailureClassifications(h.mission.mission_id);
  assert.equal(
    classifications.some((c) => c.category === "ORPHANED_EXECUTION"),
    false,
    "a live worker with recent raw activity must never be fenced",
  );
});
