/**
 * The panel's refresh loop.
 *
 * Extracted from the extension entry point because the only way to observe it
 * there was counting the process's timers — flaky, and unable to tell this
 * timer from any other. Two defects had lived in that blind spot: the loop was
 * started and never stopped, and starting was a no-op while a loop already
 * existed, so the first session's loop permanently owned refreshing and kept
 * running git against the first session's repository.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelRefreshLoop } from "../../src/panel/refreshLoop.ts";

/** A controllable clock: records handles and lets tests fire ticks by hand. */
function fakeTimers() {
  let next = 1;
  const live = new Map<number, () => void>();
  return {
    live,
    setInterval: (handler: () => void) => {
      const id = next++;
      live.set(id, handler);
      return id;
    },
    clearInterval: (handle: unknown) => {
      live.delete(handle as number);
    },
    fire: () => {
      for (const handler of [...live.values()]) handler();
    },
  };
}

function loopWith(t: ReturnType<typeof fakeTimers>, tick: () => void) {
  return new PanelRefreshLoop({ tick, intervalMs: 1_000, setInterval: t.setInterval, clearInterval: t.clearInterval });
}

test("refresh loop: starting runs the tick on each interval", () => {
  const t = fakeTimers();
  let ticks = 0;
  const loop = loopWith(t, () => ticks++);

  loop.start();
  t.fire();
  t.fire();
  assert.equal(ticks, 2);
  loop.stop();
});

test("refresh loop: stopping ends the ticks", () => {
  const t = fakeTimers();
  let ticks = 0;
  const loop = loopWith(t, () => ticks++);

  loop.start();
  t.fire();
  loop.stop();
  t.fire();
  assert.equal(ticks, 1);
});

test("refresh loop: starting again REPLACES the loop rather than being ignored", () => {
  // The defect this class exists for. The old code returned early when a timer
  // existed, so a new session inherited the previous session's loop — pointed
  // at the previous session's repository, and impossible to replace.
  const t = fakeTimers();
  let ticks = 0;
  const loop = loopWith(t, () => ticks++);

  loop.start();
  loop.start();
  loop.start();

  assert.equal(t.live.size, 1, "three starts must leave one loop, not three");
  t.fire();
  assert.equal(ticks, 1, "and one tick, not three");
  loop.stop();
});

test("refresh loop: a replaced loop leaves nothing running", () => {
  const t = fakeTimers();
  const loop = loopWith(t, () => {});

  loop.start();
  loop.start();
  loop.stop();

  assert.equal(t.live.size, 0, "no orphaned handle survives a restart");
  assert.equal(loop.active, false);
});

test("refresh loop: stopping an idle loop is safe", () => {
  const t = fakeTimers();
  const loop = loopWith(t, () => {});

  loop.stop();
  loop.stop();
  assert.equal(loop.active, false);
});

test("refresh loop: a throwing tick does not stop the loop or escape", () => {
  // A refresh is never worth taking a session down for, and one bad tick must
  // not silently end all future refreshes.
  const t = fakeTimers();
  let ticks = 0;
  const loop = loopWith(t, () => {
    ticks++;
    throw new Error("git exploded");
  });

  loop.start();
  assert.doesNotThrow(() => t.fire());
  assert.doesNotThrow(() => t.fire());
  assert.equal(ticks, 2, "the loop survived its own failure");
  loop.stop();
});

test("refresh loop: active reports the truth", () => {
  const t = fakeTimers();
  const loop = loopWith(t, () => {});

  assert.equal(loop.active, false);
  loop.start();
  assert.equal(loop.active, true);
  loop.stop();
  assert.equal(loop.active, false);
});
