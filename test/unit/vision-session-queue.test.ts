import assert from "node:assert/strict";
import test from "node:test";

import { SessionQueue } from "../../src/visionDelegation/sessionQueue.ts";

/** A promise you resolve or reject from outside. */
function gate<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

test("calls for one key run strictly in call order, one at a time", async () => {
  const q = new SessionQueue();
  const log: string[] = [];
  const g1 = gate();
  const g2 = gate();
  const a = q.run("k", async () => {
    log.push("a start");
    await g1.promise;
    log.push("a end");
    return "a";
  });
  const b = q.run("k", async () => {
    log.push("b start");
    await g2.promise;
    log.push("b end");
    return "b";
  });
  const c = q.run("k", async () => {
    log.push("c");
    return "c";
  });
  await tick();
  assert.deepEqual(log, ["a start"]);
  g2.resolve(); // b's work is ready, but b must not start before a ends
  await tick();
  assert.deepEqual(log, ["a start"]);
  g1.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), ["a", "b", "c"]);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c"]);
});

test("different keys run independently", async () => {
  const q = new SessionQueue();
  const blockA = gate();
  const a = q.run("A", () => blockA.promise.then(() => "a"));
  assert.equal(await q.run("B", async () => "b"), "b", "B finished while A is still blocked");
  blockA.resolve();
  assert.equal(await a, "a");
});

test("a rejected earlier call does not block the next", async () => {
  const q = new SessionQueue();
  const first = q.run("k", async () => {
    throw new Error("boom");
  });
  const second = q.run("k", async () => "ok");
  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  assert.equal(q.size, 0);
});

test("an idle key's entry is dropped", async () => {
  const q = new SessionQueue();
  const g = gate();
  const p = q.run("k", () => g.promise);
  assert.equal(q.has("k"), true);
  assert.equal(q.size, 1);
  g.resolve();
  await p;
  assert.equal(q.has("k"), false);
  assert.equal(q.size, 0);
});

test("the entry is not dropped while a later call is still chained", async () => {
  const q = new SessionQueue();
  const g1 = gate();
  const g2 = gate();
  const first = q.run("k", () => g1.promise);
  const second = q.run("k", () => g2.promise);
  g1.resolve();
  await first;
  assert.equal(q.has("k"), true, "the first finishing must not drop the second's tail");
  let thirdRan = false;
  const third = q.run("k", async () => {
    thirdRan = true;
  });
  await tick();
  assert.equal(thirdRan, false, "a call queued after the first finished still waits for the second");
  g2.resolve();
  await Promise.all([second, third]);
  assert.equal(thirdRan, true);
  assert.equal(q.size, 0);
});
