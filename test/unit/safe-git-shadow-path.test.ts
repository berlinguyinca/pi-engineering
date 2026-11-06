/**
 * The shadow directory and the paths git prints for it.
 *
 * Pi creates the shadow under the state directory exactly as that directory was handed to it, while git answers with
 * symlinks resolved — `/var/...` is `/private/var/...` on macOS, and any state root can be reached through a link.
 * The recorded path is then a *substring* of git's answer, so mapping the shadow out of the output has to match whole
 * paths: an unanchored replacement rewrote the middle of the path and returned `/private/private/var/...`, a
 * directory that cannot exist. Every worktree allocation failed with ENOENT, and a mission never reached a worker.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { forgetRemotePinsForTests, safeGit, stateHooks } from "../../src/git/safeGit.ts";
import { unshadowText } from "../../src/git/shadowPaths.ts";

afterEach(() => {
  stateHooks.stateRoot = undefined;
  stateHooks.shadowRoot = undefined;
  forgetRemotePinsForTests();
});

/** A repository with one commit, in a laboratory directory of its own. */
function repo(): { root: string; prim: string } {
  const root = mkdtempSync(join(tmpdir(), "safe-git-shadow-path-"));
  const prim = join(root, "repo");
  execFileSync(
    "bash",
    [
      "-c",
      "git init -q -b main repo && cd repo && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one",
    ],
    { cwd: root, stdio: "pipe" },
  );
  return { root, prim };
}

/** The state directory reached THROUGH a symbolic link: Pi records the link, git reports the target. */
function linkedStateRoot(): { link: string; real: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "safe-git-shadow-path-link-"));
  const real = mkdtempSync(join(tmpdir(), "safe-git-shadow-path-real-"));
  const link = join(parent, "state");
  symlinkSync(real, link);
  return { link, real, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

const REAL = "/real/repo/.git";
const REAL_PARENT = "/real/repo";
// as Pi recorded it, and as git reports the same directory
const RECORDED = "/var/state/shadow/s-AbCdEf";
const RESOLVED = "/private/var/state/shadow/s-AbCdEf";
// The two spellings of one shadow, and what each maps to — the shapes `Shadow` carries in production.
const SPELLING = {
  root: RECORDED,
  rootReal: RESOLVED,
  common: `${RECORDED}/.git`,
  commonReal: `${RESOLVED}/.git`,
};
const TARGETS = { commonTo: REAL, rootTo: REAL_PARENT };
/** The production mapping, called the way `mapOut` and `fixWorktreeLinks` call it. */
const map = (s: string): string => unshadowText(s, SPELLING, TARGETS);

test("path mapping maps the resolved form and the recorded form, and never the middle of a path", () => {
  // the answer of today's macOS: git resolved `/var` to `/private/var`, so the recorded form is a substring of it
  assert.equal(map(`${RESOLVED}/.git\n`), `${REAL}\n`);
  assert.equal(map(`${RECORDED}/.git\n`), `${REAL}\n`);
  assert.equal(map(`gitdir: ${RESOLVED}/.git/worktrees/wt\n`), `gitdir: ${REAL}/worktrees/wt\n`);
  // the shadow's own attributes file (the root, not its `.git`)
  assert.equal(map(`${RESOLVED}/attributes`), `${REAL_PARENT}/attributes`);
  // a path that merely contains the shadow path is not the shadow path
  assert.equal(map(`/prefix${RECORDED}/.git`), `/prefix${RECORDED}/.git`);
  assert.equal(map(`${RECORDED}-extra/.git`), `${RECORDED}-extra/.git`);
  // never a doubled prefix, whichever form arrives
  for (const out of [map(`${RESOLVED}/.git`), map(`${RECORDED}/.git`), map(`x ${RESOLVED}/.git ${RECORDED}/attributes`)]) {
    assert.ok(!out.includes("private/private"), out);
    assert.ok(!out.includes("state/shadow"), out);
  }
});

test("a state directory reached through a symlink still reports the repository's own git directory", async () => {
  const l = repo();
  const s = linkedStateRoot();
  try {
    stateHooks.stateRoot = s.link;
    const r = await safeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: l.prim });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), join(realpathSync(l.prim), ".git"));
    assert.ok(!r.stdout.includes(join("safegit", "shadow")), `the shadow leaked into git's output: ${r.stdout}`);
  } finally {
    s.cleanup();
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a worktree created with a symlinked state directory points at the real repository and works with raw git", async () => {
  const l = repo();
  const s = linkedStateRoot();
  try {
    stateHooks.stateRoot = s.link;
    const wt = join(l.root, "wt");
    const add = await safeGit(["worktree", "add", "-q", "-b", "b-linked", wt], { cwd: l.prim });
    assert.equal(add.code, 0, add.stderr);
    const link = readFileSync(join(wt, ".git"), "utf8");
    assert.equal(link.trim(), `gitdir: ${join(realpathSync(l.prim), ".git", "worktrees", "wt")}`);
    assert.ok(!link.includes(join("safegit", "shadow")), `the .git file names the shadow: ${link}`);
    const admin = join(realpathSync(l.prim), ".git", "worktrees", "wt");
    for (const name of readdirSync(admin, { withFileTypes: true })) {
      if (!name.isFile()) continue;
      const body = readFileSync(join(admin, name.name), "utf8");
      assert.ok(!body.includes(join("safegit", "shadow")), `${name} names the shadow: ${body}`);
    }
    // raw git accepts the link the shadow run left behind
    assert.equal(execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" }), "");
    // and the work tree is a work tree of THIS repository
    const common = execFileSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
    assert.equal(common, join(realpathSync(l.prim), ".git"));
    writeFileSync(join(wt, "b.txt"), "b\n");
    const status = await safeGit(["status", "--porcelain"], { cwd: wt });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /^\?\? b\.txt$/m);
  } finally {
    s.cleanup();
    rmSync(l.root, { recursive: true, force: true });
  }
});
