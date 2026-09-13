import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AdversarialHarness,
  type MutationHarness,
  boundaryCases,
  compareTiming,
  differentialTest,
  generateMutants,
  generatePropertySkeleton,
  impactedTests,
  measurePerformance,
  runAdversarialGate,
  runMutationSuite,
} from "../../src/verify/farm/index.ts";

test("farm: impactedTests maps changed source to conventional test", () => {
  const res = impactedTests(
    ["src/math/add.ts"],
    [{ path: "test/math/add.test.ts", content: 'import { add } from "../src/math/add.ts"' }],
  );
  assert.ok(res.some((t) => t.path === "test/math/add.test.ts" && t.reason === "convention"));
});

test("farm: impactedTests catches transitive importers", () => {
  const tests = [
    { path: "test/a.test.ts", content: 'import { x } from "../src/math/add.ts"' },
    { path: "test/b.test.ts", content: "describe('b', () => {});" },
  ];
  const res = impactedTests(["src/math/add.ts"], tests);
  assert.ok(res.some((t) => t.path === "test/a.test.ts" && t.reason === "import"));
  assert.ok(!res.some((t) => t.path === "test/b.test.ts"));
});

test("farm: generateMutants produces arithmetic + comparison mutants", () => {
  const src = "function f(n) { return n > 0 ? n + 1 : 0; }";
  const mutants = generateMutants("x.ts", src);
  assert.ok(mutants.some((m) => m.operator === "comparison"));
  assert.ok(mutants.some((m) => m.operator === "arithmetic"));
  assert.ok(mutants.every((m) => m.source !== src));
});

test("farm: runMutationSuite computes kill rate", async () => {
  const src = "function isEven(n) { return n % 2 === 0; }";
  const harness: MutationHarness = { runTests: async (s) => ({ killed: s.includes("!== 0") }) };
  const report = await runMutationSuite(src, "isEven.ts", harness);
  assert.ok(report.mutants > 0);
  assert.ok(report.killed >= 1);
  assert.ok(report.killRate > 0 && report.killRate <= 1);
});

test("farm: generatePropertySkeleton scaffolds checks for an even invariant", () => {
  const skel = generatePropertySkeleton({
    target: "../src/isEven.ts",
    fn: "isEven",
    invariant: "returns true for all even integers",
    generator: "n",
  });
  assert.match(skel, /isEven/);
  assert.match(skel, /% 2 === 0/);
});

test("farm: runAdversarialGate only accepts passing, executed tests", async () => {
  const harness: AdversarialHarness = {
    runProposal: async (p) => ({ pass: p.claim.includes("good"), executed: true }),
  };
  const report = await runAdversarialGate(
    [
      { target: "f", testSource: "a", claim: "good boundary" },
      { target: "f", testSource: "b", claim: "bad hallucinated" },
    ],
    harness,
  );
  assert.equal(report.accepted, 1);
  assert.equal(report.rejected, 1);
  assert.equal(report.gatePass, true);
});

test("farm: boundaryCases are deterministic for a target", () => {
  const a = boundaryCases("isEven");
  const b = boundaryCases("isEven");
  assert.deepEqual(a, b);
  assert.ok(a.some((c) => c.label === "zero"));
});

test("farm: compareTiming flags regression over tolerance", () => {
  assert.equal(compareTiming("t", 100, { label: "t", durationMs: 100 }), null);
  assert.ok(compareTiming("t", 150, { label: "t", durationMs: 100, tolerance: 0.2 }));
  assert.equal(compareTiming("t", 110, { label: "t", durationMs: 100, tolerance: 0.2 }), null);
});

test("farm: measurePerformance fails on any regression", async () => {
  const res = await measurePerformance([{ label: "fast", baseline: { label: "fast", durationMs: 100 } }], {
    run: async () => ({ label: "fast", durationMs: 300 }),
  });
  assert.equal(res.pass, false);
  assert.equal(res.regressions.length, 1);
});

test("farm: differentialTest flags mismatched outputs", async () => {
  const ref = { run: async (i: string) => ({ stdout: `ref:${i}` }) };
  const cand = { run: async (i: string) => ({ stdout: `ref:${i}` }) };
  const report = await differentialTest(
    [
      { id: "1", input: "a" },
      { id: "2", input: "b" },
    ],
    ref,
    cand,
  );
  assert.equal(report.pass, true);
  assert.equal(report.matched, 2);

  const badCand = { run: async (i: string) => ({ stdout: `other:${i}` }) };
  const bad = await differentialTest([{ id: "1", input: "a" }], ref, badCand);
  assert.equal(bad.pass, false);
  assert.equal(bad.mismatched, 1);
});
