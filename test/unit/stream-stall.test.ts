/**
 * Model-stream stall watchdog (defect C).
 *
 * A gateway that holds the connection open without sending data used to hang
 * the awaited model call forever: no session events fire, the event-re-armed
 * inactivity guards never trigger, and the execution zombies while still
 * reporting "Model streaming" liveness. These tests cover the watchdog's
 * arm/reset/disarm/expiry semantics (deterministic via an injected timer and
 * clock) and the config plumbing (PI_GATEWAY_STREAM_STALL_MS).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "../../src/gateway/config.ts";
import { STREAM_STALL_MARKER, StreamStallWatchdog, isStalledStream } from "../../src/workers/streamStall.ts";

interface FakeTimer {
  fn: (() => void) | undefined;
  ms: number;
  cleared: boolean;
}

/** A deterministic timer: capture the callback and fire it on demand. */
function makeFakeTimers(): {
  timers: FakeTimer[];
  arm: (fn: () => void, ms: number) => { clear: () => void };
  fire: (i: number) => void;
} {
  const timers: FakeTimer[] = [];
  return {
    timers,
    arm: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return {
        clear: () => {
          t.cleared = true;
          t.fn = undefined;
        },
      };
    },
    fire: (i: number) => {
      const t = timers[i];
      assert.ok(t, `timer ${i} exists`);
      if (!t.cleared && t.fn) t.fn();
    },
  };
}

async function withEnv(name: string, value: string | undefined, fn: () => void): Promise<void> {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

// ─── Watchdog semantics ──────────────────────────────────────────────────────

test("watchdog: armed silence for the full window fires onStall exactly once", () => {
  const t = makeFakeTimers();
  const nowMs = 0;
  let fired = 0;
  const watchdog = new StreamStallWatchdog({
    stallMs: 10_000,
    onStall: () => fired++,
    setTimer: t.arm,
    now: () => nowMs,
  });
  watchdog.arm();
  assert.equal(watchdog.isActive, true);
  t.fire(0);
  assert.equal(fired, 1, "stall fires once");
  assert.equal(watchdog.hasFired, true);
  assert.equal(watchdog.isActive, false);
  // Never re-arms after firing.
  watchdog.arm();
  assert.equal(t.timers.length, 1, "no new timer after fire");
});

test("watchdog: a reset within the window keeps a streaming request alive", () => {
  const t = makeFakeTimers();
  let nowMs = 0;
  let fired = 0;
  const watchdog = new StreamStallWatchdog({
    stallMs: 10_000,
    onStall: () => fired++,
    setTimer: t.arm,
    now: () => nowMs,
  });
  watchdog.arm(); // prompt start (timer 0)
  nowMs = 4_000;
  watchdog.arm(); // first token resets (timer 1, timer 0 cleared)
  nowMs = 9_000;
  watchdog.arm(); // more tokens reset (timer 2)
  assert.equal(t.timers[0]?.cleared, true, "superseded timer is cleared");
  assert.equal(t.timers[1]?.cleared, true, "superseded timer is cleared");
  assert.equal(fired, 0, "an active stream never stalls");
  // Now silence for the full window.
  nowMs = 19_000;
  t.fire(2);
  assert.equal(fired, 1);
});

test("watchdog: disarming (tool running / turn ended) cancels the window", () => {
  const t = makeFakeTimers();
  let fired = 0;
  const watchdog = new StreamStallWatchdog({
    stallMs: 10_000,
    onStall: () => fired++,
    setTimer: t.arm,
    now: () => 0,
  });
  watchdog.arm();
  watchdog.disarm(); // a tool starts
  t.fire(0);
  assert.equal(fired, 0, "a running tool is not a stall");
  assert.equal(watchdog.isActive, false);
  // Re-arm for the next model turn after the tool completes.
  watchdog.arm();
  assert.equal(watchdog.isActive, true);
  t.fire(1);
  assert.equal(fired, 1, "silence after the tool still stalls");
});

test("watchdog: elapsedMs tracks silence since arming", () => {
  const t = makeFakeTimers();
  let nowMs = 0;
  const watchdog = new StreamStallWatchdog({
    stallMs: 10_000,
    onStall: () => undefined,
    setTimer: t.arm,
    now: () => nowMs,
  });
  assert.equal(watchdog.elapsedMs, 0, "disarmed => no elapsed");
  watchdog.arm();
  nowMs = 3_000;
  assert.equal(watchdog.elapsedMs, 3_000);
  watchdog.disarm();
  assert.equal(watchdog.elapsedMs, 0);
});

test("watchdog: rejects a non-positive or non-finite window", () => {
  assert.throws(() => new StreamStallWatchdog({ stallMs: 0, onStall: () => undefined }), /positive ms/);
  assert.throws(() => new StreamStallWatchdog({ stallMs: -5, onStall: () => undefined }), /positive ms/);
  assert.throws(() => new StreamStallWatchdog({ stallMs: Number.NaN, onStall: () => undefined }), /positive ms/);
});

test("stall marker: the watchdog's error signature is recognised in settlement", () => {
  assert.equal(isStalledStream(`model stream stalled: no data for 600000ms`), true);
  assert.equal(isStalledStream(STREAM_STALL_MARKER), true);
  assert.equal(isStalledStream("truncated stream"), false);
  assert.equal(isStalledStream(undefined), false);
});

// ─── Config plumbing ─────────────────────────────────────────────────────────

test("config: PI_GATEWAY_STREAM_STALL_MS accepts ms and durations", () => {
  withEnv("PI_GATEWAY_STREAM_STALL_MS", "45000", () => {
    assert.equal(resolveGatewayConfig().modelStreamStallMs, 45_000);
  });
  withEnv("PI_GATEWAY_STREAM_STALL_MS", "10m", () => {
    assert.equal(resolveGatewayConfig().modelStreamStallMs, 600_000);
  });
});

test("config: PI_GATEWAY_STREAM_STALL_MS=0 disables the watchdog; garbage falls back", () => {
  withEnv("PI_GATEWAY_STREAM_STALL_MS", "0", () => {
    assert.equal(resolveGatewayConfig().modelStreamStallMs, 0, "0 is a real setting (disabled)");
  });
  withEnv("PI_GATEWAY_STREAM_STALL_MS", "not-a-duration", () => {
    assert.equal(
      resolveGatewayConfig().modelStreamStallMs,
      DEFAULT_GATEWAY_CONFIG.modelStreamStallMs,
      "unparseable => default",
    );
  });
  withEnv("PI_GATEWAY_STREAM_STALL_MS", undefined, () => {
    assert.equal(resolveGatewayConfig().modelStreamStallMs, 600_000, "default is a 10-minute window");
  });
});

test("config: programmatic override and sanitization", () => {
  assert.equal(resolveGatewayConfig({ modelStreamStallMs: 123_456 }).modelStreamStallMs, 123_456);
  assert.equal(
    resolveGatewayConfig({ modelStreamStallMs: Number.POSITIVE_INFINITY }).modelStreamStallMs,
    DEFAULT_GATEWAY_CONFIG.modelStreamStallMs,
  );
  assert.equal(resolveGatewayConfig({ modelStreamStallMs: -1 }).modelStreamStallMs, 0, "negative clamps to disabled");
});
