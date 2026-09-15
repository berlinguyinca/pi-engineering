import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { MemoryFeeder } from "../../src/panel/feeders/MemoryFeeder.ts";
import { buildRows } from "../../src/panel/tree.ts";

function managerState(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    version: "1",
    provider: "openviking",
    durableKind: "file",
    sessions: 2,
    activeSessions: 1,
    entries: 14,
    compactions: 3,
    promotionCandidates: 5,
    promoted: 2,
    memoryWorkersRun: { observer: 4, reflector: 1, dropper: 0 },
    ...over,
  } as never;
}

const memoryTab = new Set(["memory"]);

test("memory: counts reach panel state from blackhole telemetry", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: { state: () => managerState() } }).refresh();
  assert.equal(state.snapshot.memory?.enabled, true);
  assert.equal(state.snapshot.memory?.entries, 14);
  assert.equal(state.snapshot.memory?.promotionCandidates, 5);
  assert.equal(state.snapshot.memory?.promoted, 2);
  assert.equal(state.snapshot.memory?.workers.observer, 4);
});

test("memory: no blackhole reports disabled rather than zeros that look broken", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: null }).refresh();
  assert.equal(state.snapshot.memory?.enabled, false);
});

test("memory: a disabled manager is reported as disabled", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: { state: () => managerState({ enabled: false }) } }).refresh();
  assert.equal(state.snapshot.memory?.enabled, false);
});

test("memory: a throwing manager degrades instead of breaking the panel", () => {
  const state = new PanelState();
  const feeder = new MemoryFeeder({
    state,
    blackhole: {
      state: () => {
        throw new Error("blackhole exploded");
      },
    },
  });
  assert.doesNotThrow(() => feeder.refresh());
  assert.equal(
    state.snapshot.errors.some((e) => e.section === "memory"),
    true,
    "the section is marked, not silently empty",
  );
});

test("memory: a recovered manager clears the error it left behind", () => {
  const state = new PanelState();
  let broken = true;
  const feeder = new MemoryFeeder({
    state,
    blackhole: {
      state: () => {
        if (broken) throw new Error("transient");
        return managerState();
      },
    },
  });
  feeder.refresh();
  broken = false;
  feeder.refresh();
  assert.equal(
    state.snapshot.errors.some((e) => e.section === "memory"),
    false,
  );
  assert.equal(state.snapshot.memory?.entries, 14);
});

test("memory: the tab says Blackhole is off rather than showing zeros", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: null }).refresh();
  const text = buildRows(state.snapshot, memoryTab, "memory")
    .map((r) => r.label)
    .join("\n");
  assert.match(text, /off|disabled/i);
  assert.doesNotMatch(text, /\b0\b/, "zeros read as a failure, not as 'not running'");
});

test("memory: the tab reports this session's counts when enabled", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: { state: () => managerState() } }).refresh();
  const text = buildRows(state.snapshot, memoryTab, "memory")
    .map((r) => r.label)
    .join("\n");
  assert.match(text, /14/);
  assert.match(text, /promoted/i);
  assert.match(text, /candidate/i);
});

test("memory: refreshing with unchanged counts publishes nothing", () => {
  const state = new PanelState();
  const feeder = new MemoryFeeder({ state, blackhole: { state: () => managerState() } });
  feeder.refresh();
  let publishes = 0;
  state.subscribe(() => publishes++);
  feeder.refresh();
  assert.equal(publishes, 0, "a feeder on a timer must not cause a render storm");
});
