import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { MissionAttentionReporter } from "../../src/runtime/herdr/MissionAttentionReporter.ts";

function harness() {
  const calls: Array<{ entity_type: string; entity_id: string; event_type: string; payload: Record<string, unknown> }> =
    [];
  const ingest = new ControlPlaneIngest({
    url: "http://herdr.test",
    fetch: (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  return { calls, reporter: new MissionAttentionReporter(ingest) };
}

const active = { missionId: "mission-1", title: "Implement feature", state: "executing", health: "active" };

test("HerdR receives only completed, failed, and stalled mission transitions", async () => {
  const { reporter, calls } = harness();
  for (const health of ["active", "waiting", "slow", "blocked", "active"]) {
    await reporter.update({ ...active, health });
  }
  assert.equal(calls.length, 0);
  await reporter.update({ ...active, health: "stalled" });
  await reporter.update({ ...active, state: "failed", health: "failed" });
  await reporter.update({ ...active, state: "completed", health: "complete" });
  assert.deepEqual(
    calls.map((call) => [call.entity_type, call.entity_id, call.event_type, call.payload.stage]),
    [
      ["mission", "mission-1", "mission.updated", "stalled"],
      ["mission", "mission-1", "mission.updated", "failed"],
      ["mission", "mission-1", "mission.updated", "complete"],
    ],
  );
});

test("repeated activity during a stall emits once; actual recovery rearms the next stall", async () => {
  const { reporter, calls } = harness();
  await Promise.all(Array.from({ length: 20 }, () => reporter.update({ ...active, health: "stalled" })));
  assert.equal(calls.length, 1);
  await reporter.update(active);
  assert.equal(calls.length, 1, "recovery itself stays local");
  await reporter.update({ ...active, health: "stalled" });
  assert.equal(calls.length, 2);
});

test("seeding reconnect snapshots suppresses replay while preserving later transitions", async () => {
  const { reporter, calls } = harness();
  const stalled = { ...active, health: "stalled" };
  reporter.seed(stalled);
  await reporter.update(stalled);
  reporter.seed({ ...active, missionId: "finished-before-reconnect", health: "complete", state: "completed" });
  await reporter.update({ ...active, missionId: "finished-before-reconnect", health: "complete", state: "completed" });
  assert.equal(calls.length, 0);
  await reporter.update({ ...stalled, health: "failed", state: "failed" });
  assert.equal(calls.length, 1);
});

test("terminal lifecycle state wins over stale health and cancellation stays silent", async () => {
  const { reporter, calls } = harness();
  await reporter.update({ ...active, state: "completed", health: "stalled" });
  await reporter.update({ ...active, missionId: "crashed", state: "crashed" });
  await reporter.update({ ...active, missionId: "cancelled", state: "canceled", health: "failed" });
  await reporter.update({ ...active, missionId: "paused", state: "paused", health: "stalled" });
  assert.deepEqual(
    calls.map((call) => call.payload.stage),
    ["complete", "failed"],
  );
});

test("payloads are bounded and redact secrets without forwarding raw activity", async () => {
  const { reporter, calls } = harness();
  await reporter.update({ ...active, title: `API_KEY=abcdef123456\n${"x".repeat(1_000)}`, health: "stalled" });
  const body = JSON.stringify(calls[0]);
  assert.ok(!body.includes("abcdef123456"));
  assert.ok(!String(calls[0]!.payload.title).includes("\n"));
  assert.ok(String(calls[0]!.payload.title).length <= 160);
  assert.deepEqual(Object.keys(calls[0]!.payload).sort(), ["stage", "title"]);
});

test("failed delivery remains best effort and does not retry on every local refresh", async () => {
  let attempts = 0;
  const reporter = new MissionAttentionReporter({
    emit: async () => {
      attempts++;
      throw new Error("offline");
    },
  });
  await assert.doesNotReject(reporter.update({ ...active, health: "stalled" }));
  await reporter.update({ ...active, health: "stalled" });
  assert.equal(attempts, 1);
});

test("canonical uppercase lifecycle overrides stale derived health and operator pauses", async () => {
  const { reporter, calls } = harness();
  await reporter.update({ ...active, state: "CANCELED", health: "complete" });
  await reporter.update({
    ...active,
    missionId: "paused",
    operatorPausedAt: "2026-10-20T12:00:00Z",
    health: "stalled",
  });
  await reporter.update({ ...active, missionId: "complete", state: "COMPLETE", health: "active" });
  await reporter.update({ ...active, missionId: "failed", state: "FAILED", health: "active" });
  assert.deepEqual(
    calls.map((call) => [call.entity_id, call.payload.stage]),
    [
      ["complete", "complete"],
      ["failed", "failed"],
    ],
  );
});

test("mission updates retain wire order while other missions proceed independently", async () => {
  const calls: Array<[string, unknown]> = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const reporter = new MissionAttentionReporter({
    emit: async (_entityType, missionId, _eventType, payload) => {
      calls.push([missionId, payload?.stage]);
      if (missionId === "mission-1" && payload?.stage === "stalled") await first;
      return true;
    },
  });
  const stalled = reporter.update({ ...active, health: "stalled" });
  const failed = reporter.update({ ...active, state: "FAILED", health: "failed" });
  const complete = reporter.update({ ...active, state: "COMPLETE", health: "complete" });
  const other = reporter.update({ ...active, missionId: "other", state: "COMPLETE", health: "complete" });
  try {
    assert.equal(await other, true);
    assert.deepEqual(calls, [
      ["mission-1", "stalled"],
      ["other", "complete"],
    ]);
    assert.equal(await failed, false, "bounded queue coalesces pending transitions to the newest state");
  } finally {
    releaseFirst();
  }
  assert.equal(await stalled, true);
  assert.equal(await complete, true);
  assert.deepEqual(calls, [
    ["mission-1", "stalled"],
    ["other", "complete"],
    ["mission-1", "complete"],
  ]);
});

test("recovery cancels an unsent attention transition", async () => {
  const stages: unknown[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reporter = new MissionAttentionReporter({
    emit: async (_entityType, _missionId, _eventType, payload) => {
      stages.push(payload?.stage);
      await first;
      return true;
    },
  });
  const stalled = reporter.update({ ...active, health: "stalled" });
  const failed = reporter.update({ ...active, state: "FAILED", health: "failed" });
  await reporter.update(active);
  release();
  await stalled;
  assert.equal(await failed, false);
  assert.deepEqual(stages, ["stalled"]);
});
