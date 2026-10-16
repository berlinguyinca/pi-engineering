import assert from "node:assert/strict";
import { test } from "node:test";
import { type RecallCandidate, type RecallGateInput, selectRecallForPackage } from "../../src/context/recallGate.ts";
import { redactSecrets } from "../../src/platform/redact.ts";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-01-15T00:00:00Z");
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

function makeInput(overrides?: Partial<RecallGateInput>): RecallGateInput {
  return {
    candidates: [],
    now: NOW,
    minConfidence: 0,
    redact: redactSecrets,
    maxItems: 10,
    ...overrides,
  };
}

function candidate(overrides?: Partial<RecallCandidate>): RecallCandidate {
  return {
    id: "rec-1",
    text: "remember this fact",
    sourceRefs: ["file:src/index.ts"],
    promotedFrom: "session-abc",
    evidenceIds: ["ev-1"],
    promotedAt: iso(2),
    promotedBy: "worker-x",
    ...overrides,
  };
}

test("context-recall-gate: a fresh record is kept with provenance fields populated", () => {
  const input = makeInput({ candidates: [candidate()] });
  const result = selectRecallForPackage(input);
  assert.equal(result.kept.length, 1);
  const kept = result.kept[0]!;
  assert.equal(kept.id, "rec-1");
  assert.equal(kept.text, "remember this fact");
  assert.deepEqual(kept.sourceRefs, ["file:src/index.ts"]);
  assert.deepEqual(kept.evidenceIds, ["ev-1"]);
  assert.equal(kept.provenance.source, "session-abc");
  assert.equal(kept.provenance.promotedAt, iso(2));
  assert.equal(kept.provenance.recalledAt, NOW.toISOString());
  assert.equal(kept.provenance.freshness, "fresh");
  assert.equal(kept.provenance.confidence, 1);
  assert.deepEqual(result.dropped, []);
});

test("context-recall-gate: a 40-day-old record is dropped as stale", () => {
  const input = makeInput({ candidates: [candidate({ promotedAt: iso(40) })] });
  const result = selectRecallForPackage(input);
  assert.deepEqual(result.dropped, [{ id: "rec-1", reason: "stale" }]);
  assert.deepEqual(result.kept, []);
});

test("context-recall-gate: dropStale false keeps a stale record with freshness 'stale'", () => {
  const input = makeInput({ candidates: [candidate({ promotedAt: iso(40) })], dropStale: false });
  const result = selectRecallForPackage(input);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]!.provenance.freshness, "stale");
  assert.equal(result.kept[0]!.provenance.confidence, 0.8);
});

test("context-recall-gate: SHA mismatch with minConfidence 0.7 drops as low_confidence", () => {
  const input = makeInput({
    candidates: [candidate({ sourceSha: "abc" })],
    currentSha: "def",
    minConfidence: 0.7,
  });
  const result = selectRecallForPackage(input);
  // fresh + sha mismatch => confidence 0.6 < 0.7
  assert.deepEqual(result.dropped, [{ id: "rec-1", reason: "low_confidence" }]);
});

test("context-recall-gate: requiredRefPrefixes drops a record whose refs lack it", () => {
  const input = makeInput({
    candidates: [candidate({ sourceRefs: ["session:other"] })],
    requiredRefPrefixes: ["file:"],
  });
  const result = selectRecallForPackage(input);
  assert.deepEqual(result.dropped, [{ id: "rec-1", reason: "missing_ref" }]);
});

test("context-recall-gate: bare secret alone is redacted_empty, keyed secret is kept redacted", () => {
  const bare = makeInput({ candidates: [candidate({ id: "bare", text: "sk-abcdefghijklmnopqrstuvwxyz0123" })] });
  const bareResult = selectRecallForPackage(bare);
  assert.deepEqual(bareResult.dropped, [{ id: "bare", reason: "redacted_empty" }]);

  const keyed = makeInput({
    candidates: [candidate({ id: "keyed", text: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123" })],
  });
  const keyedResult = selectRecallForPackage(keyed);
  assert.equal(keyedResult.kept.length, 1);
  assert.equal(keyedResult.kept[0]!.text, "OPENAI_API_KEY=[REDACTED]");
  assert.ok(!keyedResult.kept[0]!.text.includes("sk-abcdef"), "kept text must not contain the secret");
});

test("context-recall-gate: texts differing only in case/whitespace dedupe to one kept, one duplicate", () => {
  const input = makeInput({
    candidates: [
      candidate({ id: "a", text: "Hello   World", sourceRefs: ["file:a"] }),
      candidate({ id: "b", text: "  hello world ", sourceRefs: ["file:b"] }),
    ],
  });
  const result = selectRecallForPackage(input);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]!.id, "a");
  assert.deepEqual(result.dropped, [{ id: "b", reason: "duplicate" }]);
});

test("context-recall-gate: maxItems 1 with two good records drops one as over_limit", () => {
  const input = makeInput({
    candidates: [candidate({ id: "a", text: "first fact" }), candidate({ id: "b", text: "second fact" })],
    maxItems: 1,
  });
  const result = selectRecallForPackage(input);
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0]!.reason, "over_limit");
});

test("context-recall-gate: ordering is deterministic across shuffled input", () => {
  const base = [
    candidate({ id: "a", text: "alpha", promotedAt: iso(5) }),
    candidate({ id: "b", text: "beta", promotedAt: iso(2) }),
    candidate({ id: "c", text: "gamma", promotedAt: iso(9) }),
    candidate({ id: "d", text: "delta", promotedAt: iso(1), sourceSha: "x" }),
  ];
  const shuffled = [base[2]!, base[0]!, base[3]!, base[1]!];
  const r1 = selectRecallForPackage(makeInput({ candidates: base }));
  const r2 = selectRecallForPackage(makeInput({ candidates: shuffled }));
  assert.deepEqual(
    r1.kept.map((k) => k.id),
    r2.kept.map((k) => k.id),
  );
  // deterministic rank: confidence desc, then ageDays asc
  assert.deepEqual(
    r1.kept.map((k) => k.id),
    ["d", "b", "a", "c"],
  );
});

test("context-recall-gate: input is not mutated", () => {
  const candidates = [candidate(), candidate({ id: "b", text: "other" })];
  const before = JSON.parse(JSON.stringify(candidates));
  selectRecallForPackage(makeInput({ candidates }));
  assert.deepEqual(candidates, before);
});

test("context-recall-gate: unparseable promotedAt is treated as stale", () => {
  const input = makeInput({ candidates: [candidate({ promotedAt: "not-a-date" })] });
  const result = selectRecallForPackage(input);
  assert.deepEqual(result.dropped, [{ id: "rec-1", reason: "stale" }]);
});

test("context-recall-gate: sourceRefs are redacted", () => {
  const input = makeInput({
    candidates: [candidate({ sourceRefs: ["file:a?token=sk-abcdefghijklmnopqrstuvwxyz0123"] })],
  });
  const result = selectRecallForPackage(input);
  assert.equal(result.kept.length, 1);
  assert.ok(!result.kept[0]!.sourceRefs.join(" ").includes("sk-abcdef"), "redacted ref must not leak secret");
});
