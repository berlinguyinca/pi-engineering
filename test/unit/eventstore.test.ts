import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LedgerEvent } from "../../src/core/types.ts";
import { EventStore } from "../../src/ledger/EventStore.ts";

function evt(id: string): LedgerEvent {
  return {
    event_id: id,
    work_item_id: null,
    timestamp: new Date().toISOString(),
    actor: { type: "system" },
    type: "decision.accepted",
    payload: { claim: id },
  };
}

test("EventStore serializes concurrent appends without loss or corruption (parallel-candidate safety)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-ev-"));
  const file = join(dir, "ledger.jsonl");
  try {
    const store = await EventStore.create(file);
    const N = 50;
    // Fire N appends concurrently (as parallel tournament candidates would).
    await Promise.all(Array.from({ length: N }, (_, i) => store.append(evt(`evt-${i}`))));
    assert.equal(store.count(), N, "every concurrent append must be recorded");

    // The on-disk file must be intact, parseable JSONL with all N events.
    const raw = await readFile(file, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, N, "file must contain exactly N well-formed JSONL lines");
    const ids = new Set(lines.map((l) => (JSON.parse(l) as LedgerEvent).event_id));
    for (let i = 0; i < N; i++) assert.ok(ids.has(`evt-${i}`), `event evt-${i} must be present`);

    // A fresh store replaying the file reconstructs the same event set.
    const replay = await EventStore.create(file);
    assert.equal(replay.count(), N);
    const replayIds = new Set(replay.all().map((e) => e.event_id));
    for (let i = 0; i < N; i++) assert.ok(replayIds.has(`evt-${i}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
