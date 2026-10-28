import assert from "node:assert/strict";
import { test } from "node:test";
import { ClockOnlyGate, MissionActivityTicker } from "../../src/orchestration/observability/MissionActivityTicker.ts";

test("live ticker redraws quiet missions without fabricating events and stops terminal/closed missions", () => {
  let tick: (() => void) | undefined;
  let now = 0;
  const states = new Map([
    ["one", "EXECUTING"],
    ["two", "PLANNING"],
  ]);
  const updates: string[] = [];
  let cleared = 0;
  const ticker = new MissionActivityTicker({
    state: (id) => states.get(id),
    emit: (id, at) => updates.push(`${id}:${at}`),
    now: () => new Date(now).toISOString(),
    schedule: (callback) => {
      tick = callback;
      return () => {
        cleared++;
        tick = undefined;
      };
    },
  });
  ticker.watch("one");
  ticker.watch("two");
  now = 1000;
  tick!();
  assert.deepEqual(updates, ["one:1970-01-01T00:00:01.000Z", "two:1970-01-01T00:00:01.000Z"]);
  states.set("one", "COMPLETE");
  ticker.watch("one");
  updates.length = 0;
  now = 2000;
  tick!();
  assert.deepEqual(updates, ["two:1970-01-01T00:00:02.000Z"]);
  states.set("two", "FAILED");
  ticker.watch("two");
  assert.equal(tick, undefined);
  assert.equal(cleared, 1);
  states.set("two", "EXECUTING");
  ticker.watch("two");
  assert.ok(tick);
  ticker.close();
  assert.equal(tick, undefined);
  ticker.watch("two");
  assert.equal(tick, undefined);
});

test("clock gate lets a tick through only when a displayed age changes or the build goes stale", () => {
  const t0 = Date.parse("2026-10-22T00:00:00.000Z");
  const gate = new ClockOnlyGate(15_000);
  assert.equal(gate.due("m", t0), true, "an unseen mission always builds");

  // Quiet for 2h: ages render as `Xh YYm`, so only a minute boundary changes the text.
  const quiet = new Date(t0 - 2 * 3_600_000 - 5_000).toISOString();
  gate.remember("m", [quiet, undefined, null], t0);
  assert.equal(gate.due("m", t0 + 1_000), false);
  assert.equal(gate.due("m", t0 + 9_000), false);
  assert.equal(gate.due("m", t0 + 14_000), false, "still the same minute, still fresh");
  assert.equal(gate.due("m", t0 + 15_000), true, "stale builds are re-evaluated so health can change");

  // Recent timestamp: seconds are displayed, so every second differs.
  const recent = new Date(t0 - 3_000).toISOString();
  gate.remember("m", [recent], t0);
  assert.equal(gate.due("m", t0 + 1_000), true);

  // Crossing a minute boundary for a quiet mission lets the tick through.
  const nearMinute = new Date(t0 - 3_600_000 - 59 * 60_000 - 50_000).toISOString(); // 1h59m50s ... 2h00m
  gate.remember("m", [nearMinute], t0);
  assert.equal(gate.due("m", t0 + 5_000), false);
  assert.equal(gate.due("m", t0 + 11_000), true, "1h59m -> 2h00m is a visible change");

  gate.forget("m");
  assert.equal(gate.due("m", t0), true);
  gate.remember("m", [quiet], t0);
  gate.clear();
  assert.equal(gate.due("m", t0), true);
});
