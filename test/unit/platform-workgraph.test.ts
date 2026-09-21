import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

describe("WorkGraph", () => {
  it("creates and transitions runs", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const run = graph.createRun({ projectId: "PRJ-1", goal: "ship" });
    assert.equal(run.status, "PENDING");
    graph.setRunStatus(run.id, "RUNNING");
    graph.setRunStatus(run.id, "COMPLETED");
    const done = graph.getRun(run.id)!;
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.finished_at);
  });

  it("records approval decisions correlated to a run", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const run = graph.createRun({ projectId: "PRJ-1", goal: "g" });
    graph.recordApproval(run.id, {
      mode: "interactive",
      decision: "approved",
      externalDecisionId: "EXT-9",
      planRef: "PLAN-1",
      approvedBy: "ops",
      reason: null,
      annotations: ["use metric units"],
      decided_at: new Date().toISOString(),
    });
    assert.equal(graph.getRun(run.id)!.approval?.externalDecisionId, "EXT-9");
  });

  it("tracks worker lifecycle with heartbeat, restart generation and cancel", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const w = graph.createWorker({
      projectId: "PRJ-1",
      role: "implementer",
      location: { host: "localhost", remote: false },
    });
    assert.equal(w.generation, 1);
    graph.setWorkerStatus(w.id, "RUNNING");
    graph.heartbeat(w.id);
    assert.ok(graph.getWorker(w.id)!.heartbeat_at);
    graph.restart(w.id);
    assert.equal(graph.getWorker(w.id)!.generation, 2);
    graph.cancel(w.id);
    assert.equal(graph.getWorker(w.id)!.status, "CANCELLED");
  });

  it("reports stale workers past the heartbeat threshold", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const w = graph.createWorker({ projectId: "PRJ-1", role: "scout" });
    graph.heartbeat(w.id);
    const stale = graph.staleWorkers(1000, Date.parse(graph.getWorker(w.id)!.heartbeat_at!) + 5000);
    assert.equal(stale.length, 1);
    const fresh = graph.staleWorkers(1000, Date.parse(graph.getWorker(w.id)!.heartbeat_at!) + 500);
    assert.equal(fresh.length, 0);
  });

  it("persists run/worker transitions as events", async () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const run = graph.createRun({ projectId: "PRJ-1", goal: "g" });
    graph.setRunStatus(run.id, "RUNNING");
    const w = graph.createWorker({ projectId: "PRJ-1", role: "implementer", runId: run.id });
    graph.heartbeat(w.id);
    await graph.flush();
    const types = store.all().map((e) => e.type);
    assert.ok(types.includes("platform.run.created"));
    assert.ok(types.includes("platform.run.status"));
    assert.ok(types.includes("platform.worker.created"));
    assert.ok(types.includes("platform.worker.heartbeat"));
  });
});
