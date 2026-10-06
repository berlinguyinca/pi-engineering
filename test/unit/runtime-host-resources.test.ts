import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationRegistry } from "../../src/runtime/host/operations.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/host/resources.ts";

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

test("resource registry disposes timers, intervals and callbacks exactly once", async () => {
  const reg = new RuntimeResourceRegistry();
  const before = activeTimers();
  let fired = 0;
  reg.setTimeout(() => fired++, 60_000);
  reg.setInterval(() => fired++, 60_000);
  let disposed = 0;
  reg.add(() => {
    disposed++;
  }, "callback");
  reg.add({ dispose: async () => void disposed++ }, "disposable");
  assert.equal(reg.size(), 4);
  assert.equal(activeTimers(), before + 2);
  await reg.disposeAll();
  await reg.disposeAll();
  assert.equal(disposed, 2);
  assert.equal(fired, 0);
  assert.equal(reg.size(), 0);
  assert.equal(activeTimers(), before);
});

test("resource registry disposes filesystem watchers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-res-"));
  try {
    const reg = new RuntimeResourceRegistry();
    const before = process.getActiveResourcesInfo().filter((r) => r === "FSEventWrap").length;
    const w = watch(dir);
    reg.add(() => w.close(), "watcher");
    assert.equal(process.getActiveResourcesInfo().filter((r) => r === "FSEventWrap").length, before + 1);
    await reg.disposeAll();
    // A closed watcher's handle is released some loop turns later (longer on
    // a loaded machine); wait for it rather than guess a delay.
    const watchers = () => process.getActiveResourcesInfo().filter((r) => r === "FSEventWrap").length;
    for (let i = 0; i < 200 && watchers() !== before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(watchers(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing disposer does not stop the rest and is reported", async () => {
  const reg = new RuntimeResourceRegistry();
  let ran = false;
  reg.add(() => {
    throw new Error("boom");
  }, "bad");
  reg.add(() => {
    ran = true;
  }, "good");
  const failures = await reg.disposeAll();
  assert.equal(ran, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /bad: boom/);
});

test("adding to a disposed registry disposes immediately (no late leak)", async () => {
  const reg = new RuntimeResourceRegistry();
  await reg.disposeAll();
  let disposed = false;
  reg.add(() => {
    disposed = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, true);
  const before = activeTimers();
  reg.setTimeout(() => assert.fail("timer of a disposed generation fired"), 10);
  assert.equal(activeTimers(), before);
});

test("operation registry tracks operations per generation", () => {
  const ops = new OperationRegistry();
  const a = ops.begin(1, "inference", "assistant message");
  const b = ops.begin(1, "tool", "bash", { interruptible: true });
  const c = ops.begin(2, "verification", "npm test");
  assert.equal(ops.active().length, 3);
  assert.deepEqual(
    ops.blocking().map((o) => o.type),
    ["inference", "verification"],
  );
  assert.deepEqual(ops.summarize(ops.blocking()), ["1 active inference request", "1 verification command"]);
  a.end();
  a.end();
  b.end();
  c.end();
  assert.equal(ops.active().length, 0);
});

test("waitForSafePoint resolves when blocking operations finish", async () => {
  const ops = new OperationRegistry();
  const op = ops.begin(1, "tool", "edit");
  const seen: number[] = [];
  const wait = ops.waitForSafePoint({ onWaiting: (b) => seen.push(b.length) });
  setTimeout(() => op.end(), 20);
  const result = await wait;
  assert.equal(result.reached, true);
  assert.deepEqual(seen, [1]);
});

test("waitForSafePoint is cancellable and times out (never wedges)", async () => {
  const ops = new OperationRegistry();
  const op = ops.begin(1, "git", "commit");
  const ac = new AbortController();
  const wait = ops.waitForSafePoint({ signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  const cancelled = await wait;
  assert.equal(cancelled.reached, false);
  assert.equal(cancelled.reached === false && cancelled.reason, "cancelled");
  const timedOut = await ops.waitForSafePoint({ timeoutMs: 15 });
  assert.equal(timedOut.reached === false && timedOut.reason, "timeout");
  assert.equal(timedOut.reached === false && timedOut.blocking[0]?.label, "commit");
  op.end();
  assert.equal(activeTimers() >= 0, true);
});

test("gate holds new work while closed and releases queued work in order", async () => {
  const ops = new OperationRegistry();
  ops.closeGate("reload");
  const order: string[] = [];
  const first = ops.whenOpen().then(() => order.push("first"));
  const second = ops.whenOpen().then(() => order.push("second"));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, []);
  assert.equal(ops.gateClosedReason(), "reload");
  ops.openGate();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});
