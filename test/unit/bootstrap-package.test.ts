import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BootstrapItem,
  type BootstrapPackageInput,
  buildBootstrapPackage,
} from "../../src/context/bootstrapPackage.ts";

const NOW = 1_000_000;

function item(id: string, over: Partial<BootstrapItem> = {}): BootstrapItem {
  return {
    id,
    kind: "summary",
    tokens: 10,
    verified: true,
    updatedAtMs: NOW,
    required: false,
    ...over,
  };
}

function input(over: Partial<BootstrapPackageInput> = {}): BootstrapPackageInput {
  return {
    items: [],
    maxTokens: 1000,
    maxItems: 10,
    nowMs: NOW,
    maxAgeMs: 100_000,
    ...over,
  };
}

test("bootstrap package: empty items produce an all-empty package", () => {
  const result = buildBootstrapPackage(input());
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.totalTokens, 0);
  assert.deepEqual(result.reasons, []);
});

test("bootstrap package: a sensitive item is dropped even when required", () => {
  const result = buildBootstrapPackage(input({ items: [item("secret", { kind: "sensitive", required: true })] }));
  assert.deepEqual(result.dropped, [{ id: "secret", reason: "sensitive item never carried" }]);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.reasons, []);
});

test("bootstrap package: unverified items are dropped", () => {
  const result = buildBootstrapPackage(input({ items: [item("u", { verified: false })] }));
  assert.deepEqual(result.dropped, [{ id: "u", reason: "unverified item" }]);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.reasons, []);
});

test("bootstrap package: stale items are dropped and exactly-fresh items are included", () => {
  const stale = buildBootstrapPackage(input({ items: [item("stale", { updatedAtMs: NOW - 100_001 })] }));
  assert.deepEqual(stale.dropped, [{ id: "stale", reason: "stale item" }]);
  assert.deepEqual(stale.included, []);

  const fresh = buildBootstrapPackage(input({ items: [item("fresh", { updatedAtMs: NOW - 100_000 })] }));
  assert.deepEqual(fresh.dropped, []);
  assert.deepEqual(
    fresh.included.map((i) => i.id),
    ["fresh"],
  );

  // A future updatedAtMs is fresh.
  const future = buildBootstrapPackage(input({ items: [item("future", { updatedAtMs: NOW + 5000 })] }));
  assert.deepEqual(
    future.included.map((i) => i.id),
    ["future"],
  );
});

test("bootstrap package: kinds are ordered decision, file_ref, summary, raw_log", () => {
  const result = buildBootstrapPackage(
    input({
      items: [
        item("raw", { kind: "raw_log" }),
        item("sum", { kind: "summary" }),
        item("ref", { kind: "file_ref" }),
        item("dec", { kind: "decision" }),
      ],
    }),
  );
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["dec", "ref", "sum", "raw"],
  );
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.dropped, []);
});

test("bootstrap package: newest first within a kind, id ascending on ties", () => {
  const result = buildBootstrapPackage(
    input({
      items: [item("old", { updatedAtMs: NOW - 50 }), item("b", { updatedAtMs: NOW }), item("a", { updatedAtMs: NOW })],
    }),
  );
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["a", "b", "old"],
  );
});

test("bootstrap package: required items sort first even when raw_log and old-but-fresh", () => {
  const result = buildBootstrapPackage(
    input({
      items: [
        item("optional", { kind: "decision", updatedAtMs: NOW }),
        item("requiredOld", { kind: "raw_log", required: true, updatedAtMs: NOW - 99_999 }),
      ],
    }),
  );
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["requiredOld", "optional"],
  );
});

test("bootstrap package: a large item is deferred over token budget and a later small item still fits", () => {
  const result = buildBootstrapPackage(
    input({
      items: [item("a", { tokens: 60 }), item("b", { tokens: 60 }), item("c", { tokens: 30 })],
      maxTokens: 100,
    }),
  );
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["a", "c"],
  );
  assert.equal(result.totalTokens, 90);
  assert.deepEqual(result.deferred, [{ id: "b", reason: "over token budget" }]);
  assert.deepEqual(result.dropped, []);
});

test("bootstrap package: over item budget defers the third item and adds a lazy-retrieval reason", () => {
  const result = buildBootstrapPackage(input({ items: [item("a"), item("b"), item("c")], maxItems: 2 }));
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["a", "b"],
  );
  assert.deepEqual(result.deferred, [{ id: "c", reason: "over item budget" }]);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.reasons, ["deferred 1 items for lazy retrieval"]);
});

test("bootstrap package: a required item over budget is included with a reason and later items are deferred", () => {
  const result = buildBootstrapPackage(
    input({
      items: [item("big", { tokens: 200, required: true }), item("small", { tokens: 10 })],
      maxTokens: 100,
    }),
  );
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["big"],
  );
  assert.deepEqual(result.deferred, [{ id: "small", reason: "over token budget" }]);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.totalTokens, 200);
  assert.deepEqual(result.reasons, ["required item exceeds budget: big", "deferred 1 items for lazy retrieval"]);
});

test("bootstrap package: required items beyond maxItems are all included with one reason each", () => {
  const result = buildBootstrapPackage(
    input({
      items: [item("r1", { required: true }), item("r2", { required: true }), item("r3", { required: true })],
      maxItems: 2,
    }),
  );
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["r1", "r2", "r3"],
  );
  assert.equal(result.totalTokens, 30);
  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.reasons, ["required item exceeds budget: r3"]);
});

test("bootstrap package: undefined and false required sort as equal", () => {
  const a = item("a", { required: false });
  const b = item("b", { required: undefined });
  const first = buildBootstrapPackage(input({ items: [a, b] }));
  const second = buildBootstrapPackage(input({ items: [b, a] }));
  assert.deepEqual(
    first.included.map((i) => i.id),
    ["a", "b"],
  );
  assert.deepEqual(
    second.included.map((i) => i.id),
    ["a", "b"],
  );
});

test("bootstrap package: mixed sensitive, unverified, stale and survivors pack correctly", () => {
  const result = buildBootstrapPackage(
    input({
      items: [
        item("sensitive", { kind: "sensitive", required: true }),
        item("unverified", { verified: false }),
        item("stale", { updatedAtMs: NOW - 200_000 }),
        item("dec", { kind: "decision", tokens: 40 }),
        item("ref", { kind: "file_ref", tokens: 40 }),
        item("sum", { kind: "summary", tokens: 40 }),
      ],
      maxTokens: 100,
    }),
  );
  // Dropped in input order.
  assert.deepEqual(result.dropped, [
    { id: "sensitive", reason: "sensitive item never carried" },
    { id: "unverified", reason: "unverified item" },
    { id: "stale", reason: "stale item" },
  ]);
  // Packing order: decision, file_ref, then summary (which pushes over 100).
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["dec", "ref"],
  );
  assert.deepEqual(result.deferred, [{ id: "sum", reason: "over token budget" }]);
  assert.equal(result.totalTokens, 80);
  assert.deepEqual(result.reasons, ["deferred 1 items for lazy retrieval"]);
});

test("bootstrap package: NaN and negative token counts are dropped", () => {
  const result = buildBootstrapPackage(
    input({
      items: [item("nan", { tokens: Number.NaN }), item("neg", { tokens: -1 })],
    }),
  );
  assert.deepEqual(result.dropped, [
    { id: "nan", reason: "invalid token count" },
    { id: "neg", reason: "invalid token count" },
  ]);
  assert.deepEqual(result.included, []);
  assert.equal(result.totalTokens, 0);
});

test("bootstrap package: frozen input is not mutated", () => {
  const items = Object.freeze([
    Object.freeze(item("a", { required: true })),
    Object.freeze(item("b", { tokens: 50 })),
    Object.freeze(item("c")),
  ]);
  const inputObj = Object.freeze(input({ items, maxTokens: 20 }));
  const result = buildBootstrapPackage(inputObj);
  assert.deepEqual(
    result.included.map((i) => i.id),
    ["a", "c"],
  );
  assert.equal(result.totalTokens, 20);
  assert.deepEqual(result.deferred, [{ id: "b", reason: "over token budget" }]);
  assert.deepEqual(
    items.map((i) => i.tokens),
    [10, 50, 10],
  );
});
