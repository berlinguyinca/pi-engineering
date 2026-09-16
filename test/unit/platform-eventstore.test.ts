import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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

    const s2 = await JsonlEventStore.open(file);
    assert.equal(s2.count(), 2);
    assert.equal(s2.all()[1]?.event_id, "evt-2");
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
