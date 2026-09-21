import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EventStore } from "../../src/ledger/EventStore.ts";
import { LedgerEventStoreBackend } from "../../src/platform/eventstore/adapters.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const evt = (i: number) => ({
  event_id: `evt-${i}`,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "platform.run.status",
  project_id: "PRJ-1",
  run_id: "RUN-1",
  worker_id: null,
  payload: { i },
});

describe("EventStore backends", () => {
  it("JsonlEventStore in-memory appends and replays in order", async () => {
    const store = JsonlEventStore.inMemory();
    await store.append(evt(1));
    await store.appendAll([evt(2), evt(3)]);
    assert.equal(store.count(), 3);
    assert.deepEqual(
      store.all().map((e) => e.event_id),
      ["evt-1", "evt-2", "evt-3"],
    );
    assert.equal(store.get("evt-2")?.payload.i, 2);
  });

  it("JsonlEventStore persists to disk and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-"));
    const file = join(dir, "events.jsonl");
    const s1 = await JsonlEventStore.open(file);
    await s1.append(evt(1));
    await s1.append(evt(2));
    const raw = await readFile(file, "utf-8");
    assert.equal(raw.split("\n").filter(Boolean).length, 2);

    // Released before reopening: the backend is single-instance on purpose, so
    // a restart closes the old handle rather than running two views of one file.
    s1.close();
    const s2 = await JsonlEventStore.open(file);
    assert.equal(s2.count(), 2);
    assert.equal(s2.all()[1]?.event_id, "evt-2");
    s2.close();
  });

  it("refuses a second instance over one file rather than diverging silently", async () => {
    // Two instances each held their own array and never re-read, so each
    // reported a silently partial history — and every consumer built on `all()`
    // (the control plane's feed, a rebuild, a health rollup) inherited it.
    const dir = await mkdtemp(join(tmpdir(), "pie-store-dup-"));
    const file = join(dir, "events.jsonl");
    const first = await JsonlEventStore.open(file);
    await assert.rejects(() => JsonlEventStore.open(file), /already open/);
    first.close();
    const second = await JsonlEventStore.open(file);
    assert.equal(second.count(), 0);
    second.close();
  });

  it("repairs a torn final record instead of swallowing the next event", async () => {
    // A process killed mid-write leaves a partial line with no newline. The
    // next append fused onto it, so the FOLLOWING event — whose `append()` had
    // resolved, and which was therefore committed by this store's own contract
    // — silently vanished on the restart after that.
    const dir = await mkdtemp(join(tmpdir(), "pie-store-torn-"));
    const file = join(dir, "events.jsonl");
    const first = await JsonlEventStore.open(file);
    await first.append(evt(1));
    first.close();
    // Simulate the kill: a complete record, then a fragment with no newline.
    await appendFile(file, '{"event_id":"evt-torn","timestamp":"2026-09', "utf-8");

    const second = await JsonlEventStore.open(file);
    assert.equal(second.count(), 1, "the complete record survives");
    await second.append(evt(4));
    second.close();

    const third = await JsonlEventStore.open(file);
    assert.equal(third.count(), 2, "and the event appended afterwards is still there");
    assert.ok(third.get("evt-4"), "an append that resolved must survive the next restart");
    third.close();
  });

  it("serialises an event when it is appended, not when the write drains", async () => {
    // `JSON.stringify` inside the write chain meant the persisted bytes
    // reflected entity state at WRITE time, so a caller that mutated an entity
    // between `append()` and the queued write changed what history recorded.
    const dir = await mkdtemp(join(tmpdir(), "pie-store-snapshot-"));
    const file = join(dir, "events.jsonl");
    const store = await JsonlEventStore.open(file);
    const live = { status: "PENDING" };
    const pending = store.append({ ...evt(9), payload: { run: live } });
    live.status = "COMPLETED"; // mutated before the write drains
    await pending;
    store.close();

    const reopened = await JsonlEventStore.open(file);
    const payload = reopened.all()[0]?.payload.run as { status: string };
    assert.equal(payload.status, "PENDING", "history records what was true when the event was appended");
    reopened.close();
  });

  it("appendAll is one write, so a batch is not half-applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pie-store-batch-"));
    const file = join(dir, "events.jsonl");
    const store = await JsonlEventStore.open(file);
    await store.appendAll([evt(1), evt(2), evt(3)]);
    store.close();
    const reopened = await JsonlEventStore.open(file);
    assert.equal(reopened.count(), 3);
    reopened.close();
  });

  it("LedgerEventStoreBackend adapts the existing single-project store", async () => {
    const ledger = EventStore.inMemory();
    const backend = new LedgerEventStoreBackend(ledger);
    await backend.append(evt(1));
    assert.equal(backend.count(), 1);
    assert.equal(backend.get("evt-1")?.project_id, "PRJ-1");
    assert.equal(ledger.count(), 1);
  });

  it("a Platform over a ledger store shares one event model", async () => {
    const ledger = EventStore.inMemory();
    const { Platform } = await import("../../src/platform/index.ts");
    const platform = new Platform({ ledgerStore: ledger });
    const run = platform.graph.createRun({ projectId: "PRJ-1", goal: "g" });
    platform.graph.setRunStatus(run.id, "RUNNING");
    await platform.graph.flush();
    // Both the ledger and the backend see the same events.
    assert.ok(ledger.all().length > 0);
    assert.ok(platform.store.count() > 0);
  });
});
