import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { Platform } from "../../src/platform/index.ts";

const CONCURRENT = 50;

describe(`load: ${CONCURRENT} concurrent workers`, () => {
  it("creates and runs 50 workers concurrently with events, heartbeats and recall", async () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({ name: "load", canonicalRemote: "https://github.com/a/load" });
    const run = platform.graph.createRun({ projectId: project.id, goal: "load test" });
    platform.graph.setRunStatus(run.id, "RUNNING");

    const started = Date.now();
    const work = Array.from({ length: CONCURRENT }, (_, i) => {
      const w = platform.graph.createWorker({
        projectId: project.id,
        runId: run.id,
        role: i % 2 === 0 ? "implementer" : "reviewer",
      });
      return (async () => {
        platform.graph.setWorkerStatus(w.id, "RUNNING");
        // Simulate a worker doing work: a few heartbeats then completion.
        platform.graph.heartbeat(w.id);
        await new Promise((r) => setTimeout(r, 1));
        platform.graph.heartbeat(w.id);
        return w.id;
      })();
    });

    const ids = await Promise.all(work);
    const elapsed = Date.now() - started;
    assert.equal(ids.length, CONCURRENT);

    for (const id of ids) platform.graph.complete(id);
    platform.graph.setRunStatus(run.id, "COMPLETED");
    await platform.graph.flush();
    await platform.registry.flush();

    // The persisted graph holds all 50 workers.
    assert.equal(platform.graph.listWorkers(project.id).length, CONCURRENT);
    assert.equal(platform.graph.listWorkers(project.id, run.id).length, CONCURRENT);

    // Event feed recorded every creation + heartbeat.
    const created = platform.store.all().filter((e) => e.type === "platform.worker.created");
    const heartbeats = platform.store.all().filter((e) => e.type === "platform.worker.heartbeat");
    assert.equal(created.length, CONCURRENT);
    assert.ok(heartbeats.length >= CONCURRENT, `expected >= ${CONCURRENT} heartbeats, got ${heartbeats.length}`);

    // Control-plane snapshot exposes all workers and run state.
    const snap = platform.controlPlane.snapshot();
    assert.equal(snap.workers.length, CONCURRENT);
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.health.activeWorkers, 0); // all completed
    assert.equal(snap.health.activeRuns, 0); // run completed
    assert.ok(elapsed < 30_000, `load test too slow: ${elapsed}ms`);
  });

  it("reconstructs all 50 workers from events after a restart", async () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({ name: "load2", canonicalRemote: "https://github.com/a/load2" });
    const run = platform.graph.createRun({ projectId: project.id, goal: "g" });
    const workers = Array.from({ length: CONCURRENT }, () => {
      const w = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "scout" });
      platform.graph.heartbeat(w.id);
      return w.id;
    });
    await platform.graph.flush();

    const rebuilt = WorkGraph.rebuild(platform.store.all());
    assert.equal(rebuilt.listWorkers(project.id).length, CONCURRENT);
    assert.ok(rebuilt.getRun(run.id));
  });
});
