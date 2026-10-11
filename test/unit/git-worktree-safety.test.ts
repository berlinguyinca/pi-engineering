/**
 * Worktree cleanup safety.
 *
 * The runtime creates worktrees as SIBLINGS of the repo root
 * (`pi-eng-<shortHash(root)>-<branch>`). These tests pin two safety invariants
 * that keep the orchestrator from destroying its own checkout or getting wedged
 * when the repository git metadata is disturbed:
 *
 *   1. Worktree cleanup never removes the primary checkout or any path outside
 *      the worktree namespace (assertSafeWorktreePath).
 *   2. removeWorktree recovers an ORPHANED worktree (whose `.git/worktrees`
 *      metadata is gone) instead of throwing, so leftover directories are
 *      cleaned without blocking.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";

const exec = promisify(execFile);

async function scratchRepo(): Promise<{ dir: string; head: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "wt-safe-"));
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Worktree admin metadata path under the primary checkout's `.git/worktrees`. */
function worktreeAdminPath(primaryRoot: string, worktreePath: string): string {
  const name = worktreePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1);
  return join(primaryRoot, ".git", "worktrees", name ?? "");
}

test("worktree cleanup refuses to remove a path outside the worktree namespace", async () => {
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);
    // A sibling directory that is NOT one of this repo's worktrees.
    const foreign = join(repo.dir, "..", "not-a-pi-eng-worktree");
    mkdirSync(foreign, { recursive: true });
    await assert.rejects(
      git.removeWorktree({ path: foreign, branch: "x" }),
      /refusing to remove a path outside the worktree namespace/,
    );
    assert.ok(
      await access(foreign)
        .then(() => true)
        .catch(() => false),
      "the foreign dir must be untouched",
    );
    // The primary checkout is still a valid repo.
    assert.equal(await isGitRepo(repo.dir), true);
  } finally {
    repo.cleanup();
  }
});

test("removeWorktree recovers an orphaned worktree whose git metadata is gone", async () => {
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);
    const wt = await git.createWorktree(repo.head, "cand-0");
    assert.ok(await isGitRepo(wt.path), "fresh worktree is usable");

    // Simulate the observed failure: the primary checkout's `.git/worktrees`
    // metadata for this worktree is removed (e.g. the primary was replaced).
    rmSync(worktreeAdminPath(repo.dir, wt.path), { recursive: true, force: true });
    assert.equal(await isGitRepo(wt.path), false, "orphaned worktree is no longer a git repo");

    // removeWorktree must recover the leftover directory instead of throwing.
    await git.removeWorktree({ path: wt.path, branch: "cand-0" });
    assert.ok(
      await access(wt.path)
        .then(() => false)
        .catch(() => true),
      "leftover dir removed",
    );
    // Primary checkout is intact.
    assert.equal(await isGitRepo(repo.dir), true);
  } finally {
    repo.cleanup();
  }
});

test("concurrent create/remove keeps the primary checkout intact", async () => {
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);
    const keep = await git.createWorktree(repo.head, "cand-0");
    const doomed = await git.createWorktree(repo.head, "cand-1");
    await Promise.all([git.removeWorktree(doomed), git.createWorktree(repo.head, "cand-2")]);

    // The primary checkout and its git metadata must survive untouched.
    assert.equal(await isGitRepo(repo.dir), true);
    const { stdout } = await exec("git", ["-C", repo.dir, "rev-parse", "HEAD"]);
    assert.equal(stdout.trim(), repo.head);
    // The untouched worktree is still usable.
    assert.equal(await isGitRepo(keep.path), true);
  } finally {
    repo.cleanup();
  }
});

test("createWorktree crash-recovery never removes the primary checkout", async () => {
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.dir);
    assert.ok(git);
    // Create and remove several worktrees; the stale-cleanup rm() in
    // createWorktree must never touch the primary checkout.
    for (const branch of ["cand-0", "cand-1", "cand-2"]) {
      const wt = await git.createWorktree(repo.head, branch);
      await git.removeWorktree(wt);
    }
    assert.equal(await isGitRepo(repo.dir), true, "primary checkout survives worktree churn");
    const { stdout } = await exec("git", ["-C", repo.dir, "rev-parse", "HEAD"]);
    assert.equal(stdout.trim(), repo.head);
  } finally {
    repo.cleanup();
  }
});
