import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { LedgerEvent } from "../../src/core/types.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { generateEvents, rng } from "../support/ledgerEventGen.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pi-eng-proj-"));
  dirs.push(d);
  return d;
};
const lines = (evs: LedgerEvent[]): string => evs.map((e) => `${JSON.stringify(e)}\n`).join("");
const NOW = Date.parse("2026-01-05T00:00:00Z");
const opts = (extra: object = {}) => ({ now: () => NOW, staleAfterMs: 3_600_000, ...extra });

describe("incremental projection", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}: folding events in random batches equals a full replay at every step`, async () => {
      const dir = tmp();
      const file = join(dir, "ledger.jsonl");
      const evs = generateEvents({ events: 1500, seed });
      writeFileSync(file, "");
      const rand = rng(seed * 101);
      const ledger = await Ledger.create(file);
      const incremental = new LedgerWorkProjection(ledger, opts());
      let at = 0;
      while (at < evs.length) {
        const n = 1 + Math.floor(rand() * 200);
        const batch = evs.slice(at, at + n);
        at += batch.length;
        for (const e of batch)
          await ledger.emitEvent(e.type, e.work_item_id, e.actor, e.payload, {
            ...(e.run_id ? { run_id: e.run_id } : {}),
            ...(e.task_id ? { task_id: e.task_id } : {}),
            ...(e.session_id ? { session_id: e.session_id } : {}),
          });
        const full = new LedgerWorkProjection(ledger, opts());
        assert.deepEqual(incremental.graph(), full.graph());
      }
    });
  }

  it("a snapshot restore plus the tail equals a full replay", async () => {
    const dir = tmp();
    const file = join(dir, "ledger.jsonl");
    const snapshotFile = join(dir, "projection.snapshot.json");
    const evs = generateEvents({ events: 1200, seed: 9 });
    writeFileSync(file, lines(evs.slice(0, 800)));
    const first = new LedgerWorkProjection(await Ledger.create(file), opts({ snapshotFile }));
    first.graph();
    first.flush();
    appendFileSync(file, lines(evs.slice(800)));
    const ledger = await Ledger.create(file);
    const restored = new LedgerWorkProjection(ledger, opts({ snapshotFile }));
    assert.equal(restored.restoredFromSnapshot, true);
    assert.equal(restored.cursor().position, 800);
    assert.deepEqual(restored.graph(), new LedgerWorkProjection(ledger, opts()).graph());
    assert.equal(restored.cursor().position, evs.length);
  });

  it("a corrupt, tampered or version-skewed snapshot falls back to a full replay", async () => {
    const dir = tmp();
    const file = join(dir, "ledger.jsonl");
    const snapshotFile = join(dir, "projection.snapshot.json");
    writeFileSync(file, lines(generateEvents({ events: 600, seed: 11 })));
    const ledger = await Ledger.create(file);
    const seed = new LedgerWorkProjection(ledger, opts({ snapshotFile }));
    const expected = seed.graph();
    seed.flush();
    const good = readFileSync(snapshotFile, "utf-8");
    const variants: Record<string, string> = {
      garbage: "{not json",
      empty: "",
      tampered: good.replace('"position":', '"position":0,"x":'),
      "bad checksum": good.replace(/"checksum":"[0-9a-f]{4}/, '"checksum":"0000'),
      "other version": good.replace('"version":1', '"version":99'),
    };
    for (const [name, text] of Object.entries(variants)) {
      writeFileSync(snapshotFile, text);
      const p = new LedgerWorkProjection(ledger, opts({ snapshotFile }));
      assert.equal(p.restoredFromSnapshot, false, name);
      assert.deepEqual(p.graph(), expected, name);
    }
  });

  it("a snapshot ahead of a truncated Ledger is discarded and rebuilt", async () => {
    const dir = tmp();
    const file = join(dir, "ledger.jsonl");
    const snapshotFile = join(dir, "projection.snapshot.json");
    const evs = generateEvents({ events: 600, seed: 12 });
    writeFileSync(file, lines(evs));
    const long = new LedgerWorkProjection(await Ledger.create(file), opts({ snapshotFile }));
    long.graph();
    long.flush();
    const keep = Math.floor(evs.length / 2);
    writeFileSync(file, lines(evs.slice(0, keep)));
    const ledger = await Ledger.create(file);
    const p = new LedgerWorkProjection(ledger, opts({ snapshotFile }));
    assert.equal(p.restoredFromSnapshot, false);
    assert.deepEqual(p.graph(), new LedgerWorkProjection(ledger, opts()).graph());
    assert.equal(p.cursor().position, keep);
    // And truncation mid-file is rejected even if the log regrew past the cursor with different events.
    writeFileSync(file, lines(generateEvents({ events: 900, seed: 13 })));
    long.flush();
    const regrown = await Ledger.create(file);
    const q = new LedgerWorkProjection(regrown, opts({ snapshotFile }));
    assert.equal(q.restoredFromSnapshot, false);
    assert.deepEqual(q.graph(), new LedgerWorkProjection(regrown, opts()).graph());
  });

  it("a live projection whose Ledger shrank under it resets and rebuilds", async () => {
    const evs = generateEvents({ events: 400, seed: 14 });
    const dir = tmp();
    const file = join(dir, "ledger.jsonl");
    writeFileSync(file, lines(evs));
    const ledger = await Ledger.create(file);
    const p = new LedgerWorkProjection(ledger, opts());
    p.graph();
    const file2 = join(dir, "short.jsonl");
    writeFileSync(file2, lines(evs.slice(0, 100)));
    const short = await Ledger.create(file2);
    (p as unknown as { ledger: Ledger }).ledger = short;
    assert.deepEqual(p.graph(), new LedgerWorkProjection(short, opts()).graph());
    assert.equal(p.cursor().position, 100);
  });

  it("liveness ages at read time from cached heartbeats, also after a snapshot restore", async () => {
    const dir = tmp();
    const file = join(dir, "ledger.jsonl");
    const snapshotFile = join(dir, "projection.snapshot.json");
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const evs = generateEvents({ events: 300, seed: 15, startMs: t0 });
    writeFileSync(file, lines(evs));
    const ledger = await Ledger.create(file);
    let now = t0;
    const stale = 300_000;
    const live = new LedgerWorkProjection(ledger, { now: () => now, staleAfterMs: stale, snapshotFile });
    const healthAt = (p: LedgerWorkProjection, at: number) => {
      now = at;
      return p.graph().runs.map((r) => `${r.id}:${r.health}`);
    };
    const early = healthAt(live, t0 + 1);
    const late = healthAt(live, t0 + 10 * 24 * 3_600_000);
    assert.notDeepEqual(early, late);
    assert.ok(late.some((h) => h.endsWith(":unknown")));
    assert.ok(early.some((h) => h.endsWith(":active") || h.endsWith(":waiting")));
    // Same cached facts, restored from disk: identical ageing at both clock readings.
    live.flush();
    const restored = new LedgerWorkProjection(ledger, { now: () => now, staleAfterMs: stale, snapshotFile });
    assert.equal(restored.restoredFromSnapshot, true);
    assert.deepEqual(healthAt(restored, t0 + 1), early);
    assert.deepEqual(healthAt(restored, t0 + 10 * 24 * 3_600_000), late);
    // The snapshot holds no derived health: raw run health is never "unknown"/"stalled".
    const data = JSON.parse(readFileSync(snapshotFile, "utf-8")).data;
    assert.ok(data.runs.every((r: { health: string }) => ["active", "finished", "failed"].includes(r.health)));
  });
});
