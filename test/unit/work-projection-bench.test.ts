import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { generateEvents } from "../support/ledgerEventGen.ts";

/**
 * Benchmark of LedgerWorkProjection.graph() over synthetic Ledger streams. 10k runs in the default
 * suite with a generous bound. 100k is opt-in: the ONLY gate is the env var PI_ENG_BENCH_100K, read
 * only by this test file (node --test gives test files no argument channel).
 */
v8.setFlagsFromString("--expose-gc");
const gc = (): void => {
  runInNewContext("gc")();
};

async function measure(events: number) {
  const evs = generateEvents({ events, seed: 7 });
  const dir = mkdtempSync(join(tmpdir(), "pi-eng-bench-"));
  const file = join(dir, "ledger.jsonl");
  writeFileSync(file, `${evs.map((e) => JSON.stringify(e)).join("\n")}\n`);
  let t = performance.now();
  const ledger = await Ledger.create(file);
  const loadMs = performance.now() - t;
  gc();
  const before = process.memoryUsage().heapUsed;
  const projection = new LedgerWorkProjection(ledger, {
    snapshotFile: join(dir, "projection.snapshot.json"),
    now: () => Date.parse("2026-01-02T00:00:00Z"),
  });
  t = performance.now();
  const g = projection.graph();
  const coldMs = performance.now() - t;
  gc();
  const heapMb = (process.memoryUsage().heapUsed - before) / 1048576;
  t = performance.now();
  for (let i = 0; i < 5; i++) projection.graph();
  const warmMs = (performance.now() - t) / 5;
  // One new event, then graph(): the steady-state cost of /work after the first call.
  await ledger.emitEvent(
    "agent.heartbeat",
    evs[0]?.work_item_id ?? null,
    { type: "agent" },
    {},
    { run_id: "RUN-x", task_id: "WI-x" },
  );
  t = performance.now();
  projection.graph();
  const incrementalMs = performance.now() - t;
  // A restart with a snapshot: only the tail past the cursor is folded in.
  projection.flush();
  const snapshotFile = join(dir, "projection.snapshot.json");
  t = performance.now();
  const restored = new LedgerWorkProjection(ledger, { snapshotFile, now: () => Date.parse("2026-01-02T00:00:00Z") });
  restored.graph();
  const restartMs = performance.now() - t;
  assert.equal(restored.restoredFromSnapshot, true);
  rmSync(dir, { recursive: true, force: true });
  const row = {
    incrementalMs,
    restartMs,
    loadMs,
    events: ledger.count(),
    tasks: g.tasks.length,
    runs: g.runs.length,
    coldMs,
    warmMs,
    heapMb,
  };
  console.log(
    `BENCH-PROJECTION ${JSON.stringify(row, (_k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v))}`,
  );
  return row;
}

describe("projection benchmark", () => {
  it("10k events: graph() stays within a generous bound", async () => {
    const r = await measure(10_000);
    assert.ok(r.coldMs < 5_000, `cold graph() ${r.coldMs}ms`);
    assert.ok(r.warmMs < 2_000, `warm graph() ${r.warmMs}ms`);
  });
  it("100k events (opt-in: PI_ENG_BENCH_100K=1)", { skip: !process.env.PI_ENG_BENCH_100K }, async () => {
    const r = await measure(100_000);
    assert.ok(r.coldMs < 120_000);
  });
});
