import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor } from "../../src/core/types.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { StatusRowRefresher } from "../../src/work/statusRowRefresher.ts";

const user: Actor = { type: "user" };
const worker: Actor = { type: "agent", run_id: "RUN-a", role: "implementer", model: "m1" };
const STALE = 300_000;

async function setup() {
  const ledger = Ledger.fromEvents([]);
  const wi = await ledger.createWorkItem("g", "low", ["r"], user);
  const start = await ledger.emitEvent("agent.started", wi.id, worker, {}, { run_id: "RUN-a", task_id: wi.id });
  const t0 = Date.parse(start.timestamp);
  let now = t0;
  const projection = new LedgerWorkProjection(ledger, { now: () => now, staleAfterMs: STALE });
  const writes: Array<string | undefined> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let fail = false;
  const refresher = new StatusRowRefresher({
    intervalMs: 15_000,
    getGraph: () => {
      if (fail) throw new Error("boom");
      return projection.graph();
    },
    setStatus: (t) => writes.push(t),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t as never;
    },
    clearTimer: (h) => {
      (h as unknown as { cleared: boolean }).cleared = true;
    },
  });
  return {
    ledger,
    wi,
    refresher,
    writes,
    timers,
    advance: (ms: number) => {
      now = t0 + ms;
    },
    setFail: (v: boolean) => {
      fail = v;
    },
  };
}

describe("StatusRowRefresher", () => {
  it("writes once and not again while the text is unchanged", async () => {
    const s = await setup();
    await s.refresher.refresh();
    await s.refresher.refresh();
    assert.equal(s.writes.length, 1);
    assert.match(s.writes[0] ?? "", /1 run/);
  });

  it("flips to unknown after the stale threshold, driven by the timer", async () => {
    const s = await setup();
    await s.refresher.refresh();
    assert.equal(s.timers.length, 1);
    assert.equal(s.timers[0]?.ms, 15_000);
    s.advance(STALE + 1);
    s.timers[0]?.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.writes.length, 2);
    assert.match(s.writes[1] ?? "", /1 unknown/);
  });

  it("stops the timer when nothing is live and restarts it for the next live run", async () => {
    const s = await setup();
    await s.refresher.refresh();
    assert.ok(s.refresher.timerActive);
    await s.ledger.emitEvent("agent.completed", s.wi.id, worker, {}, { run_id: "RUN-a", task_id: s.wi.id });
    await s.refresher.refresh();
    assert.equal(s.refresher.timerActive, false);
    assert.equal(s.timers[0]?.cleared, true);
    const w2: Actor = { type: "agent", run_id: "RUN-b", role: "implementer", model: "m1" };
    await s.ledger.emitEvent("agent.started", s.wi.id, w2, {}, { run_id: "RUN-b", task_id: s.wi.id });
    await s.refresher.refresh();
    assert.equal(s.refresher.timerActive, true);
    assert.equal(s.timers.length, 2);
  });

  it("dispose clears the timer and stops further writes", async () => {
    const s = await setup();
    await s.refresher.refresh();
    s.refresher.dispose();
    assert.equal(s.refresher.timerActive, false);
    assert.equal(s.timers[0]?.cleared, true);
    const n = s.writes.length;
    await s.refresher.refresh();
    assert.equal(s.writes.length, n);
  });

  it("swallows projection errors and keeps the last row", async () => {
    const s = await setup();
    await s.refresher.refresh();
    s.setFail(true);
    await assert.doesNotReject(s.refresher.refresh());
    assert.equal(s.writes.length, 1);
    assert.equal(s.refresher.timerActive, true);
  });

  it("an idle graph does no timer work", async () => {
    const timers: unknown[] = [];
    const r = new StatusRowRefresher({
      intervalMs: 1000,
      getGraph: () => undefined,
      setStatus: () => {},
      setTimer: (...a) => {
        timers.push(a);
        return {};
      },
    });
    await r.refresh();
    assert.equal(timers.length, 0);
  });
});
