import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  DEFAULT_GIT_EXEC,
  GitContextProvider,
  type GitExecFn,
  parseRemoteOrigin,
} from "../../src/status/git-context.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);
const mkdtempDir = async (prefix: string) => await mkdtemp(join(tmpdir(), prefix));

// ─── parseRemoteOrigin (pure) ───────────────────────────────────────────────
test("git parse: GitHub HTTPS origin", () => {
  assert.equal(parseRemoteOrigin("https://github.com/owner/repo.git"), "owner/repo");
});
test("git parse: GitHub SSH origin", () => {
  assert.equal(parseRemoteOrigin("git@github.com:owner/repo.git"), "owner/repo");
});
test("git parse: generic SSH origin (host-agnostic, with port)", () => {
  assert.equal(parseRemoteOrigin("ssh://git@host:2222/owner/repo.git"), "owner/repo");
});
test("git parse: git:// origin", () => {
  assert.equal(parseRemoteOrigin("git://host/owner/repo.git"), "owner/repo");
});
test("git parse: scp-style without scheme", () => {
  assert.equal(parseRemoteOrigin("user@host:owner/repo.git"), "owner/repo");
});
test("git parse: .git suffix stripped; bare owner/repo passes through", () => {
  assert.equal(parseRemoteOrigin("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseRemoteOrigin("https://github.com/owner/repo"), "owner/repo");
});
test("git parse: extra path segments use the last two as owner/repo", () => {
  assert.equal(parseRemoteOrigin("https://host/org/team/repo.git"), "team/repo");
});
test("git parse: missing/invalid origin returns null", () => {
  assert.equal(parseRemoteOrigin(null), null);
  assert.equal(parseRemoteOrigin(undefined), null);
  assert.equal(parseRemoteOrigin(""), null);
  assert.equal(parseRemoteOrigin("   "), null);
  assert.equal(parseRemoteOrigin("just-a-string"), null);
  assert.equal(parseRemoteOrigin("https://github.com/repo-without-owner"), null);
});

// ─── GitContextProvider (integration with real git) ─────────────────────────
test("git context: primary worktree resolves root, origin repo id, and branch", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await exec("git", ["-C", fixture.root, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const provider = new GitContextProvider();
    const ctx = await provider.resolve(fixture.root);
    assert.equal(ctx.insideGit, true);
    assert.equal(ctx.repository, "acme/widgets");
    // git resolves the macOS /var -> /private/var symlink, so compare realpaths.
    assert.equal(ctx.repositoryRoot, realpathSync(fixture.root));
    assert.equal(ctx.worktree, undefined); // primary worktree not labelled `wt:`
    assert.ok(ctx.branch === "master" || ctx.branch === "main");
    assert.equal(ctx.detachedHead, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("git context: missing origin falls back to the repository root basename", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const provider = new GitContextProvider();
    const ctx = await provider.resolve(fixture.root);
    assert.equal(ctx.insideGit, true);
    assert.equal(ctx.repository, basename(fixture.root));
  } finally {
    await fixture.cleanup();
  }
});

test("git context: non-git directory degrades gracefully (insideGit false)", async () => {
  const dir = await mkdtempDir("pi-eng-nongit-");
  try {
    const provider = new GitContextProvider();
    const ctx = await provider.resolve(dir);
    assert.equal(ctx.insideGit, false);
    assert.equal(ctx.repository, undefined);
    assert.equal(ctx.worktree, undefined);
    assert.equal(ctx.branch, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git context: linked worktree is identified as wt:<name> with its branch", async () => {
  const fixture = await makeFixtureRepo();
  const wtPath = await mkdtempDir("pi-eng-linked-");
  // Remove the empty dir so git worktree add can create it.
  await rm(wtPath, { recursive: true, force: true });
  try {
    await exec("git", ["-C", fixture.root, "worktree", "add", "-b", "feat-x", wtPath]);
    const provider = new GitContextProvider();
    const ctx = await provider.resolve(wtPath);
    assert.equal(ctx.insideGit, true);
    assert.equal(ctx.branch, "feat-x");
    assert.ok(ctx.worktree, "linked worktree should carry a `wt:` label");
    assert.ok(ctx.worktree!.startsWith("wt:"));
    // Worktree label is derived from the path basename, not the branch name.
    assert.ok(ctx.worktree!.length > 3);
  } finally {
    await exec("git", ["-C", fixture.root, "worktree", "remove", "--force", wtPath]).catch(() => {});
    await rm(wtPath, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("git context: detached HEAD exposes a short commit sha, not a branch", async () => {
  const fixture = await makeFixtureRepo();
  try {
    await exec("git", ["-C", fixture.root, "checkout", "--detach", "-q"]);
    const provider = new GitContextProvider();
    const ctx = await provider.resolve(fixture.root);
    assert.equal(ctx.insideGit, true);
    assert.equal(ctx.branch, undefined);
    assert.ok(ctx.detachedHead, "detached HEAD should expose a short sha");
    assert.match(ctx.detachedHead!, /^[0-9a-f]+$/);
  } finally {
    await fixture.cleanup();
  }
});

test("git context: cache is invalidated and re-resolved after a branch change", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const provider = new GitContextProvider();
    const before = await provider.resolve(fixture.root);
    assert.ok(before.branch === "master" || before.branch === "main");
    // Create a branch and check it out.
    await exec("git", ["-C", fixture.root, "checkout", "-b", "feature/z", "-q"]);
    // Cache still holds the old branch until invalidated.
    const cached = await provider.resolve(fixture.root);
    assert.notEqual(cached.branch, "feature/z");
    // Invalidate => next resolve picks up the new branch.
    provider.invalidate();
    const after = await provider.resolve(fixture.root);
    assert.equal(after.branch, "feature/z");
  } finally {
    await fixture.cleanup();
  }
});

test("git context: resolve is cached — no git subprocess spawned per call/render", async () => {
  const fixture = await makeFixtureRepo();
  try {
    let calls = 0;
    const countingExec: GitExecFn = async (cwd, args) => {
      calls++;
      return DEFAULT_GIT_EXEC(cwd, args);
    };
    const provider = new GitContextProvider({ exec: countingExec });
    const first = await provider.resolve(fixture.root);
    assert.equal(first.insideGit, true);
    const callsAfterFirst = calls;
    assert.ok(callsAfterFirst > 0, "first resolve does run git");
    // A second resolve within the TTL must not spawn any git subprocess.
    const second = await provider.resolve(fixture.root);
    assert.equal(calls, callsAfterFirst, "cached resolve spawns no git subprocess");
    assert.deepEqual(second, first);
  } finally {
    await fixture.cleanup();
  }
});
