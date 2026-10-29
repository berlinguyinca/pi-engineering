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
  mutatingGitLocations,
  mutatingGitSegment,
  resolvePrimaryWorktreeGuardConfig,
} from "../../src/guard/primaryWorktreeGuard.ts";

const exec = promisify(execFile);

// ── config resolution ────────────────────────────────────────────────────────

test("config: enabled by default, no primary authorization", () => {
  assert.deepEqual(resolvePrimaryWorktreeGuardConfig({}), {
    enabled: true,
    primarySession: false,
    branchTeardown: true,
  });
});

test("config: PI_ENG_BRANCH_TEARDOWN=0 refuses even a provably no-loss branch delete", () => {
  for (const off of ["0", "false", "off", "no"]) {
    assert.equal(resolvePrimaryWorktreeGuardConfig({ PI_ENG_BRANCH_TEARDOWN: off }).branchTeardown, false, off);
  }
  assert.equal(resolvePrimaryWorktreeGuardConfig({ PI_ENG_BRANCH_TEARDOWN: "1" }).branchTeardown, true);
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
    'git tag --list "v*"',
    "git tag --sort=-creatordate",
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

// ── inspection verbs that were in neither list, so they failed closed ───────

test("isMutatingGitCommand: object and ref inspection is read-only", () => {
  // Every verb here was refused in a live session as if it changed the primary
  // checkout: it is neither in READ_ONLY_VERBS nor MUTATING_VERBS, and an
  // unknown verb at a command position fails closed. The command that gave it
  // away was `git ls-remote --heads origin` — asking what upstream holds, while
  // the session was trying to recover the worktree it had just removed.
  for (const command of [
    "git ls-remote --heads origin",
    "git -C /repo ls-remote origin refs/heads/main",
    "git rev-list --count origin/main..HEAD",
    "git cat-file -p 524176f18392",
    "git ls-tree -r HEAD src",
    "git ls-files --others",
    "git show-ref --heads",
    "git merge-base --is-ancestor HEAD origin/main",
    "git for-each-ref --format=%(refname) refs/heads",
    "git reflog",
    "git reflog show HEAD",
    "git name-rev 524176f18392",
    "git grep TODO src",
    "git annotate src/a.py",
    "git cherry origin/main HEAD",
    "git whatchanged -1",
    "git verify-commit 524176f18392",
    "git verify-tag v0.2.0",
    "git verify-pack -v .git/objects/pack/pack.idx",
    "git count-objects -v",
    "git remote",
    "git remote show origin",
    "git remote get-url origin",
    "git remote update origin",
  ]) {
    assert.equal(isMutatingGitCommand(command), false, command);
  }
});

test("isMutatingGitCommand: the write subcommands of read-only verbs still block", () => {
  for (const command of [
    "git reflog delete HEAD@{0}",
    "git reflog expire --expire=now --all",
    "git for-each-ref --stdin --delete",
    "git for-each-ref --create-reflog",
    "git branch -D feat/x",
    "git tag -d v1.0",
    // Tag writes that the "a flag means it is a listing" rule read as harmless:
    // an annotated/signed tag creation and a forced move both write a ref.
    "git tag -a v1.0 -m release",
    "git tag --annotate v1.0 --message release",
    "git tag -s v1.0",
    "git tag -f v1.0 HEAD",
    "git tag --delete v1.0",
    "git tag v1.0 HEAD",
    "git stash drop",
    "git config user.email a@b.c",
    "git remote set-url origin https://evil.example/repo",
    "git remote remove origin",
    "git remote rename origin upstream",
    "git remote prune origin",
  ]) {
    assert.equal(isMutatingGitCommand(command), true, command);
  }
});

// ── which half of a compound command tripped ────────────────────────────────

test("mutatingGitSegment: names the segment that blocks, not the whole command", () => {
  // The exact shape that stranded a live session: the allowed `worktree` half
  // chained to the blocked `branch -D` half. The refusal was correct; the
  // reason pointed at neither half, so the session re-ran the same mix four
  // times before reaching for `--git-dir` to get around it.
  const command =
    "git -C /repo worktree remove --force /repo-wt && git -C /repo branch -D fix/x && git -C /repo worktree list";
  const culprit = mutatingGitSegment(command);
  assert.equal(culprit?.verb, "branch", command);
  assert.match(culprit?.segment ?? "", /branch -D fix\/x/);
  assert.ok(!culprit!.segment.includes("worktree remove"), "the allowed half is not the culprit");

  // An allowed compound command has no culprit at all.
  assert.equal(mutatingGitSegment("git -C /repo worktree remove --force /repo-wt && git -C /repo worktree list"), null);
  assert.equal(mutatingGitSegment("git -C /repo ls-remote --heads origin && git -C /repo log --oneline -3"), null);

  // The first offender wins; unknown verbs at a command position still count.
  assert.equal(mutatingGitSegment("git commit -m x && git push origin main")?.verb, "commit");
  assert.equal(mutatingGitSegment("git status && git what")?.verb, "what");
});

test("guard: the block reason names the segment that tripped", async () => {
  const guard = guardFor(async (root) => root === "/repo", {}, "/repo");
  const blocked = await guard.onToolCall("bash", {
    command: "git worktree remove --force /repo-wt && git branch -D fix/x",
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /Culprit segment/u);
  assert.match(blocked?.reason ?? "", /branch -D fix\/x/u);
  assert.match(blocked?.reason ?? "", /run the allowed parts/u);
  // The standing escape hatches are still spelled out.
  assert.match(blocked?.reason ?? "", /worktree add/i);
  assert.match(blocked?.reason ?? "", /PI_ENG_PRIMARY/);
});

test("guard: inspection commands run in the primary checkout", async () => {
  const guard = guardFor(async (root) => root === "/repo", {}, "/repo");
  for (const command of [
    "git ls-remote --heads origin",
    "git rev-list --count origin/main..HEAD",
    "git for-each-ref refs/heads",
    "git reflog",
    "git worktree remove --force /repo-wt && git worktree list",
  ]) {
    assert.equal(await guard.onToolCall("bash", { command }), undefined, command);
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

test("effectiveGitCwd: --git-dir and --work-tree name the checkout", () => {
  // `--git-dir` is the way around `-C`. A session refused `git -C <primary>
  // branch -D x` reached for `git --git-dir=<primary>/.git branch -D x` and got
  // through, which is not a hole the guard should be surprised by.
  assert.equal(effectiveGitCwd("git --git-dir=/repo/.git branch -D feat/x", "/session"), "/repo");
  assert.equal(effectiveGitCwd("git --git-dir /repo/.git push origin main", "/session"), "/repo");
  assert.equal(effectiveGitCwd("git -C /elsewhere --work-tree=/repo add -A", "/session"), "/repo");
  assert.equal(effectiveGitCwd("git --work-tree=/repo --git-dir=/r/.git commit -m x", "/session"), "/repo");
  // A relative value resolves against the directory the segment runs in.
  assert.equal(effectiveGitCwd("cd /work && git --git-dir=.git commit -m x", "/session"), "/work");
  // A linked worktree's git dir stays inside the primary tree: fail closed.
  assert.equal(
    effectiveGitCwd("git --git-dir=/repo/.git/worktrees/wt1 commit", "/session"),
    "/repo/.git/worktrees/wt1",
  );
});

test("mutatingGitLocations: each segment is judged where it runs", () => {
  // The last step of a session's work, refused twice in a live session —
  // including the push that would have published the guard fix itself. Under
  // the whole-command view the tail's `-C` won and the push looked like a
  // primary-checkout mutation.
  const command = "cd /wt && git push -u origin fix/x && git -C /repo log --oneline -3";
  const locations = mutatingGitLocations(command, "/session");
  assert.deepEqual(
    locations.map((l) => [l.verb, l.cwd]),
    [["push", "/wt"]],
    command,
  );

  // A mutating segment in the primary is still found, whatever the other
  // segments do, and a `cd` carries across segments as the shell carries it.
  assert.deepEqual(
    mutatingGitLocations("git -C /wt commit -m x && cd /repo && git commit -m y", "/session").map((l) => l.cwd),
    ["/wt", "/repo"],
  );
  assert.deepEqual(
    mutatingGitLocations("git --git-dir=/repo/.git branch -D feat/x", "/session").map((l) => [l.verb, l.cwd]),
    [["branch", "/repo"]],
  );
  assert.deepEqual(mutatingGitLocations("git status && git ls-remote --heads origin", "/session"), []);
});

test("guard: a push in the session's own worktree is not a primary mutation", async () => {
  const guard = guardFor(async (root) => root === "/repo", {}, "/wt");
  assert.equal(
    await guard.onToolCall("bash", { command: "cd /wt && git push -u origin fix/x && git -C /repo log --oneline -3" }),
    undefined,
  );
  // The same push aimed at the primary checkout's branch is still refused.
  const blocked = await guard.onToolCall("bash", { command: "git -C /repo push origin main" });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /Culprit segment/u);
});

test("guard: a write is judged where its own segment runs", async () => {
  const guard = guardFor(async (root) => root === "/repo", {}, "/wt");
  // The redirect lands in the session's worktree; only the LATER step names the
  // primary checkout. Judged against that later directory, the write looked like
  // a primary-checkout edit.
  assert.equal(
    await guard.onToolCall("bash", { command: "cd /wt && echo x > notes.md && git -C /repo log --oneline" }),
    undefined,
  );
  // The same redirect aimed at the primary checkout is still refused.
  assert.equal((await guard.onToolCall("bash", { command: "cd /wt && echo x > ../repo/notes.md" }))?.block, true);
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

// ── branch teardown: the convention's end-of-life step ───────────────────────

/**
 * A repository in the shape a finished session leaves: `feat/x` carries a
 * commit, squash-merged into `main` so the branch's own commits stay ahead of
 * the base while its content is entirely in it, and its worktree still checked
 * out (callers remove it when the session is done).
 */
async function repoWithSessionBranch(): Promise<{ primary: string; linked: string; cleanup: () => void }> {
  const repo = await scratchRepoWithWorktree();
  writeFileSync(join(repo.linked, "feat.txt"), "work");
  await exec("git", ["-C", repo.linked, "add", "-A"]);
  await exec("git", ["-C", repo.linked, "commit", "-qm", "feat"]);
  await exec("git", ["-C", repo.primary, "merge", "--squash", "feat/x"]);
  await exec("git", ["-C", repo.primary, "commit", "-qm", "feat (squash)"]);
  return repo;
}

test("guard: deleting the session's merged branch is allowed once nothing holds it", async () => {
  const { primary, linked, cleanup } = await repoWithSessionBranch();
  try {
    // While the worktree holds the branch, deleting it is not teardown — it is
    // someone else's checkout disappearing.
    const guard = new PrimaryWorktreeGuard(primary);
    const checkedOut = await guard.onToolCall("bash", { command: `git -C ${primary} branch -D feat/x` });
    assert.equal(checkedOut?.block, true);
    assert.match(checkedOut?.reason ?? "", /not checked out in any worktree/u);

    await exec("git", ["-C", primary, "worktree", "remove", "--force", linked]);
    // Same command, now provably no-loss. The session's cwd is the primary
    // because removing its own worktree left it nowhere else — the exact state
    // this allowance exists for.
    const stranded = new PrimaryWorktreeGuard(linked);
    assert.equal(await stranded.onToolCall("bash", { command: `git -C ${primary} branch -D feat/x` }), undefined);
    // The allowance is for real local branches: a name that resolves to nothing
    // (already deleted, a remote-tracking ref, a typo) is refused, not waved
    // through because the proof came back empty.
    for (const command of [
      `git -C ${primary} branch -D feat/never-existed`,
      `git -C ${primary} branch -D refs/remotes/origin/main`,
    ]) {
      assert.equal((await stranded.onToolCall("bash", { command }))?.block, true, command);
    }
  } finally {
    cleanup();
  }
});

test("guard: an unmerged branch delete stays blocked, and says what would make it safe", async () => {
  const { primary, linked, cleanup } = await repoWithSessionBranch();
  try {
    // Work committed after the squash: the branch is no longer patch-equivalent.
    await exec("git", ["-C", linked, "commit", "-qm", "more work", "--allow-empty"]);
    await exec("git", ["-C", primary, "worktree", "remove", "--force", linked]);
    const guard = new PrimaryWorktreeGuard(linked);
    const blocked = await guard.onToolCall("bash", { command: `git -C ${primary} branch -D feat/x` });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /provably loses nothing/u);
    assert.match(blocked?.reason ?? "", /patch-equivalent/u);

    // One unsafe name poisons the whole delete.
    await exec("git", ["-C", primary, "branch", "feat/safe"]);
    const mixed = await guard.onToolCall("bash", { command: `git -C ${primary} branch -D feat/safe feat/x` });
    assert.equal(mixed?.block, true);

    // `PI_ENG_BRANCH_TEARDOWN=0` refuses even the provable one.
    const strict = new PrimaryWorktreeGuard(linked, resolvePrimaryWorktreeGuardConfig({ PI_ENG_BRANCH_TEARDOWN: "0" }));
    assert.equal((await strict.onToolCall("bash", { command: `git -C ${primary} branch -D feat/safe` }))?.block, true);
    // A merged branch deletes fine when asked for with `-d` or `--delete`.
    assert.equal(await guard.onToolCall("bash", { command: `git -C ${primary} branch -d feat/safe` }), undefined);
  } finally {
    cleanup();
  }
});

test("guard: --git-dir does not route around the guard", async () => {
  const { primary, linked, cleanup } = await repoWithSessionBranch();
  try {
    await exec("git", ["-C", linked, "commit", "-qm", "more work", "--allow-empty"]);
    const guard = new PrimaryWorktreeGuard(linked);
    // This is the form a session reached for after `-C` refused it, and it got
    // through. Same checkout, same refusal.
    for (const command of [
      `git --git-dir=${primary}/.git branch -D feat/x`,
      `git --git-dir ${primary}/.git commit -m x`,
      `git --work-tree=${primary} --git-dir=${primary}/.git reset --hard HEAD~1`,
    ]) {
      assert.equal((await guard.onToolCall("bash", { command }))?.block, true, command);
    }
    // Against its own worktree the same forms are still allowed.
    assert.equal(await guard.onToolCall("bash", { command: `git --git-dir=${linked}/.git status` }), undefined);
  } finally {
    cleanup();
  }
});

test("guard: a session whose own worktree was removed is told so", async () => {
  const { primary, linked, cleanup } = await repoWithSessionBranch();
  try {
    await exec("git", ["-C", primary, "worktree", "remove", "--force", linked]);
    const stranded = new PrimaryWorktreeGuard(linked);
    const blocked = await stranded.onToolCall("bash", { command: `git -C ${primary} commit -m x` });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /not inside a git worktree/u);
    assert.match(blocked?.reason ?? "", /git worktree remove/u);
    assert.match(blocked?.reason ?? "", /gives you one back/u);
  } finally {
    cleanup();
  }
});
