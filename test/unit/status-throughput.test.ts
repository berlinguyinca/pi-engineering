import assert from "node:assert/strict";
import { test } from "node:test";
import { ThroughputTracker } from "../../src/status/throughput.ts";

/** Deterministic fake clock helper (no sleeping). */
function fakeClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

test("throughput: rolling-window rate from provider-reported cumulative tokens", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now });
  tr.beginGeneration(); // t=0
  advance(1000);
  tr.onStreamEvent({ cumulativeOutputTokens: 50 });
  advance(1000);
  tr.onStreamEvent({ cumulativeOutputTokens: 100 });
  const s = tr.snapshot();
  assert.equal(s.phase, "streaming");
  // (100-50) / ((2000-1000)/1000) = 50 / 1 = 50 t/s
  assert.equal(s.currentTokensPerSecond, 50);
});

test("throughput: samples expire from the rolling window", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now });
  tr.beginGeneration();
  advance(1000);
  tr.onStreamEvent({ cumulativeOutputTokens: 10 });
  advance(1000);
  tr.onStreamEvent({ cumulativeOutputTokens: 20 });
  advance(1000);
  tr.onStreamEvent({ cumulativeOutputTokens: 30 });
  // At t=3000 (window 2500 => cutoff 500) all three samples are inside.
  assert.equal(tr.snapshot().currentTokensPerSecond, (30 - 10) / 2); // 10

  // Advance far beyond the window so only the newest sample survives.
  advance(10_000);
  tr.onStreamEvent({ cumulativeOutputTokens: 100 });
  const s = tr.snapshot(); // t=13000, cutoff 10500 => only (13000,100) remains
  assert.equal(s.phase, "waiting"); // fewer than 2 in-window samples => no rate
  assert.equal(s.currentTokensPerSecond, undefined);
});

test("throughput: provider reports usage live during streaming (authoritative)", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now });
  tr.beginGeneration();
  advance(500);
  tr.onStreamEvent({ cumulativeOutputTokens: 20 });
  advance(500);
  tr.onStreamEvent({ cumulativeOutputTokens: 40 });
  advance(500);
  tr.onStreamEvent({ cumulativeOutputTokens: 70 });
  const s = tr.snapshot(); // t=1500, samples (500,20)(1000,40)(1500,70)
  assert.equal(s.phase, "streaming");
  assert.equal(s.currentTokensPerSecond, (70 - 20) / 1); // 50
  assert.equal(s.outputTokens, 70);
});

test("throughput: fallback estimate from streamed deltas (batched, no per-delta tokenize)", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now, estimateBatchChars: 32, estimateCharsPerToken: 4 });
  tr.beginGeneration();
  advance(1000);
  // 32 chars => 8 estimated tokens, flushed as one sample.
  tr.onStreamEvent({ deltaText: "x".repeat(32) });
  advance(1000);
  tr.onStreamEvent({ deltaText: "y".repeat(32) }); // +8 => 16
  const s = tr.snapshot();
  assert.equal(s.phase, "streaming");
  assert.equal(s.currentTokensPerSecond, (16 - 8) / 1); // 8
  assert.equal(s.outputTokens, 16);
});

test("throughput: partial batch chars are retained (not dropped) between events", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now, estimateBatchChars: 32, estimateCharsPerToken: 4 });
  tr.beginGeneration();
  advance(1000);
  tr.onStreamEvent({ deltaText: "x".repeat(20) }); // below batch, no sample yet
  let s = tr.snapshot();
  assert.equal(s.phase, "waiting");
  assert.equal(s.outputTokens, undefined);
  // 20+20 chars accumulated => one 10-token sample (partials retained, not dropped).
  tr.onStreamEvent({ deltaText: "y".repeat(20) });
  s = tr.snapshot();
  assert.equal(s.outputTokens, 10);
  // A single sample has no rate yet => still waiting.
  assert.equal(s.phase, "waiting");
  // A second sample yields a rolling rate => streaming.
  advance(1000);
  tr.onStreamEvent({ deltaText: "z".repeat(32) }); // +8 => 18
  s = tr.snapshot();
  assert.equal(s.phase, "streaming");
  assert.equal(s.outputTokens, 18);
  assert.equal(s.currentTokensPerSecond, (18 - 10) / 1); // 8
});

test("throughput: provider usage only at completion — reconcile final authoritative TPS", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now, estimateBatchChars: 32, estimateCharsPerToken: 4 });
  tr.beginGeneration();
  advance(1000);
  tr.onStreamEvent({ deltaText: "x".repeat(32) }); // estimate 8
  advance(1000);
  tr.onStreamEvent({ deltaText: "y".repeat(32) }); // estimate 16
  // Final authoritative usage overrides the estimate.
  tr.endGeneration(40); // t=2000 => duration 2s
  const s = tr.snapshot();
  assert.equal(s.phase, "idle");
  assert.equal(s.outputTokens, 40);
  assert.equal(s.lastCompletedTokensPerSecond, 40 / 2); // 20
  assert.equal(s.currentTokensPerSecond, undefined);
});

test("throughput: idle retains the last completed TPS (does not collapse to 0)", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now });
  tr.beginGeneration();
  advance(2000);
  tr.onStreamEvent({ cumulativeOutputTokens: 100 });
  tr.endGeneration(100); // t=2000 => 100/2 = 50
  let s = tr.snapshot();
  assert.equal(s.phase, "idle");
  assert.equal(s.lastCompletedTokensPerSecond, 50);
  // Later, still idle with the last completed rate retained.
  advance(60_000);
  s = tr.snapshot();
  assert.equal(s.phase, "idle");
  assert.equal(s.lastCompletedTokensPerSecond, 50);
  assert.equal(s.currentTokensPerSecond, undefined);
});

test("throughput: model/request reset clears samples, last-completed, and phase", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now });
  tr.beginGeneration();
  advance(1000);
  tr.onStreamEvent({ cumulativeOutputTokens: 30 });
  tr.endGeneration(30);
  assert.equal(tr.snapshot().lastCompletedTokensPerSecond, 30);
  tr.reset();
  const s = tr.snapshot();
  assert.equal(s.phase, "unavailable");
  assert.equal(s.currentTokensPerSecond, undefined);
  assert.equal(s.lastCompletedTokensPerSecond, undefined);
  assert.equal(s.outputTokens, undefined);
});

test("throughput: waiting until enough samples exist", () => {
  const { now } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now });
  tr.beginGeneration();
  const s = tr.snapshot();
  assert.equal(s.phase, "waiting");
  assert.equal(s.currentTokensPerSecond, undefined);
});

test("throughput: authoritative accounting clears prior estimate samples (no mixing)", () => {
  const { now, advance } = fakeClock();
  const tr = new ThroughputTracker({ windowMs: 2500, now, estimateBatchChars: 32, estimateCharsPerToken: 4 });
  tr.beginGeneration();
  advance(1000);
  tr.onStreamEvent({ deltaText: "x".repeat(32) }); // estimate 8
  // Provider starts reporting live usage: must not mix estimate (8) with authoritative.
  advance(500);
  tr.onStreamEvent({ cumulativeOutputTokens: 20 });
  advance(500);
  tr.onStreamEvent({ cumulativeOutputTokens: 40 });
  const s = tr.snapshot(); // samples (1500,20)(2000,40) authoritative
  assert.equal(s.currentTokensPerSecond, (40 - 20) / 0.5); // 40
});
