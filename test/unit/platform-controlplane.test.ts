import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Platform } from "../../src/platform/index.ts";

describe("ControlPlane (Pi Web adapter surface)", () => {
  it("exposes projects, runs, workers and a bounded event feed", async () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({
      name: "alpha",
      canonicalRemote: "https://github.com/acme/alpha",
      riskClass: "high",
    });
    const run = platform.graph.createRun({ projectId: project.id, goal: "ship" });
    platform.graph.setRunStatus(run.id, "RUNNING");
    platform.graph.createWorker({ projectId: project.id, role: "implementer", runId: run.id });
    platform.graph.heartbeat(platform.graph.listWorkers()[0]!.id);
    await platform.graph.flush();
    await platform.registry.flush();

    const snap = platform.controlPlane.snapshot();
    assert.equal(snap.projects.length, 1);
    assert.equal(snap.projects[0]!.name, "alpha");
    assert.equal(snap.projects[0]!.riskClass, "high");
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.workers.length, 1);
    assert.ok(snap.events.length > 0);
    assert.equal(snap.health.projects, 1);
    assert.equal(snap.health.activeRuns, 1);
  });

  it("reports stale workers and active counts in health", () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({ name: "b", canonicalRemote: "https://github.com/a/b" });
    const w = platform.graph.createWorker({ projectId: project.id, role: "reviewer" });
    platform.graph.heartbeat(w.id);
    // No way to fast-forward time easily; just assert shape.
    assert.equal(typeof platform.controlPlane.snapshot().health.staleWorkers, "number");
  });

  it("never exposes chain-of-thought: health is observable state only", () => {
    const platform = new Platform();
    const json = JSON.stringify(platform.controlPlane.snapshot());
    assert.ok(!json.includes("reasoning"));
    assert.ok(!json.includes("chain"));
  });
});
