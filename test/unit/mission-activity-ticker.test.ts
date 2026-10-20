import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionActivityTicker } from "../../src/orchestration/observability/MissionActivityTicker.ts";

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
