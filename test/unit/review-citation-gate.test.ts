import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promotionCitationProblem } from "../../src/orchestration/broker.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { CLAIM_DISCIPLINE, buildSystemPrompt, wantsClaimDiscipline } from "../../src/workers/prompts.ts";

const FEED = "export const MAX_PAGE = 20;\nexport function drain(page) {\n  while (page) { page = next(page); }\n}\n";

function reviewerWorker(structured: Record<string, unknown>): WorkerExecutor {
  return {
    async run() {
      return {
        result: { status: "completed", summary: "ok", details: {} },
        structured,
        usage: { model: "reviewer" },
      } as never;
    },
  };
}

async function repoWithFeed(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-review-cite-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "feed.ts"), FEED, "utf8");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "feed"]);
  return root;
}

function approveWith(title: string): Record<string, unknown> {
  return {
    verdict: "approve",
    // A raw review finding must carry title + detail to parse (realBackends
    // validRawReviewFinding); the citation lives in the title, which is what the
    // normalized finding keeps as its summary.
    findings: [{ severity: "minor", title, detail: "read the cited line before writing this" }],
    missingTests: [],
    specGaps: [],
    acceptanceResults: [{ acceptanceId: "AC-1", status: "passed", detail: "observed the behaviour directly" }],
  };
}

async function review(root: string, structured: Record<string, unknown>) {
  const backends = realBackends({
    worker: reviewerWorker(structured),
    verifier: {} as never,
    artifacts: {} as never,
    git: null,
    cwd: root,
    reviewFallbackModel: { provider: "test", id: "reviewer" },
  });
  return backends.review.runReview({
    objective: "review the feed",
    worktree: root,
    acceptanceCriteria: [{ acceptanceId: "AC-1", criterion: "the feed drains" }],
    signal: new AbortController().signal,
  });
}

describe("review citation gate", () => {
  it("records the citation report and keeps the approval when every citation resolves", async () => {
    const root = await repoWithFeed();
    try {
      const outcome = await review(root, approveWith("the `next` call at feed.ts:3 advances the cursor"));
      const report = outcome.reviewEvidence?.citationReport;
      assert.deepEqual(
        report,
        { atRef: "worktree", checked: 1, resolved: 1, unresolved: [] },
        "the review's own citation was resolved against the tree it reviewed",
      );
      assert.equal(outcome.reviewEvidence?.verdict, "approve");
      assert.equal(outcome.reviewEvidence?.outputValid, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downgrades an approval whose citation points past the end of the file", async () => {
    const root = await repoWithFeed();
    try {
      const outcome = await review(root, approveWith("the `drain` loop at feed.ts:99 never checks abort"));
      const report = outcome.reviewEvidence?.citationReport;
      assert.equal(report?.checked, 1);
      assert.equal(report?.resolved, 0);
      assert.match(report?.unresolved[0] ?? "", /line 99 is past the file end \(4 lines\) at worktree/);
      assert.equal(outcome.reviewEvidence?.verdict, "request_changes", "a guess cannot carry an approval");
      assert.equal(outcome.reviewEvidence?.outputValid, true, "the review was readable; it just cannot approve");
      assert.ok(
        (outcome.reviewEvidence?.findings ?? []).some((finding) => finding.summary.startsWith("citations:")),
        "the downgrade says why",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downgrades an approval that cites a line which does not say what the finding claims", async () => {
    const root = await repoWithFeed();
    try {
      const outcome = await review(root, approveWith("the `revoked` notice at feed.ts:2 tells the user to rejoin"));
      assert.match(outcome.reviewEvidence?.citationReport?.unresolved[0] ?? "", /`revoked`/);
      assert.equal(outcome.reviewEvidence?.verdict, "request_changes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still records the report when the reviewer already requested changes", async () => {
    const root = await repoWithFeed();
    try {
      const outcome = await review(root, {
        verdict: "request_changes",
        findings: [
          {
            severity: "blocking",
            title: "the `drain` loop at feed.ts:99 never checks abort",
            detail: "read the cited line",
          },
        ],
        missingTests: [],
        specGaps: [],
        acceptanceResults: [],
      });
      assert.equal(outcome.reviewEvidence?.citationReport?.unresolved.length, 1);
      assert.equal(outcome.reviewEvidence?.verdict, "request_changes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks promotion on unresolved citations and stays silent otherwise", () => {
    const sha = "abc1234";
    assert.equal(promotionCitationProblem({ citationReport: undefined }, sha), null, "older evidence is untouched");
    assert.equal(
      promotionCitationProblem({ citationReport: { atRef: sha, checked: 2, resolved: 2, unresolved: [] } }, sha),
      null,
    );
    const problem = promotionCitationProblem(
      {
        citationReport: {
          atRef: sha,
          checked: 2,
          resolved: 1,
          unresolved: ["feed.ts:99: line 99 is past the file end"],
        },
      },
      sha,
    );
    assert.match(
      problem ?? "",
      new RegExp(`approving review of ${sha} cites 1 reference\\(s\\) that do not resolve at ${sha}`),
    );
  });
});

describe("claim discipline in the reviewer prompt", () => {
  it("goes to the roles whose findings carry a verdict", () => {
    for (const role of ["reviewer", "security-review", "architecture-reviewer", "performance-review"] as const) {
      assert.equal(wantsClaimDiscipline(role), true, role);
      assert.match(buildSystemPrompt(role, "review the candidate"), /Claim discipline:/);
    }
    for (const role of ["implementer", "scout", "planner", "clean-room-challenger"] as const) {
      assert.equal(wantsClaimDiscipline(role), false, role);
      assert.ok(!buildSystemPrompt(role, "do the work").includes("Claim discipline:"));
    }
  });

  it("says plainly that prose about behaviour is not evidence of it", () => {
    assert.match(CLAIM_DISCIPLINE, /CLAIM about behaviour, never evidence of it/);
    assert.match(CLAIM_DISCIPLINE, /claimed by <file>:<line> \(comment\), not probed/);
    assert.match(CLAIM_DISCIPLINE, /search the whole tree, read every hit/);
    assert.match(CLAIM_DISCIPLINE, /text the tool shows the user, removing that name is a defect/);
  });
});
