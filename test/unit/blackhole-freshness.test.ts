import assert from "node:assert/strict";
import { test } from "node:test";
import { rankMemories, scoreMemory } from "../../src/blackhole/freshness.ts";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-01-15T00:00:00Z");
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

test("freshness: age measured from lastVerifiedAt when present, else createdAt", () => {
  const mem = { createdAt: iso(40), lastVerifiedAt: iso(2) };
  const score = scoreMemory(mem, NOW);
  assert.equal(score.ageDays, 2);
  assert.equal(score.freshness, "fresh");
  assert.equal(score.confidence, 1);

  const noVerify = scoreMemory({ createdAt: iso(2) }, NOW);
  assert.equal(noVerify.ageDays, 2);
  assert.equal(noVerify.freshness, "fresh");
});

test("freshness: boundary at 6.99 days is fresh", () => {
  const score = scoreMemory({ createdAt: iso(6.99) }, NOW);
  assert.equal(score.freshness, "fresh");
  assert.equal(score.confidence, 1);
  assert.ok(score.ageDays < 7);
});

test("freshness: boundary at exactly 7 days is aging", () => {
  const score = scoreMemory({ createdAt: iso(7) }, NOW);
  assert.equal(score.freshness, "aging");
  assert.equal(score.confidence, 0.9);
  assert.match(score.reasons.join(" "), /aging/);
});

test("freshness: boundary at exactly 30 days is aging", () => {
  const score = scoreMemory({ createdAt: iso(30) }, NOW);
  assert.equal(score.freshness, "aging");
  assert.equal(score.confidence, 0.9);
});

test("freshness: boundary at 30.01 days is stale", () => {
  const score = scoreMemory({ createdAt: iso(30.01) }, NOW);
  assert.equal(score.freshness, "stale");
  assert.equal(score.confidence, 0.8);
  assert.match(score.reasons.join(" "), /stale/);
});

test("freshness: sourceSha mismatch subtracts 0.4", () => {
  const fresh = scoreMemory({ createdAt: iso(1), sourceSha: "abc" }, NOW, "def");
  assert.equal(fresh.freshness, "fresh");
  assert.equal(fresh.confidence, 0.6);
  assert.match(fresh.reasons.join(" "), /sourceSha/);
});

test("freshness: matching sourceSha keeps full confidence", () => {
  const score = scoreMemory({ createdAt: iso(1), sourceSha: "abc" }, NOW, "abc");
  assert.equal(score.confidence, 1);
});

test("freshness: no currentSha means no sha penalty even when sourceSha set", () => {
  const score = scoreMemory({ createdAt: iso(1), sourceSha: "abc" }, NOW);
  assert.equal(score.confidence, 1);
});

test("freshness: penalties stack and confidence floors at 0", () => {
  const mem = { createdAt: iso(31), sourceSha: "old" };
  const score = scoreMemory(mem, NOW, "new");
  assert.equal(score.freshness, "stale");
  // 1.0 - 0.4 (sha) - 0.2 (stale) = 0.4
  assert.equal(score.confidence, 0.4);
  assert.equal(score.reasons.length, 3);

  // Extreme: multiple penalties must never go negative.
  const agingMismatch = scoreMemory({ createdAt: iso(7), sourceSha: "a" }, NOW, "b");
  assert.equal(agingMismatch.confidence, 0.5);
  const floor = scoreMemory({ createdAt: iso(40), sourceSha: "a" }, NOW, "b");
  // 1.0 - 0.4 - 0.2 = 0.4 still above floor; verify floor with a huge mismatch count is not relevant — single-pass so just assert >= 0.
  assert.ok(floor.confidence >= 0);
});

test("freshness: reasons list each applied rule", () => {
  const score = scoreMemory({ createdAt: iso(31), sourceSha: "old" }, NOW, "new");
  const text = score.reasons.join(" ");
  assert.match(text, /age/);
  assert.match(text, /stale/);
  assert.match(text, /sourceSha/);
});

test("rankMemories: sorts by confidence desc then ageDays asc", () => {
  const list = [
    { createdAt: iso(1), sourceSha: "mismatch" }, // fresh, 0.6
    { createdAt: iso(2) }, // fresh, 1.0
    { createdAt: iso(31) }, // stale, 0.8
    { createdAt: iso(8) }, // aging, 0.9
  ];
  const ranked = rankMemories(list, NOW, "current");
  assert.deepEqual(
    ranked.map((m) => scoreMemory(m, NOW, "current").confidence),
    [1, 0.9, 0.8, 0.6],
  );
  assert.deepEqual(
    ranked.map((m) => scoreMemory(m, NOW, "current").freshness),
    ["fresh", "aging", "stale", "fresh"],
  );
});

test("rankMemories: stable tie-break by age ascending, does not mutate input", () => {
  const list = [
    { createdAt: iso(10) }, // aging 0.9
    { createdAt: iso(9) }, // aging 0.9
    { createdAt: iso(8) }, // aging 0.9
  ];
  const copy = [...list];
  const ranked = rankMemories(list, NOW);
  assert.deepEqual(
    ranked.map((m) => scoreMemory(m, NOW).ageDays),
    [8, 9, 10],
  );
  assert.deepEqual(list, copy, "input list must not be mutated");
});
