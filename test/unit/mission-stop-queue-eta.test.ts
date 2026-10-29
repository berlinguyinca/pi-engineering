import assert from "node:assert/strict";
import { test } from "node:test";

import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import {
  QUEUE_OBSERVATION_MAX_AGE_MS,
  QueueObservations,
  queueEtaText,
  queueLoadText,
} from "../../src/gateway/queueObservation.ts";
import type { GatewayWaitSignal } from "../../src/gateway/signals.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { missionReportLines } from "../../src/tools/missionReport.ts";

/**
 * #418 — a mission parked on gateway capacity tells the operator only that it
 * "waits for capacity". The gateway already reports the queue: how many are
 * queued, the limit, and `retry_after_ms`. That live state was visible only
 * DURING an active wait (the admission notice) and was never persisted, so a
 * mission parked for hours read as open-ended.
 *
 * The queue state is now captured at park time onto the `MissionStop` and shown
 * in the operator report: "31 of 100 queued · ETA ~2m".
 */

function wait(over: Partial<GatewayWaitSignal> = {}): GatewayWaitSignal {
  return {
    retryAfterMs: 90_000,
    retryable: true,
    source: "body",
    reason: "queue_timeout",
    type: "inference_admission",
    queued: 31,
    queueLimit: 100,
    activeLimit: 4,
    ...over,
  };
}

function parkedMission(store: MissionStore, status = "PAUSED_INFRASTRUCTURE") {
  const mission = store.createMission({
    title: "capacity park",
    goal: "capacity park",
    user_request: "capacity park",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  for (const next of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"]) {
    store.transitionMission(mission.mission_id, next as never);
  }
  return store.transitionMission(mission.mission_id, status as never);
}

/** Only a capacity-shaped wait is queue state; a link blip is not. */
test("queue state is captured from a capacity wait, not from a link blip", () => {
  const observations = new QueueObservations();

  observations.record(wait(), () => 1_000);
  observations.record(
    wait({
      reason: "connection_error",
      type: "transport",
      queued: undefined,
      queueLimit: undefined,
      activeLimit: undefined,
    }),
    () => 2_000,
  );

  const latest = observations.latest();
  assert.equal(latest?.queued, 31, "the last genuine queue report wins");
  assert.equal(latest?.observedAtMs, 1_000);
});

/** The load reads the way the live notice reads it. */
test("the queue load is phrased like the live admission notice", () => {
  const observations = new QueueObservations();
  observations.record(wait(), () => 1_000);

  assert.equal(queueLoadText(observations.latest()!), "31 of 100 queued · 4 admitted");
});

/** The ETA comes from the gateway's own retry-after, not from a guess. */
test("the ETA is the gateway's retry-after", () => {
  const observations = new QueueObservations();
  observations.record(wait({ retryAfterMs: 125_000 }), () => 1_000);

  assert.equal(queueEtaText(observations.latest()!, 1_000), "ETA ~2m 05s");
});

/** An ETA that has aged out is not an ETA — it would be a lie about the future. */
test("an aged-out retry-after reports no ETA", () => {
  const observations = new QueueObservations();
  observations.record(wait({ retryAfterMs: 90_000 }), () => 0);

  assert.equal(queueEtaText(observations.latest()!, 0), "ETA ~1m 30s");
  assert.equal(queueEtaText(observations.latest()!, 10 * 60_000), null);
});

/** An observation older than the horizon is not attached to a park. */
test("a stale observation is not treated as current queue state", () => {
  const observations = new QueueObservations();
  observations.record(wait(), () => 0);

  assert.ok(observations.fresh(QUEUE_OBSERVATION_MAX_AGE_MS, () => 60_000));
  assert.equal(
    observations.fresh(QUEUE_OBSERVATION_MAX_AGE_MS, () => QUEUE_OBSERVATION_MAX_AGE_MS + 60_000),
    null,
  );
});

/** The queue state is durable: it survives a reopen of the store. */
test("the queue state persists on the stop record", async () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = parkedMission(store);

  store.stopMission(mission.mission_id, {
    reason: "provider queue is saturated",
    preservedWork: [],
    attemptedRecoveries: [],
    resumeCondition: "a healthy provider probe must succeed",
    queue: { observedAtMs: 1_000, queued: 31, queueLimit: 100, activeLimit: 4, retryAfterMs: 90_000 },
  });
  await store.flush();

  const reopened = MissionStore.open(backend);
  const stop = reopened.listMissionStops(mission.mission_id).at(-1);
  assert.equal(stop?.queue?.queued, 31, "the queue load is durable, not just live");
  assert.equal(stop?.queue?.queueLimit, 100);
  assert.equal(stop?.queue?.retryAfterMs, 90_000);
});

/** The operator report shows the load and the ETA, not an open-ended wait. */
test("the report shows queue load and ETA for a capacity-parked mission", () => {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = parkedMission(store);
  const now = Date.now();

  store.stopMission(mission.mission_id, {
    reason: "provider queue is saturated",
    preservedWork: [],
    attemptedRecoveries: [],
    resumeCondition: "a healthy provider probe must succeed",
    queue: { observedAtMs: now - 5_000, queued: 31, queueLimit: 100, activeLimit: 4, retryAfterMs: 90_000 },
  });

  const lines = missionReportLines(store, mission.mission_id).join("\n");
  assert.match(lines, /Queue: 31 of 100 queued · 4 admitted/, "the operator sees how loaded the queue is");
  // The retry-after was read 5s ago, so the ETA counts that down.
  assert.match(lines, /ETA ~1m 25s/, "and roughly how long it will be");
});

/** A stop with no queue state reports no queue line — nothing is invented. */
test("a stop without queue state invents nothing", () => {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = parkedMission(store);

  store.stopMission(mission.mission_id, {
    reason: "recovery budget exhausted",
    preservedWork: [],
    attemptedRecoveries: [],
    resumeCondition: "new candidate evidence is required",
  });

  const lines = missionReportLines(store, mission.mission_id).join("\n");
  assert.doesNotMatch(lines, /Queue:/);
  assert.doesNotMatch(lines, /ETA/);
});

/**
 * The capture point is the controller that actually honoured the wait, so no
 * feature has to remember to record it. A park reads it back later.
 */
test("the admission controller keeps the queue state from the wait it honoured", async () => {
  let clock = 1_000;
  const controller = new AdmissionController({ maxConcurrency: 2, now: () => clock });

  await controller.noteCallerWaitAndSleep(wait(), { signal: AbortSignal.abort() });

  const state = controller.queueState();
  assert.equal(state?.queued, 31, "the queue depth survives the wait");
  assert.equal(state?.queueLimit, 100);
  assert.equal(state?.retryAfterMs, 90_000);

  clock += QUEUE_OBSERVATION_MAX_AGE_MS + 1;
  assert.equal(controller.queueState(), null, "an aged-out queue report is not presented as current");
});

/** A transport blip honoured by the same controller is not queue state. */
test("a transport blip does not masquerade as queue state", () => {
  const controller = new AdmissionController({ maxConcurrency: 2, now: () => 1_000 });

  controller.noteWait(
    wait({
      reason: "connection_error",
      type: "transport",
      queued: undefined,
      queueLimit: undefined,
      activeLimit: undefined,
    }),
  );

  assert.equal(controller.queueState(), null, "nothing is shown that the gateway never reported");
});
