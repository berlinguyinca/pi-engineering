/**
 * Primary worktree guard (one agent, one worktree — enforced).
 *
 * The AGENTS.md convention ("One agent, one worktree … MUST NOT run `git
 * checkout`, `git switch` or `git reset` in a directory it does not own")
 * existed only as prose until the 2026-10-20 augur incident: a long-running
 * session worked directly in the repository's PRIMARY checkout (the main /
 * production worktree), another session's uncommitted feature work was
 * destroyed when the first one force-switched branches there, and a mission
 * running in the same checkout planned against a base that kept moving.
 *
 * The guard blocks a session's own MUTATING tool calls against any git
 * repository's primary worktree (write/edit to a path in it, bash git
 * commands that change its state, bash redirects into it) and points the
 * model at the escape hatch: its own worktree. Read-only inspection and
 * worktree management (`git worktree add|remove|list|prune`) stay allowed —
 * that is how the session leaves. A session authorized for production ops
 * sets PI_ENG_PRIMARY=1 before starting.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  PrimaryWorktreeGuard,
  effectiveGitCwd,
  extractWriteTargets,
  isMutatingGitCommand,
  isPrimaryWorktree,
  resolvePrimaryWorktreeGuardConfig,
} from "../../src/guard/primaryWorktreeGuard.ts";

const exec = promisify(execFile);

// ── config resolution ────────────────────────────────────────────────────────

test("config: enabled by default, no primary authorization", () => {
  assert.deepEqual(resolvePrimaryWorktreeGuardConfig({}), { enabled: true, primarySession: false });
});

test("config: PI_ENG_WORKTREE_GUARD=0 disables the guard", () => {
  for (const off of ["0", "false", "off", "no"]) {
    const cfg = resolvePrimaryWorktreeGuardConfig({ PI_ENG_WORKTREE_GUARD: off });
    assert.equal(cfg.enabled, false, off);
  }
  assert.equal(resolvePrimaryWorktreeGuardConfig({ PI_ENG_WORKTREE_GUARD: "1" }).enabled, true);
});

test("config: PI_ENG_PRIMARY authorizes the session for the primary checkout", () => {
  for (const on of ["1", "true", "yes", "on"]) {
    assert.equal(resolvePrimaryWorktreeGuardConfig({ PI_ENG_PRIMARY: on }).primarySession, true, on);
  }
  assert.equal(resolvePrimaryWorktreeGuardConfig({ PI_ENG_PRIMARY: "0" }).primarySession, false);
});

// ── bash write-target extraction ─────────────────────────────────────────────

test("extractWriteTargets: redirects and tee", () => {
  assert.deepEqual(extractWriteTargets("echo x >> AGENTS.md"), ["AGENTS.md"]);
  assert.deepEqual(extractWriteTargets("echo x > /tmp/out.log"), ["/tmp/out.log"]);
  assert.deepEqual(extractWriteTargets("cat a | tee b"), ["b"]);
  assert.deepEqual(extractWriteTargets("cat a | tee -a b"), ["b"]);
  assert.deepEqual(extractWriteTargets("echo one > a && echo two > b"), ["a", "b"]);
});

test("extractWriteTargets: sed -i and mv/cp destinations", () => {
  assert.deepEqual(extractWriteTargets("sed -i 's/a/b/' src/f.ts"), ["src/f.ts"]);
  assert.deepEqual(extractWriteTargets("cp a b"), ["b"]);
  assert.deepEqual(extractWriteTargets("mv old new"), ["new"]);
});

test("extractWriteTargets: no targets in read-only commands", () => {
  assert.deepEqual(extractWriteTargets("ls -la"), []);
  assert.deepEqual(extractWriteTargets("git status"), []);
  assert.deepEqual(extractWriteTargets("pytest -q tests/"), []);
  assert.deepEqual(extractWriteTargets("cat file | head -5"), []);
});

// ── mutating git command detection ───────────────────────────────────────────

test("isMutatingGitCommand: blocks commands that change checkout state", () => {
  for (const command of [
    "git commit -m x",
    "git commit",
    "git checkout main",
    "git checkout -f main",
    "git checkout -b feat/x",
    "git switch main",
    "git switch -c feat/x",
    "git reset --hard",
    "git merge origin/main",
    "git rebase main",
    "git cherry-pick abc123",
    "git am patch.eml",
    "git stash pop",
    "git stash apply",
    "git apply patch.diff",
    "git add -A",
    "git add src/a.py",
    "git rm src/a.py",
    "git restore src/a.py",
    "git update-ref refs/heads/x abc",
    "git tag v1.0",
    "git branch -d feat/x",
    "git branch -D feat/x",
    "git branch -d -v feat/x",
    "git branch -dv feat/x",
    "git branch -f feat/x origin/main",
    "cd repo && git commit -m x",
    // Unknown verb at a real command position: fail closed in case git grows a
    // mutating verb this list predates.
    "git what",
    // A mutating verb inside a quoted argument stays conservative — skipping
    // quoted spans would let `sh -c 'git commit'` through.
    'grep -n "git push" README.md',
  ]) {
    assert.equal(isMutatingGitCommand(command), true, command);
  }
});

test("isMutatingGitCommand: allows read-only inspection and worktree management", () => {
  for (const command of [
    "git status",
    "git log --oneline -5",
    "git diff",
    "git show HEAD",
    "git fetch",
    "git rev-parse HEAD",
    "git branch",
    "git branch --list",
    "git branch --list feat/*",
    "git branch -a",
    "git branch -r",
    "git branch -vv",
    "git tag -l v*",
    "git tag --list",
    "git remote -v",
    "git ls-files",
    "git worktree add /tmp/wt -b feat/x",
    "git worktree remove /tmp/wt",
    "git worktree list",
    "git worktree prune",
    "gh pr checks 168",
  ]) {
    assert.equal(isMutatingGitCommand(command), false, command);
  }
});

// ── the word `git` inside a larger word is not an invocation ────────────────

test("isMutatingGitCommand: a word that merely contains `git` is not an invocation", () => {
  // All three were blocked in a live session, where the guard read the NEXT
  // word as the git verb (`--jq`, `/tmp/shaltest2`, `origin/main`) and called
  // the command mutating. The third is the worktree command the block message
  // itself tells the model to run, rejected because its branch name contained
  // `-git-`.
  for (const command of [
    "gh api repos/o/r/git/refs/tags/v0.2.0 --jq .object.sha",
    "rm -f /tmp/dbg.mjs /tmp/stable-verify.git /tmp/shaltest2",
    "git worktree add /repo-wt -b fix/primary-guard-git-token-matching origin/main",
    "ls .github/workflows",
    "grep -r github README.md",
    "cp /tmp/a.git /tmp/b.git",
    // The word `git` in prose, with a following word that is not a git verb:
    // this separator line was blocked in a live session (verb "what").
    'echo "--- git: what is 524176f18392 ---"',
    'echo "the git command failed"',
    "echo git status was clean",
  ]) {
    assert.equal(isMutatingGitCommand(command), false, command);
  }
});

test("isMutatingGitCommand: quoted and pathed git invocations stay detected", () => {
  for (const command of [
    "/usr/bin/git commit -m x",
    "./git commit -m x",
    "sh -c 'git commit -m x'",
    "echo $(git push origin main)",
    "for f in a b; do git add $f; done",
  ]) {
    assert.equal(isMutatingGitCommand(command), true, command);
  }
});

// ── effective git cwd ────────────────────────────────────────────────────────

test("effectiveGitCwd: session cwd by default, cd and git -C override", () => {
  assert.equal(effectiveGitCwd("git commit -m x", "/session"), "/session");
  assert.equal(effectiveGitCwd("cd /other && git commit -m x", "/session"), "/other");
  assert.equal(effectiveGitCwd("git -C /other commit -m x", "/session"), "/other");
  assert.equal(effectiveGitCwd("cd /a && git -C /b commit", "/session"), "/b");
});

// ── guard verdicts (injected primary checker: no git needed) ────────────────

function guardFor(
  isPrimary: (root: string) => boolean | Promise<boolean>,
  env: NodeJS.ProcessEnv = {},
  sessionCwd = "/session",
) {
  return new PrimaryWorktreeGuard(sessionCwd, resolvePrimaryWorktreeGuardConfig(env), { isPrimary });
}

test("guard: write/edit into the primary checkout is blocked with an actionable reason", async () => {
  const guard = guardFor(async () => true);
  const blocked = await guard.onToolCall("write", { path: "/repo/src/a.py", content: "x" });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /PRIMARY checkout/i);
  assert.match(blocked?.reason ?? "", /worktree add/i);
  assert.match(blocked?.reason ?? "", /PI_ENG_PRIMARY/);
  assert.equal((await guard.onToolCall("edit", { path: "/repo/src/a.py", edits: [] }))?.block, true);
});

test("guard: write into a linked worktree or outside any repo is allowed", async () => {
  const byPath = new Map([
    ["/repo", true],
    ["/repo-wt", false],
    ["/tmp", false],
  ]);
  const guard = guardFor((p) => byPath.get(p.split("/").slice(0, 2).join("/")) ?? false);
  assert.equal(await guard.onToolCall("write", { path: "/repo-wt/src/a.py", content: "x" }), undefined);
  assert.equal(await guard.onToolCall("write", { path: "/tmp/scratch.txt", content: "x" }), undefined);
});

test("guard: mutating git commands are blocked only when run in the primary checkout", async () => {
  const guard = guardFor(async (root) => root === "/repo", {}, "/repo");
  assert.equal((await guard.onToolCall("bash", { command: "git commit -m x" }))?.block, true);
  assert.equal((await guard.onToolCall("bash", { command: "git checkout -f main" }))?.block, true);
  assert.equal(await guard.onToolCall("bash", { command: "cd /repo-wt && git commit -m x" }), undefined);
  // Read-only git and worktree management stay allowed in the primary.
  assert.equal(await guard.onToolCall("bash", { command: "git status" }), undefined);
  assert.equal(await guard.onToolCall("bash", { command: "git log --oneline -3" }), undefined);
  assert.equal(
    await guard.onToolCall("bash", { command: "git worktree add /repo-wt -b feat/x origin/main" }),
    undefined,
  );
});

test("guard: commands that merely mention `git` run in the primary checkout", async () => {
  const guard = guardFor(async (root) => root === "/repo", {}, "/repo");
  for (const command of [
    "gh api repos/o/r/git/refs/tags/v0.2.0 --jq .object.sha",
    "rm -f /tmp/stable-verify.git",
    "git worktree add /repo-wt -b fix/primary-guard-git-token-matching origin/main",
    'echo "--- git: what is 524176f18392 ---"',
  ]) {
    assert.equal(await guard.onToolCall("bash", { command }), undefined, command);
  }
});

test("guard: redirects into the primary checkout are blocked, redirects elsewhere allowed", async () => {
  const guard = guardFor(async (root) => root === "/repo");
  assert.equal((await guard.onToolCall("bash", { command: "echo x >> /repo/AGENTS.md" }))?.block, true);
  assert.equal((await guard.onToolCall("bash", { command: "cd /repo && echo x >> AGENTS.md" }))?.block, true);
  assert.equal(await guard.onToolCall("bash", { command: "echo x >> /tmp/log.txt" }), undefined);
  assert.equal(await guard.onToolCall("bash", { command: "cd /repo-wt && echo x >> notes.md" }), undefined);
});

test("guard: PI_ENG_PRIMARY=1 and a disabled guard allow everything", async () => {
  const primary = guardFor(async () => true, { PI_ENG_PRIMARY: "1" });
  assert.equal(await primary.onToolCall("write", { path: "/repo/src/a.py", content: "x" }), undefined);
  assert.equal(await primary.onToolCall("bash", { command: "git commit -m x" }), undefined);
  const off = guardFor(async () => true, { PI_ENG_WORKTREE_GUARD: "0" });
  assert.equal(await off.onToolCall("write", { path: "/repo/src/a.py", content: "x" }), undefined);
});

test("guard: read-only tools are never blocked", async () => {
  const guard = guardFor(async () => true);
  assert.equal(await guard.onToolCall("read", { path: "/repo/src/a.py" }), undefined);
  assert.equal(await guard.onToolCall("bash", { command: "cat /repo/src/a.py" }), undefined);
});

// ── real git: primary vs linked worktree detection ──────────────────────────

async function scratchRepoWithWorktree(): Promise<{
  primary: string;
  linked: string;
  cleanup: () => void;
}> {
  const base = mkdtempSync(join(tmpdir(), "pwg-"));
  const primary = join(base, "repo");
  mkdirSync(primary, { recursive: true });
  writeFileSync(join(primary, "a.txt"), "x");
  await exec("git", ["init", "-q", primary]);
  await exec("git", ["-C", primary, "config", "user.email", "t@example.invalid"]);
  await exec("git", ["-C", primary, "config", "user.name", "t"]);
  await exec("git", ["-C", primary, "add", "-A"]);
  await exec("git", ["-C", primary, "commit", "-qm", "init"]);
  const linked = join(base, "repo-wt");
  await exec("git", ["-C", primary, "worktree", "add", "-q", linked, "-b", "feat/x"]);
  return { primary, linked, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("isPrimaryWorktree: true for the main checkout, false for linked worktrees and non-git dirs", async () => {
  const { primary, linked, cleanup } = await scratchRepoWithWorktree();
  try {
    assert.equal(await isPrimaryWorktree(primary), true);
    assert.equal(await isPrimaryWorktree(join(primary, "src")), true, "nested path resolves to the root");
    assert.equal(await isPrimaryWorktree(linked), false);
    assert.equal(await isPrimaryWorktree("/tmp"), false);
  } finally {
    cleanup();
  }
});

test("guard end-to-end on a real repo: primary blocked, own worktree allowed", async () => {
  const { primary, linked, cleanup } = await scratchRepoWithWorktree();
  try {
    const guard = new PrimaryWorktreeGuard(primary);
    assert.equal((await guard.onToolCall("write", { path: join(primary, "a.txt"), content: "y" }))?.block, true);
    assert.equal((await guard.onToolCall("bash", { command: "git commit -m x" }))?.block, true);
    const sessionInWorktree = new PrimaryWorktreeGuard(linked);
    assert.equal(await sessionInWorktree.onToolCall("write", { path: join(linked, "a.txt"), content: "y" }), undefined);
    assert.equal(await sessionInWorktree.onToolCall("bash", { command: "git commit -m x" }), undefined);
    assert.equal(
      (await sessionInWorktree.onToolCall("bash", { command: `cd ${primary} && git commit -m x` }))?.block,
      true,
    );
  } finally {
    cleanup();
  }
});
