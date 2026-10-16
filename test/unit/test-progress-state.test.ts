import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveTestStateInput, LiveTestStateResult } from "../../src/verify/testProgressState.ts";
import { formatProgressLine, toLiveTestState } from "../../src/verify/testProgressState.ts";

test("live test state: progressing -> running", () => {
  const input: LiveTestStateInput = { level: "progressing", quarantinedHit: false, finished: false };
  assert.deepEqual(toLiveTestState(input), { state: "running", reason: "progress observed" });
});

test("live test state: quiet -> quiet 'no recent progress'", () => {
  const input: LiveTestStateInput = { level: "quiet", quarantinedHit: false, finished: false };
  assert.deepEqual(toLiveTestState(input), { state: "quiet", reason: "no recent progress" });
});

test("live test state: investigate -> quiet 'investigating prolonged silence'", () => {
  const input: LiveTestStateInput = { level: "investigate", quarantinedHit: false, finished: false };
  assert.deepEqual(toLiveTestState(input), { state: "quiet", reason: "investigating prolonged silence" });
});

test("live test state: stalled -> stalled", () => {
  const input: LiveTestStateInput = { level: "stalled", quarantinedHit: false, finished: false };
  assert.deepEqual(toLiveTestState(input), { state: "stalled", reason: "no progress past stall threshold" });
});

test("live test state: quarantinedHit with level stalled -> blocked", () => {
  const input: LiveTestStateInput = { level: "stalled", quarantinedHit: true, finished: false };
  assert.deepEqual(toLiveTestState(input), { state: "blocked", reason: "depends on a quarantined test" });
});

test("live test state: finished -> done", () => {
  const input: LiveTestStateInput = { level: "progressing", quarantinedHit: false, finished: true };
  assert.deepEqual(toLiveTestState(input), { state: "done", reason: "stage finished" });
});

test("live test state: finished with quarantinedHit -> blocked", () => {
  const input: LiveTestStateInput = { level: "progressing", quarantinedHit: true, finished: true };
  assert.deepEqual(toLiveTestState(input), { state: "blocked", reason: "depends on a quarantined test" });
});

test("live test state: formatProgressLine full line", () => {
  const r: LiveTestStateResult = { state: "quiet", reason: "no recent progress" };
  assert.equal(formatProgressLine("test", r, 125000), "[test] quiet: no recent progress (silent 125s)");
});

test("live test state: negative silentMs -> 0s", () => {
  const r: LiveTestStateResult = { state: "running", reason: "progress observed" };
  assert.equal(formatProgressLine("test", r, -5000), "[test] running: progress observed (silent 0s)");
});

test("live test state: silentMs 999 -> 0s", () => {
  const r: LiveTestStateResult = { state: "running", reason: "progress observed" };
  assert.equal(formatProgressLine("test", r, 999), "[test] running: progress observed (silent 0s)");
});

test("live test state: NaN silentMs -> 0s", () => {
  const r: LiveTestStateResult = { state: "running", reason: "progress observed" };
  assert.equal(formatProgressLine("test", r, Number.NaN), "[test] running: progress observed (silent 0s)");
});

test("live test state: input object frozen and not mutated", () => {
  const input: LiveTestStateInput = { level: "quiet", quarantinedHit: false, finished: false };
  Object.freeze(input);
  toLiveTestState(input);
  assert.deepEqual(input, { level: "quiet", quarantinedHit: false, finished: false });
  assert.equal(Object.isFrozen(input), true);
});
