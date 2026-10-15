/**
 * Issue #151: smoke at the merged SHA; revert only what the evidence attributes
 * to the merge, per policy, on real git fixture repos.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import type { PromoteResult, QueueEntry } from "../../src/merge/MergeQueue.ts";
import { gitPostMerge, postMergeCheck, revertBranchName } from "../../src/merge/postMerge.ts";

const run = promisify(execFile);

let root: string;
const g = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout.trim();

async function commit(file: string, text: string, message: string): Promise<string> {
  await writeFile(join(root, file), text);
  await g("add", "-A");
  await g("commit", "-q", "-m", message);
  return g("rev-parse", "HEAD");
}

/** Smoke: passes unless status.txt says "broken" at that commit. */
const smoke = async (sha: string) => (await g("show", `${sha}:status.txt`)) !== "broken";

const branches = async () => (await g("branch", "--format=%(refname:short)")).split("\n").sort();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-postmerge-test-"));
  await run("git", ["init", "-q", "-b", "main", root]);
  await g("config", "user.email", "t@example.com");
  await g("config", "user.name", "T");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const entryFor = (): QueueEntry => ({
  branch: "feat/thing",
  target: "main",
  reviewedHeadSha: "unused",
  boundBaseSha: "unused",
});

/** main: good -> (feature merge) with status "broken". */
async function regression() {
  await commit("status.txt", "ok", "good");
  const pre = await g("rev-parse", "HEAD");
  const merged = await commit("status.txt", "broken", "merge feat/thing");
  return { pre, merged };
}

describe("postMergeCheck", () => {
  it("does nothing when the smoke passes at the merged SHA", async () => {
    await commit("status.txt", "ok", "good");
    const pre = await g("rev-parse", "HEAD");
    const merged = await commit("other.txt", "x", "merge");
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "propose", gitPostMerge(root));
    assert.equal(result.smokePassed, true);
    assert.equal(result.attributable, false);
    assert.deepEqual(await branches(), ["main"]);
  });

  it("a failure also present at preMergeSha is not attributable and creates no revert branch", async () => {
    await commit("status.txt", "broken", "already broken");
    const pre = await g("rev-parse", "HEAD");
    const merged = await commit("other.txt", "x", "merge");
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "auto", gitPostMerge(root), {
      enqueue: async () => assert.fail("must not enqueue"),
    });
    assert.equal(result.smokePassed, false);
    assert.equal(result.attributable, false);
    assert.equal(result.revertBranch, undefined);
    assert.match(result.reason ?? "", /not attributable/);
    assert.deepEqual(await branches(), ["main"]);
  });

  it("policy propose creates 1 revert branch and leaves the target tip unchanged", async () => {
    const { pre, merged } = await regression();
    const tipBefore = await g("rev-parse", "main");
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "propose", gitPostMerge(root));
    assert.equal(result.attributable, true);
    assert.equal(result.enqueued, false);
    assert.equal(result.revertBranch, revertBranchName(entryFor(), merged));
    assert.deepEqual(await branches(), ["main", result.revertBranch as string].sort());
    assert.equal(await g("rev-parse", "main"), tipBefore);
    assert.equal(await g("rev-parse", result.revertBranch as string), result.revertSha);
    assert.equal(await g("show", `${result.revertBranch}:status.txt`), "ok");
    assert.equal(await g("rev-parse", `${result.revertBranch}~1`), tipBefore);
    assert.equal(await g("worktree", "list", "--porcelain").then((o) => o.split("worktree ").length - 1), 1);
  });

  it("defaults the policy to propose", async () => {
    const { pre, merged } = await regression();
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, undefined, gitPostMerge(root));
    assert.equal(result.policy, "propose");
    assert.ok(result.revertBranch);
  });

  it("policy off creates 0 branches but still records the attribution", async () => {
    const { pre, merged } = await regression();
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "off", gitPostMerge(root));
    assert.equal(result.attributable, true);
    assert.equal(result.revertBranch, undefined);
    assert.deepEqual(await branches(), ["main"]);
  });

  it("policy auto enqueues the revert through the merge queue bound to the target tip", async () => {
    const { pre, merged } = await regression();
    const tip = await g("rev-parse", "main");
    const seen: QueueEntry[] = [];
    const queue = {
      enqueue: async (e: QueueEntry): Promise<PromoteResult> => {
        seen.push(e);
        return { level: "main", ok: true, commit: "c" };
      },
    };
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "auto", gitPostMerge(root), queue);
    assert.equal(result.enqueued, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.branch, result.revertBranch);
    assert.equal(seen[0]?.target, "main");
    assert.equal(seen[0]?.reviewedHeadSha, result.revertSha);
    assert.equal(seen[0]?.boundBaseSha, tip);
    assert.equal(await g("rev-parse", "main"), tip);
  });

  it("policy auto reports a refused enqueue instead of claiming success", async () => {
    const { pre, merged } = await regression();
    const queue = {
      enqueue: async (): Promise<PromoteResult> => ({ level: "integration", ok: false, reason: "checks failed" }),
    };
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "auto", gitPostMerge(root), queue);
    assert.equal(result.enqueued, false);
    assert.ok(result.revertBranch);
    assert.match(result.reason ?? "", /checks failed/);
  });

  it("is idempotent: a repeated check reuses the revert branch", async () => {
    const { pre, merged } = await regression();
    const first = await postMergeCheck(entryFor(), merged, pre, smoke, "propose", gitPostMerge(root));
    const second = await postMergeCheck(entryFor(), merged, pre, smoke, "propose", gitPostMerge(root));
    assert.equal(second.revertSha, first.revertSha);
    assert.equal((await branches()).length, 2);
  });

  it("reverts a merge commit with -m 1", async () => {
    await commit("status.txt", "ok", "good");
    const pre = await g("rev-parse", "HEAD");
    await g("checkout", "-q", "-b", "feat/thing");
    await commit("status.txt", "broken", "feature");
    await g("checkout", "-q", "main");
    await g("merge", "--no-ff", "-q", "-m", "merge feat/thing", "feat/thing");
    const merged = await g("rev-parse", "HEAD");
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "propose", gitPostMerge(root));
    assert.equal(result.attributable, true);
    assert.equal(await g("show", `${result.revertBranch}:status.txt`), "ok");
  });

  it("leaves no branch and says why when the revert conflicts with later work", async () => {
    const { pre, merged } = await regression();
    await commit("status.txt", "broken-and-edited", "later work on the same line");
    const tip = await g("rev-parse", "main");
    const result = await postMergeCheck(entryFor(), merged, pre, smoke, "propose", gitPostMerge(root));
    assert.equal(result.attributable, true);
    assert.equal(result.revertBranch, undefined);
    assert.match(result.reason ?? "", /revert not prepared/);
    assert.deepEqual(await branches(), ["main"]);
    assert.equal(await g("rev-parse", "main"), tip);
    assert.equal(await g("worktree", "list", "--porcelain").then((o) => o.split("worktree ").length - 1), 1);
  });

  it("rejects a merged SHA equal to the pre-merge SHA", async () => {
    const sha = await commit("status.txt", "ok", "good");
    await assert.rejects(
      () => postMergeCheck(entryFor(), sha, sha, smoke, "propose", gitPostMerge(root)),
      /nothing was merged/,
    );
  });
});
