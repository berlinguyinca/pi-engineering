import assert from "node:assert/strict";
import { link, lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { safeGit } from "../../src/git/safeGit.ts";
import { ExclusiveFileLock } from "../../src/platform/eventstore/fileLock.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("worktree lock publication cannot make concurrent safe git reject the repository", async () => {
  const fixture = await makeFixtureRepo();
  const repo = (await GitRepo.open(fixture.root))!;
  repo.promotionWait.ceilingMs = 0;
  const base = await repo.headCommit();
  const original = ExclusiveFileLock.acquire;
  let checked = 0;
  ExclusiveFileLock.acquire = (file, hooks = {}) =>
    original.call(ExclusiveFileLock, file, {
      ...hooks,
      linkFile: async (candidate, destination) => {
        await link(candidate, destination);
        if (!destination.includes("pi-engineering-worktree") && !destination.endsWith("worktree.lock")) return;
        assert.equal((await lstat(destination)).nlink, 2, "pause during real atomic lock publication");
        const result = await safeGit(["status", "--porcelain"], { cwd: fixture.root, trust: "operator" });
        checked++;
        assert.equal(result.code, 0, result.stderr);
      },
    });
  try {
    const worktree = await repo.createWorktree(base, "publication-race");
    assert.ok(checked > 0);
    await repo.removeWorktree(worktree);
  } finally {
    ExclusiveFileLock.acquire = original;
    await fixture.cleanup();
  }
});

test("git administration lock metadata refuses an existing symlink directory", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const repo = (await GitRepo.open(fixture.root))!;
    const base = await repo.headCommit();
    const outside = join(fixture.root, "outside-locks");
    await mkdir(outside);
    await symlink(outside, join(await repo.commonDir(), "pi-engineering-locks"));
    await assert.rejects(() => repo.createWorktree(base, "linked-locks"), /symbolic link|unsafe|directory/i);
  } finally {
    await fixture.cleanup();
  }
});

test("the new worktree lock namespace still refuses an already-held legacy lock", async () => {
  const fixture = await makeFixtureRepo();
  const repo = (await GitRepo.open(fixture.root))!;
  repo.promotionWait.ceilingMs = 0;
  const base = await repo.headCommit();
  const legacy = await ExclusiveFileLock.acquire(join(await repo.commonDir(), "pi-engineering-worktree"));
  try {
    await assert.rejects(() => repo.createWorktree(base, "legacy-lock-held"), /legacy repository worktree.*held/);
  } finally {
    legacy.release();
  }
  try {
    const worktree = await repo.createWorktree(base, "legacy-lock-released");
    await repo.removeWorktree(worktree);
  } finally {
    await fixture.cleanup();
  }
});
