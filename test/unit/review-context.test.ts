import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REVIEW_DIFF_CHAR_CAP, buildReviewContext } from "../../src/orchestration/reviewContext.ts";

function repo(): { dir: string; base: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-ctx-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { dir, base: git("rev-parse", "HEAD"), git };
}

const criteria = [
  { acceptanceId: "AC-1", criterion: "adds greeting" },
  { acceptanceId: "AC-2", criterion: "tests pass" },
];

test("review context carries the diff, validation, worker summaries and an ID template", async () => {
  const { dir, base, git } = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    git("commit", "-qam", "change");
    const candidate = git("rev-parse", "HEAD");
    const text = await buildReviewContext({
      repoRoot: dir,
      baseSha: base,
      candidateSha: candidate,
      criteria,
      validation: {
        state: "finished",
        passed: false,
        stages: [
          { name: "typecheck", passed: true },
          { name: "test", passed: false },
        ],
        failureOutput: `${"noise\n".repeat(1000)}AssertionError: expected 1 got 2`,
      },
      workerSummaries: [{ taskId: "TSK-1", summary: "added a second line" }],
    });
    assert.match(text, /\+two/);
    assert.match(text, /- test: FAIL/);
    assert.match(text, /AssertionError: expected 1 got 2/);
    assert.ok(text.length < 10_000, "failing output is trimmed to its tail");
    assert.match(text, /TSK-1: added a second line/);
    assert.match(text, /- AC-2: tests pass/);
    assert.match(text, /"acceptanceId": "AC-1"/);
    assert.match(text, /"acceptanceId": "AC-2"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diff over the cap is announced and the full stat is included", async () => {
  const { dir, base, git } = repo();
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `big${i}.txt`), `${"x".repeat(100)}\n`.repeat(200));
    git("add", "-A");
    git("commit", "-qm", "big");
    const text = await buildReviewContext({
      repoRoot: dir,
      baseSha: base,
      candidateSha: git("rev-parse", "HEAD"),
      criteria: [],
      validation: { state: "pending" },
      workerSummaries: [],
    });
    assert.match(text, /TRUNCATED/);
    for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`big${i}\\.txt`));
    assert.match(text, /5 files changed/);
    assert.match(text, /validation pending/);
    assert.ok(text.length < REVIEW_DIFF_CHAR_CAP + 5_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
