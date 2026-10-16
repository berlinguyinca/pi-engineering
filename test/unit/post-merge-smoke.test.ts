import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckFailureBaseline } from "../../src/merge/checkRunIngest.ts";
import type { CheckRun } from "../../src/merge/mergeGate.ts";
import { type PostMergeSmokeInput, decidePostMergeSmoke } from "../../src/merge/postMergeSmoke.ts";

const MERGE = "m1";
const PARENT = "p0";

/** Builder for a check run. */
function check(name: string, status: CheckRun["status"], sha: string): CheckRun {
  return { name, status, sha };
}

/** Builder for the post-merge smoke input. */
function input(over: Partial<PostMergeSmokeInput> = {}): PostMergeSmokeInput {
  return {
    mergeSha: MERGE,
    prNumber: 1,
    parentSha: PARENT,
    mainChecks: [check("ci", "pass", MERGE)],
    requiredChecks: ["ci"],
    rerunCount: 0,
    maxReruns: 0,
    ...over,
  };
}

test("post-merge smoke: confirmed happy path", () => {
  const result = decidePostMergeSmoke(input());
  assert.equal(result.decision, "confirmed");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.failureClasses, {});
  assert.deepEqual(result.preExisting, []);
  assert.deepEqual(result.introduced, []);
});

test("post-merge smoke: missing required check is pending", () => {
  const result = decidePostMergeSmoke(input({ mainChecks: [] }));
  assert.equal(result.decision, "pending");
  assert.deepEqual(result.reasons, ["required check ci missing"]);
  assert.deepEqual(result.failureClasses, {});
  assert.deepEqual(result.preExisting, []);
  assert.deepEqual(result.introduced, []);
});

test("post-merge smoke: pending required check is pending", () => {
  const result = decidePostMergeSmoke(input({ mainChecks: [check("ci", "pending", MERGE)] }));
  assert.equal(result.decision, "pending");
  assert.deepEqual(result.reasons, ["required check ci pending"]);
});

test("post-merge smoke: skipped required check is pending", () => {
  const result = decidePostMergeSmoke(input({ mainChecks: [check("ci", "skipped", MERGE)] }));
  assert.equal(result.decision, "pending");
  assert.deepEqual(result.reasons, ["required check ci skipped"]);
});

test("post-merge smoke: a passing run on the wrong sha counts as missing", () => {
  const result = decidePostMergeSmoke(input({ mainChecks: [check("ci", "pass", PARENT)] }));
  assert.equal(result.decision, "pending");
  assert.deepEqual(result.reasons, ["required check ci missing"]);
});

test("post-merge smoke: deterministic failure reverts with revertTarget", () => {
  const result = decidePostMergeSmoke(input({ mainChecks: [check("ci", "fail", MERGE)] }));
  assert.equal(result.decision, "revert");
  assert.deepEqual(result.revertTarget, { sha: MERGE, prNumber: 1 });
  assert.deepEqual(result.reasons, ["check ci failed (deterministic)"]);
  assert.deepEqual(result.introduced, ["ci"]);
  assert.deepEqual(result.preExisting, []);
});

test("post-merge smoke: flaky failure reruns when rerun budget allows", () => {
  const baseline: CheckFailureBaseline = { baseSha: PARENT, failures: [], flaky: ["ci"] };
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("ci", "fail", MERGE)],
      baseline,
      rerunCount: 0,
      maxReruns: 2,
    }),
  );
  assert.equal(result.decision, "rerun");
  assert.deepEqual(result.reasons, ["check ci failed (flaky)"]);
  assert.deepEqual(result.introduced, ["ci"]);
});

test("post-merge smoke: flaky failure with exhausted rerun budget reverts", () => {
  const baseline: CheckFailureBaseline = { baseSha: PARENT, failures: [], flaky: ["ci"] };
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("ci", "fail", MERGE)],
      baseline,
      rerunCount: 2,
      maxReruns: 2,
    }),
  );
  assert.equal(result.decision, "revert");
  assert.deepEqual(result.revertTarget, { sha: MERGE, prNumber: 1 });
  assert.deepEqual(result.reasons, ["check ci failed (flaky)", "rerun budget exhausted (2/2)"]);
});

test("post-merge smoke: failure also failing at parent is confirmed as preexisting", () => {
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("ci", "fail", MERGE)],
      preMergeMainChecks: [check("ci", "fail", PARENT)],
    }),
  );
  assert.equal(result.decision, "confirmed");
  assert.deepEqual(result.reasons, ["check ci failed before merge (preexisting)"]);
  assert.deepEqual(result.preExisting, ["ci"]);
  assert.deepEqual(result.introduced, []);
});

test("post-merge smoke: baseline base failure is confirmed", () => {
  const baseline: CheckFailureBaseline = { baseSha: PARENT, failures: ["ci"], flaky: [] };
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("ci", "fail", MERGE)],
      baseline,
    }),
  );
  assert.equal(result.decision, "confirmed");
  assert.deepEqual(result.reasons, ["check ci failed before merge (preexisting)"]);
  assert.deepEqual(result.preExisting, ["ci"]);
});

test("post-merge smoke: baseline with mismatched baseSha is deterministic and reverts", () => {
  const baseline: CheckFailureBaseline = { baseSha: "other-base", failures: ["ci"], flaky: [] };
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("ci", "fail", MERGE)],
      baseline,
    }),
  );
  assert.equal(result.decision, "revert");
  assert.deepEqual(result.revertTarget, { sha: MERGE, prNumber: 1 });
  assert.deepEqual(result.failureClasses, { ci: "deterministic" });
  assert.deepEqual(result.reasons, ["check ci failed (deterministic)"]);
});

test("post-merge smoke: reasons order is stable", () => {
  const baseline: CheckFailureBaseline = { baseSha: PARENT, failures: ["lint"], flaky: ["unit"] };
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("lint", "fail", MERGE), check("unit", "fail", MERGE), check("build", "fail", MERGE)],
      requiredChecks: ["build", "lint", "unit"],
      baseline,
      preMergeMainChecks: [check("lint", "fail", PARENT)],
      rerunCount: 1,
      maxReruns: 1,
    }),
  );
  assert.equal(result.decision, "revert");
  assert.deepEqual(result.reasons, [
    "check build failed (deterministic)",
    "check lint failed before merge (preexisting)",
    "check unit failed (flaky)",
  ]);
  assert.deepEqual(result.failureClasses, { build: "deterministic", lint: "base", unit: "flaky" });
  assert.deepEqual(result.preExisting, ["lint"]);
  assert.deepEqual(result.introduced, ["build", "unit"]);
});

test("post-merge smoke: input is not mutated", () => {
  const before = input({
    mainChecks: [check("ci", "fail", MERGE)],
    requiredChecks: ["ci", "lint"],
    baseline: { baseSha: PARENT, failures: [], flaky: ["ci"] },
    rerunCount: 2,
    maxReruns: 2,
  });
  const snapshot = structuredClone(before);
  decidePostMergeSmoke(before);
  assert.deepEqual(before, snapshot);
});

test("post-merge smoke: non-finite rerun budget treats maxReruns as zero", () => {
  const baseline: CheckFailureBaseline = { baseSha: PARENT, failures: [], flaky: ["ci"] };
  const result = decidePostMergeSmoke(
    input({
      mainChecks: [check("ci", "fail", MERGE)],
      baseline,
      rerunCount: Number.NaN,
      maxReruns: 2,
    }),
  );
  assert.equal(result.decision, "revert");
  assert.deepEqual(result.reasons, ["check ci failed (flaky)", "rerun budget exhausted (NaN/2)"]);
});
