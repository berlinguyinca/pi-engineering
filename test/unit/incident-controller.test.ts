import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { IncidentController } from "../../src/incidents/IncidentController.ts";
import type { AgentFailureIncident } from "../../src/incidents/types.ts";

function incident(overrides: Partial<AgentFailureIncident> = {}): AgentFailureIncident {
  return {
    incident_id: "inc_1",
    run_id: "run_1",
    repo: "owner/repo",
    revision: "abc123",
    worktree: "/tmp/worktree",
    agent_role: "executor",
    failure_class: "test_failure",
    exit_code: 1,
    summary: "test failed",
    artifact_refs: ["artifact://failure/log"],
    reproduction: "npm test",
    command: "npm test",
    root_cause: "AssertionError at src/lib.ts:4",
    classification: "product_defect",
    risk: "medium",
    created_at: "2026-10-24T00:00:00Z",
    ...overrides,
  };
}

test("incident-controller: appends before publishing the first failure", async () => {
  const backend = JsonlEventStore.inMemory();
  const order: string[] = [];
  const controller = new IncidentController({
    backend,
    id: () => "evt_1",
    now: () => new Date("2026-10-24T00:00:01Z"),
    publish: async () => {
      order.push(`published-after-${backend.count()}`);
    },
  });

  const decision = await controller.recordFailure(incident());

  assert.equal(decision.duplicate, false);
  assert.equal(decision.state, "persisted");
  assert.deepEqual(order, ["published-after-1"]);
  assert.equal(backend.count(), 1);
  assert.equal(backend.all()[0]?.type, "incident.detected");
});

test("incident-controller: suppresses duplicate fingerprints without republishing", async () => {
  const backend = JsonlEventStore.inMemory();
  let published = 0;
  const controller = new IncidentController({
    backend,
    id: (() => {
      let count = 0;
      return () => `evt_${++count}`;
    })(),
    publish: async () => {
      published += 1;
    },
  });

  const first = await controller.recordFailure(incident());
  const second = await controller.recordFailure(incident({ incident_id: "inc_2", run_id: "run_2" }));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId);
  assert.equal(backend.count(), 1);
  assert.equal(published, 1);
});

test("incident-controller: retains durable event when publishing fails", async () => {
  const backend = JsonlEventStore.inMemory();
  const controller = new IncidentController({
    backend,
    publish: async () => {
      throw new Error("AutoSpec unavailable");
    },
  });

  const decision = await controller.recordFailure(incident());

  assert.equal(decision.state, "publish_failed");
  assert.equal(decision.publishError, "AutoSpec unavailable");
  assert.equal(backend.count(), 1);
});

test("incident-controller: room summary is bounded and excludes raw logs", async () => {
  const controller = new IncidentController({
    backend: JsonlEventStore.inMemory(),
    publish: async (event) => {
      assert.equal(event.summary.length <= 1024, true);
      assert.equal(JSON.stringify(event).includes("raw_log"), false);
    },
  });

  await controller.recordFailure(incident());
});
