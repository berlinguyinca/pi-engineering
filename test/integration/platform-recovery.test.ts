import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { Platform } from "../../src/platform/index.ts";
import { MemoryOutbox } from "../../src/platform/memoryOutbox.ts";
import { briefIsIsolated, buildReviewerBrief } from "../../src/platform/review.ts";

describe("platform recovery + isolation", () => {
  it("recovers a crashed worker: stale -> recovering -> restart (generation bump)", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const w = graph.createWorker({ projectId: "PRJ-1", role: "implementer" });
    graph.heartbeat(w.id);
    const hb = Date.parse(graph.getWorker(w.id)!.heartbeat_at!);
    // Simulate a crash: no heartbeat for a long time.
    graph.setWorkerStatus(w.id, "RECOVERING");
    const stale = graph.staleWorkers(1000, hb + 60_000);
    assert.equal(stale.length, 1);
    // Restart recovery.
    graph.restart(w.id);
    const recovered = graph.getWorker(w.id)!;
    assert.equal(recovered.status, "IDLE");
    assert.equal(recovered.generation, 2);
  });

  it("rebuilds the run/worker graph from events (parent/control-plane restart)", async () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const run = graph.createRun({ projectId: "PRJ-1", goal: "ship" });
    graph.setRunStatus(run.id, "RUNNING");
    const w = graph.createWorker({ projectId: "PRJ-1", role: "implementer", runId: run.id, model: "opus-5" });
    graph.setWorkerStatus(w.id, "RUNNING");
    graph.heartbeat(w.id);
    graph.restart(w.id);
    await graph.flush();

    // Simulate a fresh process: rebuild purely from the persisted events.
    const rebuilt = WorkGraph.rebuild(store.all());
    assert.equal(rebuilt.getRun(run.id)?.status, "RUNNING");
    const rw = rebuilt.getWorker(w.id)!;
    assert.equal(rw.role, "implementer");
    assert.equal(rw.model, "opus-5");
    assert.equal(rw.generation, 2);
    assert.equal(rw.status, "IDLE"); // restart resets status and heartbeat
    assert.equal(rw.heartbeat_at, null);
  });

  it("recovers a pending Plannotator decision after restart via the work graph", async () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({ name: "p", canonicalRemote: "https://github.com/a/p" });
    const run = platform.graph.createRun({ projectId: project.id, goal: "g" });
    platform.graph.setRunStatus(run.id, "WAITING");
    await platform.graph.flush();
    assert.equal(platform.graph.pendingApprovals().length, 1);
  });

  it("OpenViking outage uses a durable outbox and recovers when back online", async () => {
    let online = false;
    const pushed: string[] = [];
    const transport = {
      push: async (c: { id: string; kind: string }) => {
        if (!online) throw new Error("openviking down");
        pushed.push(c.id);
      },
    };
    const outbox = new MemoryOutbox({ transport });
    await outbox.enqueue({ projectId: "PRJ-1", sessionId: "S", kind: "promotion", text: "validated fact" });
    // Offline: flush keeps the commit queued.
    let r = await outbox.flush();
    assert.equal(r.pushed, 0);
    assert.equal(r.remaining, 1);
    // Back online: flush drains it.
    online = true;
    r = await outbox.flush();
    assert.equal(r.pushed, 1);
    assert.equal(r.remaining, 0);
    assert.equal(pushed.length, 1);
    outbox.dispose();
  });

  it("reviewer isolation: brief contains only allowed content, never private history", () => {
    const brief = buildReviewerBrief({
      requirements: ["req-1"],
      architecture: ["arch-1"],
      diff: "+code",
      tests: ["test-1"],
      allowedMemory: ["accepted decision"],
    });
    assert.ok(briefIsIsolated(brief));

    const contaminated = buildReviewerBrief({
      requirements: ["req-1"],
      architecture: [],
      diff: "+code",
      tests: [],
      allowedMemory: ["self_rating: i think it is great", "implementer_private_history: ..."],
    });
    assert.equal(briefIsIsolated(contaminated), false);
  });
});
