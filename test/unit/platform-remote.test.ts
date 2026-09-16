import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ACK_LENGTH,
  RemoteWorkerClient,
  type WorkerChannel,
  type WorkerCommandEnvelope,
} from "../../src/platform/RemoteWorker.ts";
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

describe("RemoteWorkerClient boundaries (found by a fresh-context review)", () => {
  function graphWithWorker() {
    const store = JsonlEventStore.inMemory();
    const graph = WorkGraph.create(store);
    const worker = graph.createWorker({ projectId: "PRJ-1", role: "implementer" });
    return { graph, worker };
  }

  it("a remote that never answers becomes a failed command, not an eternal wait", async () => {
    // `dispatch` returned `channel.send(envelope)` bare, so a hung remote never
    // settled — and because the heartbeat also dispatches, one hung worker
    // accumulated a never-settling promise per interval, forever.
    const { graph, worker } = graphWithWorker();
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000, commandTimeoutMs: 20 });
    client.attach(worker.id, { host: "h", send: () => new Promise<never>(() => {}), close: () => {} });
    const result = await client.dispatch(worker.id, { kind: "heartbeat" });
    assert.equal(result.ok, false);
    assert.match(result.ack, /did not answer/);
    assert.equal(graph.getWorker(worker.id)?.status, "RECOVERING", "and supervision can see it");
    client.dispose();
  });

  it("a hostile response cannot claim success for another worker", async () => {
    const { graph, worker } = graphWithWorker();
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000 });
    client.attach(worker.id, {
      host: "h",
      send: async () => ({ workerId: "SOMEONE-ELSE", generation: 999, ok: "yes", ack: "x" }) as never,
      close: () => {},
    });
    const result = await client.dispatch(worker.id, { kind: "heartbeat" });
    assert.equal(result.ok, false, "a mismatched worker id is not a success");
    assert.equal(result.workerId, worker.id, "and the result is attributed to the worker we asked");
    client.dispose();
  });

  it("a non-boolean ok is rejected rather than being truthy", async () => {
    const { graph, worker } = graphWithWorker();
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000 });
    client.attach(worker.id, {
      host: "h",
      send: async () => ({ workerId: worker.id, generation: 1, ok: "yes", ack: "x" }) as never,
      close: () => {},
    });
    const result = await client.dispatch(worker.id, { kind: "heartbeat" });
    assert.equal(result.ok, false, '"yes" is truthy, which is exactly the problem');
    client.dispose();
  });

  it("an oversized acknowledgement is truncated", async () => {
    const { graph, worker } = graphWithWorker();
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000 });
    client.attach(worker.id, {
      host: "h",
      send: async () => ({ workerId: worker.id, generation: 1, ok: true, ack: "x".repeat(50_000_000) }),
      close: () => {},
    });
    const result = await client.dispatch(worker.id, { kind: "heartbeat" });
    assert.ok(result.ack.length <= MAX_ACK_LENGTH, "a remote does not decide how much memory we hold");
    client.dispose();
  });

  it("liveness comes from the remote's answer, not from our own timer", async () => {
    // `startHeartbeat` called `graph.heartbeat(workerId)` locally BEFORE and
    // independently of the remote's reply, so a worker that answered nothing
    // still looked fresh and `staleWorkers` could never report a hung remote.
    const { graph, worker } = graphWithWorker();
    const client = new RemoteWorkerClient({ graph, heartbeatMs: 60_000, commandTimeoutMs: 20 });
    client.attach(worker.id, { host: "h", send: () => new Promise<never>(() => {}), close: () => {} });
    await client.dispatch(worker.id, { kind: "heartbeat" });
    assert.equal(graph.getWorker(worker.id)?.heartbeat_at, null, "a silent remote records no heartbeat");
    client.dispose();
  });
});
