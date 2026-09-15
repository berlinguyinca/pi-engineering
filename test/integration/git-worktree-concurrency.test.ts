/**
 * Concurrent worktree creation.
 *
 * `git worktree prune` is GLOBAL — it removes the administrative directory of
 * every worktree whose working directory is currently missing. Verified against
 * the installed git: a worktree created seconds ago is pruned just as readily as
 * an ancient one, because `gc.worktreePruneExpire` does not protect it. Once
 * that directory is gone the worktree is unusable
 * ("fatal: not a git repository: .../worktrees/<name>").
 *
 * `createWorktree` prunes on every call and parallel candidate isolation runs
 * several at once, so without serialisation one creation can destroy another's.
 * These tests pin the property that makes that impossible in-process.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";

const exec = promisify(execFile);
const WIDTH = 8;

async function scratchRepo(): Promise<{ dir: string; head: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "wt-conc-"));
  await exec("git", ["init", "-q", dir]);
  await exec("git", ["-C", dir, "config", "user.email", "t@example.invalid"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "x");
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-qm", "init"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  return {
    dir,
    head: stdout.trim(),
    cleanup: () => {
      for (let i = 0; i < WIDTH; i++) {
        rmSync(join(dir, "..", `pi-eng-cand-${i}`), { recursive: true, force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("worktrees: concurrent creation all succeed and stay usable", async () => {
  const repo = await scratchRepo();
  const created: Array<{ path: string; branch: string }> = [];
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);

    const results = await Promise.all(
      Array.from({ length: WIDTH }, (_, i) => git.createWorktree(repo.head, `cand-${i}`)),
    );
    created.push(...results);

    assert.equal(new Set(results.map((r) => r.path)).size, WIDTH, "each candidate gets its own path");

    // The real assertion: every worktree still has its administrative
    // directory. A prune that ran during a sibling's creation would have
    // removed one, and only using it reveals that.
    for (const wt of results) {
      const head = await exec("git", ["-C", wt.path, "rev-parse", "HEAD"]);
      assert.equal(head.stdout.trim(), repo.head, `${wt.branch} is not usable`);
    }
  } finally {
    repo.cleanup();
  }
});

test("worktrees: a failed creation does not wedge the ones behind it", async () => {
  // The lock runs the next holder whether or not the previous one succeeded.
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);

    const settled = await Promise.allSettled([
      git.createWorktree("0000000000000000000000000000000000000000", "cand-0"),
      git.createWorktree(repo.head, "cand-1"),
      git.createWorktree(repo.head, "cand-2"),
    ]);

    assert.equal(settled[0]?.status, "rejected", "an invalid base commit must fail");
    assert.equal(settled[1]?.status, "fulfilled");
    assert.equal(settled[2]?.status, "fulfilled");
  } finally {
    repo.cleanup();
  }
});

test("worktrees: creation and removal interleaved leave the survivors intact", async () => {
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);

    const keep = await git.createWorktree(repo.head, "cand-0");
    const doomed = await git.createWorktree(repo.head, "cand-1");

    // removeWorktree prunes too, so it carries the same hazard as creation.
    await Promise.all([git.removeWorktree(doomed), git.createWorktree(repo.head, "cand-2")]);

    const head = await exec("git", ["-C", keep.path, "rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), repo.head, "an untouched worktree must survive a concurrent removal");
  } finally {
    repo.cleanup();
  }
});
