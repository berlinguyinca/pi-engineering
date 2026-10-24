import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DeploymentController } from "../../src/deploy/DeploymentController.ts";

function artifact() {
  return { version: "v1", commit: "abc123", location: "/artifacts/v1" };
}

test("deployment-controller: promotes and verifies a versioned artifact", async () => {
  const events = JsonlEventStore.inMemory();
  const calls: string[] = [];
  const controller = new DeploymentController({
    events,
    id: (() => { let n = 0; return () => `evt-${++n}`; })(),
    adapter: {
      promote: async (next, rollback) => { calls.push(`${next.version}:${rollback.version}`); },
      health: async () => ({ healthy: true, summary: "ok" }),
      rollback: async () => { throw new Error("unused"); },
    },
  });

  const result = await controller.deploy(artifact(), { version: "v0", commit: "old", location: "/artifacts/v0" });

  assert.deepEqual(result, { status: "verified", version: "v1", commit: "abc123" });
  assert.deepEqual(calls, ["v1:v0"]);
  assert.equal(events.all().at(-1)?.type, "deployment.verified");
});

test("deployment-controller: rejects deployment without a rollback target", async () => {
  const controller = new DeploymentController({
    events: JsonlEventStore.inMemory(),
    adapter: { promote: async () => {}, health: async () => ({ healthy: true, summary: "ok" }), rollback: async () => {} },
  });

  await assert.rejects(controller.deploy(artifact(), null), /rollback target/);
});

test("deployment-controller: rolls back when post-deploy health fails", async () => {
  const events = JsonlEventStore.inMemory();
  const calls: string[] = [];
  const controller = new DeploymentController({
    events,
    adapter: {
      promote: async () => { calls.push("promote"); },
      health: async () => ({ healthy: false, summary: "readiness failed" }),
      rollback: async (previous) => { calls.push(`rollback:${previous.version}`); },
    },
  });

  const result = await controller.deploy(artifact(), { version: "v0", commit: "old", location: "/artifacts/v0" });

  assert.deepEqual(result, { status: "rolled_back", version: "v1", commit: "abc123", reason: "readiness failed" });
  assert.deepEqual(calls, ["promote", "rollback:v0"]);
  assert.equal(events.all().at(-1)?.type, "deployment.rolled_back");
});

test("deployment-controller: records rollback failure and does not hide it", async () => {
  const events = JsonlEventStore.inMemory();
  const controller = new DeploymentController({
    events,
    adapter: {
      promote: async () => {},
      health: async () => ({ healthy: false, summary: "failed" }),
      rollback: async () => { throw new Error("rollback unavailable"); },
    },
  });

  const result = await controller.deploy(artifact(), { version: "v0", commit: "old", location: "/artifacts/v0" });

  assert.deepEqual(result, { status: "rollback_failed", version: "v1", commit: "abc123", reason: "rollback unavailable" });
  assert.equal(events.all().at(-1)?.type, "deployment.rollback_failed");
});
