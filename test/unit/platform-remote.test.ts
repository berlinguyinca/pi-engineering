import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemoteWorkerClient, type WorkerChannel, type WorkerCommandEnvelope } from "../../src/platform/RemoteWorker.ts";
import { WorkGraph } from "../../src/platform/WorkGraph.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

function makeChannel(host: string, log: WorkerCommandEnvelope[]): WorkerChannel {
  return {
    host,
    send: async (envelope) => {
      log.push(envelope);
      return { workerId: envelope.workerId, generation: envelope.generation, ok: true, ack: "ack" };
    },
    close: () => {},
  };
}

describe("RemoteWorkerClient (spec 12)", () => {
  it("attaches a remote channel outbound and marks the worker running", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 10_000 });
    const w = graph.createWorker({ projectId: "PRJ-1", role: "implementer", location: { host: "h1", remote: true } });
    client.attach(w.id, makeChannel("h1", []));
    assert.equal(client.isAttached(w.id), true);
    assert.equal(graph.getWorker(w.id)!.status, "RUNNING");
    client.dispose();
  });

  it("dispatches idempotent commands keyed on generation", async () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000 });
    const w = graph.createWorker({ projectId: "PRJ-1", role: "implementer" });
    const log: WorkerCommandEnvelope[] = [];
    client.attach(w.id, makeChannel("h1", log));
    await client.dispatch(w.id, { kind: "run_task", taskRef: "T1" });
    // Restart bumps generation; a stale command would be ignored by the worker.
    graph.restart(w.id);
    const after = graph.getWorker(w.id)!;
    assert.equal(after.generation, 2);
    assert.equal(log[0]?.generation, 1);
    client.dispose();
  });

  it("recovers from disconnect: marks RECOVERING, then reconnects preserving generation", () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000 });
    const w = graph.createWorker({ projectId: "PRJ-1", role: "implementer" });
    let onDisconnect: ((r: string) => void) | undefined;
    const channel: WorkerChannel = {
      host: "h1",
      send: async (e) => ({ workerId: e.workerId, generation: e.generation, ok: true, ack: "a" }),
      close: () => {},
    };
    Object.defineProperty(channel, "onDisconnect", {
      set(v) {
        onDisconnect = v;
      },
      get() {
        return onDisconnect;
      },
    });
    client.attach(w.id, channel);
    assert.equal(client.isAttached(w.id), true);
    onDisconnect?.("network");
    assert.equal(client.isAttached(w.id), false);
    assert.equal(graph.getWorker(w.id)!.status, "RECOVERING");
    const genBefore = graph.getWorker(w.id)!.generation;
    client.reconnect(w.id, makeChannel("h1", []));
    assert.equal(graph.getWorker(w.id)!.generation, genBefore);
    assert.equal(graph.getWorker(w.id)!.status, "RUNNING");
    client.dispose();
  });

  it("dispatch with no channel reports failure (not a throw)", async () => {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const client = new RemoteWorkerClient({ graph });
    const w = graph.createWorker({ projectId: "PRJ-1", role: "scout" });
    const res = await client.dispatch(w.id, { kind: "heartbeat" });
    assert.equal(res.ok, false);
    assert.equal(res.ack, "no channel");
  });
});
