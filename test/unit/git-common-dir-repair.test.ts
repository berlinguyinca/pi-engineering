/**
 * The git common directory is the anchor for every piece of Pi's durable
 * repository state: the administration locks (worktree + promotion critical
 * sections), the candidate journal and the checkpoint records. It comes from
 * `git rev-parse --path-format=absolute --git-common-dir`, and Pi cannot simply
 * trust it: safeGit runs git with `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE`
 * pointed at Pi's shadow administration state (see src/git/safeGit.ts), and when
 * that state and the repository are not spelled the same way git resolves one
 * against the other and answers with the physical prefix applied twice — on
 * macOS, where `/var` is a symlink to `/private/var`, `/private/private/var/...`
 * — a path that does not exist. Measured at 4ffa82f3: `commonDir()` doubled while
 * a plain `git -C <repo> rev-parse ...` in the same process was right; the upstream
 * root cause is 61394da7 (#582). Every mkdir under such a path fails with ENOENT,
 * and `withWorktreeSection` reads ENOENT as lock contention and polls to the
 * promotion-wait ceiling — which is how an orchestration run can sit for ten
 * minutes per attempt without reporting anything.
 *
 * `resolveCommonDir` pins the contract: trust an answer that names a directory
 * that exists (usually Pi's shadow common dir, which only git knows); repair one
 * that does not by resolving the layout from the filesystem; refuse to hand back
 * a path that resolves to nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepo, resolveCommonDir } from "../../src/git/GitRepo.ts";

const exec = promisify(execFile);

async function scratchRepo(): Promise<{ root: string; head: string; cleanup: () => void }> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "common-dir-"));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "t@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "baseline"]);
  const head = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  return { root, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The doubled-prefix shape git produces on macOS: the physical prefix applied twice. */
function doubledPrefix(path: string): string {
  return join(realpathSync(tmpdir()), path.startsWith("/") ? path.slice(1) : path);
}

test("a common directory that exists is returned untouched", async () => {
  const repo = await scratchRepo();
  try {
    const real = join(repo.root, ".git");
    await lstat(real);
    assert.equal(await resolveCommonDir(real, repo.root), real);
  } finally {
    repo.cleanup();
  }
});

test("a doubled physical prefix is repaired to the directory that really exists", async () => {
  const repo = await scratchRepo();
  try {
    const real = join(repo.root, ".git");
    const bogus = doubledPrefix(real);
    await assert.rejects(() => lstat(bogus)); // the answer git gave is unusable
    assert.equal(await resolveCommonDir(bogus, repo.root), realpathSync(real));
  } finally {
    repo.cleanup();
  }
});

test("a linked worktree recovers the SHARED common directory, not its own gitdir", async () => {
  const repo = await scratchRepo();
  const worktree = mkdtempSync(join(realpathSync(tmpdir()), "common-dir-wt-"));
  const path = join(worktree, "linked");
  try {
    await exec("git", ["-C", repo.root, "worktree", "add", "-q", "-b", "linked", path, repo.head]);
    const main = realpathSync(join(repo.root, ".git"));
    // The worktree's own gitdir is per-worktree; the common dir is the main repository's.
    const bogus = doubledPrefix(join(path, ".git"));
    assert.equal(await resolveCommonDir(bogus, path), main);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("an answer that resolves to nothing names the impossible path", async () => {
  const missing = join(realpathSync(tmpdir()), "common-dir-absent-", String(process.pid), ".git");
  await assert.rejects(
    () => resolveCommonDir(missing, "/definitely/not/a/repository"),
    (error: Error) => {
      assert.match(error.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("GitRepo.commonDir() only ever hands back a directory Pi can write into", async () => {
  const repo = await scratchRepo();
  try {
    const git = await GitRepo.open(repo.root);
    assert.ok(git, "the fixture repository must open");
    const common = await git!.commonDir();
    const stats = await lstat(common); // throws (and fails the test) if the answer is unreachable
    assert.ok(stats.isDirectory(), `common directory ${common} must be a directory`);
  } finally {
    repo.cleanup();
  }
});
