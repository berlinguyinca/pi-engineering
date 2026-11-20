import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GhPrCheck,
  type RestCheckRun,
  type RestCommitStatus,
  classifyCheckFailures,
  normalizeCheckRuns,
} from "../../src/merge/checkRunIngest.ts";
import type { CheckRun, MergeDecisionInput } from "../../src/merge/mergeGate.ts";
import { decideMerge } from "../../src/merge/mergeGate.ts";

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

const restConclusionCases: Array<
  [status: string, conclusion: string | null | undefined, expected: CheckRun["status"]]
> = [
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
  ["waiting", undefined, "pending"],
  ["requested", undefined, "pending"],
  ["pending", undefined, "pending"],
];

for (const [status, conclusion, expected] of restConclusionCases) {
  test(`rest status '${status}' + conclusion '${String(conclusion)}' maps to '${expected}'`, () => {
    const out = normalizeCheckRuns({ headSha: HEAD, restCheckRuns: [rest("ci", { status, conclusion })] });
    assert.deepEqual(out, [run("ci", expected)]);
  });
}

test("gh checks always use the input headSha", () => {
  const out = normalizeCheckRuns({ headSha: HEAD, ghChecks: [gh("ci", { bucket: "fail" })] });
  assert.deepEqual(out, [run("ci", "fail", HEAD)]);
});

test("rest checks use head_sha when non-empty, else fall back to headSha", () => {
  const withSha = normalizeCheckRuns({ headSha: HEAD, restCheckRuns: [rest("ci", { head_sha: "rest-sha" })] });
  assert.deepEqual(withSha, [run("ci", "pass", "rest-sha")]);
  const withoutSha = normalizeCheckRuns({ headSha: HEAD, restCheckRuns: [rest("ci", { head_sha: "" })] });
  assert.deepEqual(withoutSha, [run("ci", "pass", HEAD)]);
});

test("dedupe keeps the latest completedAt date", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { bucket: "pending", completedAt: "2024-01-01T00:00:00Z" }),
      gh("ci", { bucket: "pass", completedAt: "2024-01-02T00:00:00Z" }),
    ],
  });
  // The later completedAt (01-02) wins, so the kept entry reports 'pass'.
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe prefers completedAt over startedAt when both are present", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { bucket: "pending", completedAt: "2024-01-05T00:00:00Z", startedAt: "2024-01-01T00:00:00Z" }),
      gh("ci", { bucket: "pass", completedAt: "2024-01-02T00:00:00Z", startedAt: "2024-01-10T00:00:00Z" }),
    ],
  });
  // Each entry's date is completedAt ?? startedAt; the second entry's later
  // startedAt (01-10) is ignored because it has a completedAt, so the first
  // entry (01-05) wins and the kept status is 'pending'.
  assert.deepEqual(out, [run("ci", "pending", HEAD)]);
});

test("dedupe treats empty and 0001- dates as absent (empty string)", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { bucket: "pending", completedAt: "" }),
      gh("ci", { bucket: "pass", completedAt: "0001-01-01T00:00:00Z" }),
    ],
  });
  // Both normalize to ''; the tie keeps the later input (the 'pass' one).
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe: a real date beats an empty date even when it comes first", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { bucket: "pending", completedAt: "" }),
      gh("ci", { bucket: "pass", completedAt: "2024-01-02T00:00:00Z" }),
    ],
  });
  // The real completedAt (01-02) beats the empty date; kept status is 'pass'.
  assert.deepEqual(out, [run("ci", "pass", HEAD)]);
});

test("dedupe: a 0001- completedAt does NOT fall back to startedAt (regression)", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    ghChecks: [
      gh("ci", { bucket: "pending", completedAt: "0001-01-01T00:00:00Z", startedAt: "2024-01-05T00:00:00Z" }),
      gh("ci", { bucket: "pass", completedAt: "2024-01-02T00:00:00Z" }),
    ],
  });
  // The 0001- completedAt normalises to '' and must NOT fall back to startedAt
  // (01-05), so entry B's real completedAt (01-02) wins. Kept entry is B ('pass').
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

test("dedupe: REST completed_at ?? started_at (0001- completed_at does not fall back)", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    restCheckRuns: [
      rest("ci", {
        head_sha: "sha-a",
        status: "in_progress",
        completed_at: "0001-01-01T00:00:00Z",
        started_at: "2024-01-05T00:00:00Z",
      }),
      rest("ci", { head_sha: "sha-b", conclusion: "success", completed_at: "2024-01-02T00:00:00Z" }),
    ],
  });
  // Entry A's 0001- completed_at normalises to '' and must NOT fall back to its
  // started_at (01-05), so B's real completed_at (01-02) wins. Kept sha is B's.
  assert.deepEqual(out, [run("ci", "pass", "sha-b")]);
});

test("status/conclusion comparison is case-sensitive (SUCCESS on completed -> fail)", () => {
  const out = normalizeCheckRuns({
    headSha: HEAD,
    restCheckRuns: [rest("ci", { status: "completed", conclusion: "SUCCESS" })],
  });
  // Only lowercase 'success' maps to 'pass'; 'SUCCESS' falls through to 'fail'.
  assert.deepEqual(out, [run("ci", "fail", HEAD)]);
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
    ghChecks: [
      gh("ci"),
      { bucket: "pass" } as unknown as GhPrCheck,
      { name: 42 } as unknown as GhPrCheck,
      { name: "" } as GhPrCheck,
    ],
    restCheckRuns: [
      rest("lint"),
      { status: "completed" } as unknown as RestCheckRun,
      { name: 7 } as unknown as RestCheckRun,
    ],
  });
  assert.deepEqual(out, [run("ci", "pass", HEAD), run("lint", "pass", HEAD)]);
});

test("normalizeCheckRuns does not mutate its inputs", () => {
  const ghChecks: GhPrCheck[] = [
    gh("ci", { bucket: "pending", completedAt: "2024-01-02T00:00:00Z" }),
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

// --- #722: Woodpecker publishes commit STATUSES, and nothing read them ----------
//
// `GET /commits/{sha}/check-runs` lists GitGuardian and nothing else; the
// pipeline result arrives as a commit STATUS named `ci/woodpecker/pr/ci`. Ingesting
// only check runs meant a head with one green GitGuardian run looked like CI evidence
// while the pipeline had never run.

/** Builder for a REST commit-status entry. */
function status(context: string, state: string, over: Partial<RestCommitStatus> = {}): RestCommitStatus {
  return { context, state, ...over };
}

const asPairs = (runs: readonly CheckRun[]) => runs.map((r) => [r.name, r.status, r.sha]);

test("#722: a commit status becomes a CheckRun named by its context", () => {
  const runs = normalizeCheckRuns({
    headSha: HEAD,
    restStatuses: [
      status("ci/woodpecker/pr/ci", "success", { sha: HEAD, target_url: "https://ci/pipeline/341/1" }),
      status("ci/pending", "pending"),
      status("ci/fails", "failure"),
      status("ci/errors", "error"),
      status("ci/mystery", "waiting_for_review"),
    ],
  });
  // An unknown state is a failure, not a pass: the gate fails closed.
  assert.deepEqual(asPairs(runs), [
    ["ci/errors", "fail", HEAD],
    ["ci/fails", "fail", HEAD],
    ["ci/mystery", "fail", HEAD],
    ["ci/pending", "pending", HEAD],
    ["ci/woodpecker/pr/ci", "pass", HEAD],
  ]);
});

test("#722: the newest status wins, so a superseded run's error cannot mask a later pass", () => {
  const older = status("ci/woodpecker/pr/ci", "failure", {
    description: "Pipeline failed",
    updated_at: "2026-11-20T01:00:00Z",
  });
  const newer = status("ci/woodpecker/pr/ci", "success", {
    description: "Pipeline was successful",
    updated_at: "2026-11-20T02:00:00Z",
  });
  for (const restStatuses of [
    [older, newer],
    [newer, older],
  ]) {
    const runs = normalizeCheckRuns({ headSha: HEAD, restStatuses });
    assert.equal(runs.length, 1, "one entry per context");
    assert.equal(runs[0]?.status, "pass", "the later updated_at wins whichever order the API returns");
  }
});

test("#722: created_at is the date when a status carries no updated_at", () => {
  const runs = normalizeCheckRuns({
    headSha: HEAD,
    restStatuses: [
      status("ci", "success", { updated_at: "2026-11-20T05:00:00Z", created_at: "2026-11-20T04:00:00Z" }),
      status("ci", "failure", { created_at: "2026-11-20T06:00:00Z" }),
    ],
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "fail", "the undated-in-updated_at entry is still dated by created_at");
});

test("#722: statuses merge with check runs by name, and a status for another commit keeps that sha", () => {
  const runs = normalizeCheckRuns({
    headSha: HEAD,
    restCheckRuns: [rest("ci", { status: "completed", conclusion: "failure", completed_at: "2026-11-20T01:00:00Z" })],
    restStatuses: [status("ci", "success", { updated_at: "2026-11-20T02:00:00Z" })],
  });
  assert.deepEqual(asPairs(runs), [["ci", "pass", HEAD]]);

  const stale = normalizeCheckRuns({ headSha: HEAD, restStatuses: [status("ci", "success", { sha: "deadbeef" })] });
  assert.deepEqual(asPairs(stale), [["ci", "pass", "deadbeef"]], "the gate rejects a check for another commit");

  const unnamed = normalizeCheckRuns({ headSha: HEAD, restStatuses: [{ state: "success" } as RestCommitStatus] });
  assert.deepEqual(unnamed, [], "an entry with no context is dropped");
});

test("#722: decideMerge waits while an ingested status is still pending", () => {
  const checks = normalizeCheckRuns({
    headSha: HEAD,
    restCheckRuns: [rest("GitGuardian Security Checks")],
    restStatuses: [status("ci/woodpecker/pr/ci", "pending")],
  });
  const decision = decideMerge({
    repo: "r",
    prNumber: 1,
    candidateSha: HEAD,
    prHeadSha: HEAD,
    baseSha: BASE,
    checks,
    requiredChecks: ["GitGuardian Security Checks", "ci/woodpecker/pr/ci"],
    review: { verdict: "PASS", sha: HEAD },
    queue: [],
  });
  assert.equal(decision.decision, "wait");
  assert.ok(
    decision.reasons.some((r) => r.includes("ci/woodpecker/pr/ci") && r.includes("pending")),
    `reasons: ${decision.reasons.join(" | ")}`,
  );
});
