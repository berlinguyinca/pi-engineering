import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRun, MergeDecisionInput, MergeQueueItem, ReviewVerdict } from "../../src/merge/mergeGate.ts";
import { decideMerge } from "../../src/merge/mergeGate.ts";

/** Small builder for a check run. */
function check(name: string, status: CheckRun["status"], sha: string): CheckRun {
  return { name, status, sha };
}

/** Small builder for a queue item. */
function item(repo: string, pr: number, state: MergeQueueItem["state"], at: string): MergeQueueItem {
  return { repo, prNumber: pr, state, enqueuedAt: at };
}

const HEAD = "abc123";
const BASE = "base000";

function input(over: Partial<MergeDecisionInput> = {}): MergeDecisionInput {
  return {
    repo: "r",
    prNumber: 1,
    candidateSha: HEAD,
    prHeadSha: HEAD,
    baseSha: BASE,
    checks: [check("ci", "pass", HEAD)],
    requiredChecks: ["ci"],
    review: { verdict: "PASS", sha: HEAD },
    queue: [item("r", 1, "queued", "t0")],
    ...over,
  };
}

test("merge gate: happy path merges", () => {
  const decision = decideMerge(input());
  assert.equal(decision.decision, "merge");
  assert.deepEqual(decision.reasons, []);
  assert.deepEqual(decision.failureClasses, {});
});

test("merge gate: head != candidate rejects", () => {
  const decision = decideMerge(input({ candidateSha: "different" }));
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.reasons, [`candidate sha different != PR head ${HEAD}`]);
});

test("merge gate: stale review sha rejects", () => {
  const review: ReviewVerdict = { verdict: "PASS", sha: "other" };
  const decision = decideMerge(input({ review }));
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.reasons, [`review sha other != head ${HEAD}`]);
});

test("merge gate: stale check sha rejects", () => {
  const decision = decideMerge(input({ checks: [check("ci", "pass", "other"), check("lint", "pass", HEAD)] }));
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.reasons, [`check ci sha other != head ${HEAD}`]);
});

test("merge gate: failed check rejects with 'deterministic'", () => {
  const decision = decideMerge(input({ checks: [check("ci", "fail", HEAD)] }));
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.failureClasses, { ci: "deterministic" });
  assert.deepEqual(decision.reasons, ["check ci failed (deterministic)"]);
});

test("merge gate: failed check rejects with 'flaky'", () => {
  const decision = decideMerge(
    input({
      checks: [check("ci", "fail", HEAD)],
      baseline: { baseSha: BASE, failures: [], flaky: ["ci"] },
    }),
  );
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.failureClasses, { ci: "flaky" });
  assert.deepEqual(decision.reasons, ["check ci failed (flaky)"]);
});

test("merge gate: failed check rejects with 'base'", () => {
  const decision = decideMerge(
    input({
      checks: [check("ci", "fail", HEAD)],
      baseline: { baseSha: BASE, failures: ["ci"], flaky: [] },
    }),
  );
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.failureClasses, { ci: "base" });
  assert.deepEqual(decision.reasons, ["check ci failed (base)"]);
});

test("merge gate: baseline with a different baseSha does not yield 'base'", () => {
  const decision = decideMerge(
    input({
      checks: [check("ci", "fail", HEAD)],
      baseline: { baseSha: "other-base", failures: ["ci"], flaky: [] },
    }),
  );
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.failureClasses, { ci: "deterministic" });
  assert.deepEqual(decision.reasons, ["check ci failed (deterministic)"]);
});

test("merge gate: review FAIL rejects", () => {
  const review: ReviewVerdict = { verdict: "FAIL", sha: HEAD };
  const decision = decideMerge(input({ review }));
  assert.equal(decision.decision, "reject");
  assert.deepEqual(decision.reasons, ["review FAIL"]);
});

test("merge gate: review null waits", () => {
  const decision = decideMerge(input({ review: null }));
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, ["no review"]);
});

test("merge gate: missing required check waits", () => {
  const decision = decideMerge(input({ checks: [] }));
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, ["required check ci missing"]);
});

test("merge gate: pending required check waits", () => {
  const decision = decideMerge(input({ checks: [check("ci", "pending", HEAD)] }));
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, ["required check ci pending"]);
});

test("merge gate: skipped required check waits", () => {
  const decision = decideMerge(input({ checks: [check("ci", "skipped", HEAD)] }));
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, ["required check ci skipped"]);
});

test("merge gate: non-required skipped check does not block", () => {
  const decision = decideMerge(input({ checks: [check("ci", "pass", HEAD), check("optional", "skipped", HEAD)] }));
  assert.equal(decision.decision, "merge");
  assert.deepEqual(decision.reasons, []);
});

test("merge gate: same-repo merging waits", () => {
  const decision = decideMerge(
    input({
      queue: [item("r", 1, "queued", "t0"), item("r", 2, "merging", "t0")],
    }),
  );
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, ["repo r merging PR 2"]);
});

test("merge gate: earlier-queued same-repo waits", () => {
  const decision = decideMerge(
    input({
      queue: [item("r", 1, "queued", "t2"), item("r", 2, "queued", "t1")],
    }),
  );
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, ["PR 2 queued earlier"]);
});

test("merge gate: later-queued does not block", () => {
  const decision = decideMerge(
    input({
      queue: [item("r", 1, "queued", "t0"), item("r", 2, "queued", "t5")],
    }),
  );
  assert.equal(decision.decision, "merge");
  assert.deepEqual(decision.reasons, []);
});

test("merge gate: other-repo items never block", () => {
  const decision = decideMerge(
    input({
      queue: [item("r", 1, "queued", "t0"), item("other", 2, "merging", "t0"), item("other", 3, "queued", "t0")],
    }),
  );
  assert.equal(decision.decision, "merge");
  assert.deepEqual(decision.reasons, []);
});

test("merge gate: reasons order is stable", () => {
  // WAIT reasons are emitted in the fixed order: no review, missing required,
  // pending, skipped, merging, earlier queued.
  const decision = decideMerge(
    input({
      review: null,
      checks: [check("ci", "pending", HEAD), check("lint", "skipped", HEAD)],
      requiredChecks: ["ci", "lint", "missing"],
      queue: [item("r", 1, "queued", "t0"), item("r", 2, "merging", "t0"), item("r", 3, "queued", "t-1")],
    }),
  );
  assert.equal(decision.decision, "wait");
  assert.deepEqual(decision.reasons, [
    "no review",
    "required check missing missing",
    "required check ci pending",
    "required check lint skipped",
    "repo r merging PR 2",
    "PR 3 queued earlier",
  ]);
});

test("merge gate: input not mutated", () => {
  const before = input({
    checks: [check("ci", "fail", HEAD)],
    review: { verdict: "FAIL", sha: HEAD },
    baseline: { baseSha: BASE, failures: [], flaky: [] },
  });
  const snapshot = structuredClone(before);
  decideMerge(before);
  assert.deepEqual(before, snapshot);
});
