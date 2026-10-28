/**
 * T16 round 4 (LOW): the repository-identity probes (WorktreeIdentity, primaryWorktreeGuard) used raw `git rev-parse`,
 * which honours a `core.worktree` / `core.bare` that a worker wrote into the shared config. They go through safeGit,
 * which finds the repository without reading its config.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forgetRemotePinsForTests, stateHooks } from "../../src/git/safeGit.ts";
import { isPrimaryWorktree } from "../../src/guard/primaryWorktreeGuard.ts";
import { resolveWorktreeIdentity } from "../../src/runtime/isolation/WorktreeIdentity.ts";

let root = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "safe-git-rawcallers-")));
  stateHooks.stateRoot = join(root, "state");
});
afterEach(() => {
  stateHooks.stateRoot = undefined;
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" }).toString();

function repo() {
  sh(
    "git init -q -b main prim && cd prim && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one && git worktree add -q ../wt -b feat",
  );
  mkdirSync(join(root, "elsewhere"));
  return { prim: join(root, "prim"), wt: join(root, "wt"), elsewhere: join(root, "elsewhere") };
}

test("a worker-written core.worktree does not move the identity or the primary-worktree answer", async () => {
  const l = repo();
  sh(`git config core.worktree ${l.elsewhere}`, l.prim);
  assert.equal(
    sh("git rev-parse --show-toplevel", l.prim).trim(),
    l.elsewhere,
    "control: raw git follows core.worktree",
  );
  const id = await resolveWorktreeIdentity(l.prim);
  assert.equal(id.kind, "git");
  assert.equal(id.worktreeRoot, l.prim);
  assert.equal(id.gitCommonDir, join(l.prim, ".git"));
  assert.equal(await isPrimaryWorktree(l.prim), true);
  assert.equal(await isPrimaryWorktree(l.wt), false);
  const linked = await resolveWorktreeIdentity(l.wt);
  assert.equal(linked.worktreeRoot, l.wt);
  assert.notEqual(linked.worktreeId, id.worktreeId);
});

test("a worker-written core.bare=true does not turn the repository into 'not a git directory' for the identity probes", async () => {
  const l = repo();
  sh("git config core.bare true", l.prim);
  assert.throws(() => sh("git rev-parse --show-toplevel", l.prim), "control: raw git refuses");
  const id = await resolveWorktreeIdentity(l.prim);
  assert.equal(id.kind, "git");
  assert.equal(id.worktreeRoot, l.prim);
  assert.equal(await isPrimaryWorktree(l.prim), true);
});

test("outside a repository both probes still answer 'not git' / 'not primary'", async () => {
  const dir = join(root, "plain");
  mkdirSync(dir);
  const id = await resolveWorktreeIdentity(dir);
  assert.equal(id.kind, "directory");
  assert.equal(await isPrimaryWorktree(dir), false);
});
