import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckRun, MergeDecisionInput } from "../../src/merge/mergeGate.ts";
import { decideMerge } from "../../src/merge/mergeGate.ts";
import {
  classifyCheckFailures,
  normalizeCheckRuns,
  type GhPrCheck,
  type RestCheckRun,
} from "../../src/merge/checkRunIngest.ts";

const HEAD = "abc123";
const BASE = "base000";

/** Builder for a normalized check run. */
function run(name: string, status: CheckRun["status"], sha = HEAD): CheckRun {
  return { name, status, sha };
}

/** Builder for a gh PR check bucket entry. */
function gh(name: string, over: Partial<GhPrCheck> = {}): GhPrCheck {
  return { name, bucket: "pass", ...over };
}

/** Builder for a REST check-run entry. */
function rest(name: string, over: Partial<RestCheckRun> = {}): RestCheckRun {
  return { name, status: "completed", conclusion: "success", ...over };
}

const ghBucketCases: Array<[bucket: string | undefined, expected: CheckRun["status"]]> = [
  ["pass", "pass"],
  ["fail", "fail"],
  ["cancel", "fail"],
  ["pending", "pending"],
  ["skipping", "skipped"],
  ["PASS", "pass"],
  ["FAIL", "fail"],
  ["Cancel", "fail"],
  ["weird", "fail"],
  [undefined, "fail"],
];

for (const [bucket, expected] of ghBucketCases) {
  test(`gh bucket '${String(bucket)}' maps to '${expected}'`, () => {
    const out = normalizeCheckRuns({ headSha: HEAD, ghChecks: [gh("ci", { bucket })] });
    assert.deepEqual(out, [run("ci", expected)]);
  });
}

const restConclusionCases: Array<[status: string, conclusion: string | null | undefined, expected: CheckRun["status"]]> = [
  ["completed", "success", "pass"],
  ["completed", "failure", "fail"],
  ["completed", "timed_out", "fail"],
  ["completed", "action_required", "fail"],
  ["completed", "cancelled", "fail"],
  ["completed", "skipped", "skipped"],
  ["completed", "neutral", "skipped"],
  ["completed", "stale", "pending"],
  ["completed", "some_other", "fail"],
  ["completed", null, "fail"],
  ["completed", undefined, "fail"],
  ["queued", undefined, "pending"],
  ["in_progress", undefined, "pending"],
  ["queued", "success", "pending"],
];

for (const [status, conclusion, expected] of restConclusionCases) {
  test(`rest status '${status}' + conclusion '${String(conclusion)}' maps to '${expected}'`, () => {
    const out = normalizeCheckRuns({ headSha: HEAD, restCheckRuns: [rest("ci", { status, conclusion })] });
    assert.deepEqual(out, [run("ci", expected)]);
  });
}

test("gh checks always use the input headSha (own head_sha ignored)", () => {
  const out = normalizeCheckRuns({ headSha: HEAD, ghChecks: [gh("ci", { head_sha: "other" })] });
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("rest checks use head_sha when non-empty, else fall back to headSha", () => {
  const withSha = normalizeCheckRuns({ headSha: HEAD, restCheckRuns: [rest("ci", { head_sha: "rest-sha" })] });
  assert.deepEqual(withSha, [run("ci", "pass", "rest-sha")]);
  const withoutSha = normalizeCheckRuns({ headSha: HEAD, restCheckRuns: [rest("ci", { head_sha: "" })] });
  assert.deepEqual(withoutSha, [run("ci", "pass", HEAD)]);
});

test("dedupe keeps the latest completedAt/startedAt date", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { completedAt: "2024-01-01T00:00:00Z" }),
      gh("ci", { completedAt: "2024-01-02T00:00:00Z" }),
    ],
  });
  // Later date wins; both gh use HEAD sha and 'pass'.
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe prefers completedAt over startedAt", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { startedAt: "2024-01-05T00:00:00Z" }),
      gh("ci", { completedAt: "2024-01-02T00:00:00Z" }),
    ],
  });
  // completedAt 01-02 is still the effective date (completedAt ?? startedAt),
  // so it wins over the later startedAt of the other entry.
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe treats empty and 0001- dates as absent (empty string)", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [gh("ci", { completedAt: "" }), gh("ci", { completedAt: "0001-01-01T00:00:00Z" })],
  });
  // Both normalize to ''; tie keeps the later input (the second one).
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe: a real date beats an empty date even when it comes first", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [gh("ci", { completedAt: "" }), gh("ci", { completedAt: "2024-01-02T00:00:00Z" })],
  });
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe: on an equal date tie, the later input wins (REST after gh)", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [gh("ci", { bucket: "pending", completedAt: "2024-01-01T00:00:00Z" })],
    restCheckRuns: [rest("ci", { conclusion: "failure", completed_at: "2024-01-01T00:00:00Z" })],
  });
  // Equal date: the REST entry comes later in input order and wins.
  assert.deepEqual(out, [run("ci", "fail", HEAD)]);
});

test("dedupe: gh with a later date wins over an earlier REST entry", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [gh("ci", { bucket: "pending", completedAt: "2024-01-02T00:00:00Z" })],
    restCheckRuns: [rest("ci", { conclusion: "failure", completed_at: "2024-01-01T00:00:00Z" })],
  });
  assert.deepEqual(out, [run("ci", "pending", HEAD)]);
});

test("output is sorted by name via localeCompare", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [gh("zeta"), gh("alpha"), gh("Beta")],
  });
  assert.deepEqual(
    out.map((r) => r.name),
    ["alpha", "Beta", "zeta"],
  );
});

test("entries with missing or non-string names are dropped", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [gh("ci"), { bucket: "pass" } as unknown as GhPrCheck, { name: 42 } as unknown as GhPrCheck, { name: "" } as GhPrCheck],
    restCheckRuns: [rest("lint"), { status: "completed" } as unknown as RestCheckRun, { name: 7 } as unknown as RestCheckRun],
  });
  assert.deepEqual(out, [run("ci", "pass", HEAD), run("lint", "pass", HEAD)]);
});

test("normalizeCheckRuns does not mutate its inputs", () => {
  const ghChecks: GhPrCheck[] = [
    gh("ci", { bucket: "pending", completedAt: "2024-01-02T00:00:00Z", head_sha: "gh-sha" }),
    gh("zeta", { bucket: "fail" }),
  ];
  const restCheckRuns: RestCheckRun[] = [rest("lint", { conclusion: "failure", head_sha: "rest-sha" })];
  const input = { headSha: HEAD, ghChecks, restCheckRuns };
  const snapshot = structuredClone(input);
  normalizeCheckRuns(input);
  assert.deepEqual(input, snapshot);
});

test("classify: deterministic when no baseline", () => {
  const checks = [run("ci", "fail"), run("lint", "pass")];
  assert.deepEqual(classifyCheckFailures(checks, BASE), { ci: "deterministic" });
});

test("classify: base when baseline matches the base sha and names the failure", () => {
  const checks = [run("ci", "fail")];
  const baseline = { baseSha: BASE, failures: ["ci"], flaky: [] };
  assert.deepEqual(classifyCheckFailures(checks, BASE, baseline), { ci: "base" });
});

test("classify: flaky when baseline lists it as flaky", () => {
  const checks = [run("ci", "fail")];
  const baseline = { baseSha: "other", failures: [], flaky: ["ci"] };
  assert.deepEqual(classifyCheckFailures(checks, BASE, baseline), { ci: "flaky" });
});

test("classify: deterministic when baseline has a different baseSha (even when it names the failure)", () => {
  const checks = [run("ci", "fail")];
  const baseline = { baseSha: "other-base", failures: ["ci"], flaky: [] };
  assert.deepEqual(classifyCheckFailures(checks, BASE, baseline), { ci: "deterministic" });
});

test("classify: only status 'fail' is classified", () => {
  const checks = [run("ci", "fail"), run("lint", "pending"), run("fmt", "skipped"), run("ok", "pass")];
  const baseline = { baseSha: BASE, failures: ["ci", "lint"], flaky: ["fmt"] };
  assert.deepEqual(classifyCheckFailures(checks, BASE, baseline), { ci: "base" });
});

test("PARITY: classifyCheckFailures matches decideMerge.failureClasses", () => {
  const checks = [run("ci", "fail"), run("lint", "fail")];
  const baseline = { baseSha: BASE, failures: ["ci"], flaky: ["lint"] };

  const fromClassifier = classifyCheckFailures(checks, BASE, baseline);

  const input: MergeDecisionInput = {
    repo: "r",
    prNumber: 1,
    candidateSha: HEAD,
    prHeadSha: HEAD,
    baseSha: BASE,
    checks,
    requiredChecks: [],
    review: { verdict: "PASS", sha: HEAD },
    queue: [],
    baseline,
  };
  const decision = decideMerge(input);

  assert.deepEqual(fromClassifier, decision.failureClasses);
  assert.deepEqual(fromClassifier, { ci: "base", lint: "flaky" });
});
