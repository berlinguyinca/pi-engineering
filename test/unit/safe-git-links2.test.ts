/**
 * T16 round 5: what remains after round 4's symlink refusal. Hard links, FIFOs, the scan budget and its way out, the
 * other worktrees' admin directories, the last look before git starts, private copies of the files a read-only command
 * reads, and git's error text never relaying a quoted line of some other file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  forgetRemotePinsForTests,
  safeGit,
  stateHooks,
  testHooks,
  withholdQuotedContent,
} from "../../src/git/safeGit.ts";
import { removeShadow } from "../../src/git/safeGitState.ts";
import { TREE_SCAN_LIMIT, scanRepoTreeDetailed, setTreeScanLimitForTests } from "../../src/git/safeGitTree.ts";

const MODES = ["strict", "operator"] as const;
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-links2-"));
  stateHooks.stateRoot = join(root, "state");
  mkdirSync(join(root, "home"));
});
afterEach(() => {
  stateHooks.stateRoot = undefined;
  testHooks.afterShadow = undefined;
  testHooks.afterPlan = undefined;
  setTreeScanLimitForTests(TREE_SCAN_LIMIT);
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  HOME: join(root, "home"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env: env(), stdio: "pipe" }).toString();

let n = 0;
function lab() {
  const dir = join(root, `lab${n++}`);
  mkdirSync(dir);
  sh(
    "git init -q -b main prim && cd prim && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one && git worktree add -q ../wt -b feat && git worktree add -q ../wt2 -b feat2 && git init -q --bare ../remote.git && git remote add origin ../remote.git && git push -q origin main",
    dir,
  );
  return {
    dir,
    prim: join(dir, "prim"),
    wt: join(dir, "wt"),
    G: join(dir, "prim", ".git"),
    WG: join(dir, "prim", ".git", "worktrees", "wt"),
    WG2: join(dir, "prim", ".git", "worktrees", "wt2"),
    victim: join(dir, "victim"),
    secret: join(dir, "secret"),
  };
}

// ─── hard links ─────────────────────────────────────────────────────────────────────────────────────────────────

const HARD: Array<{ name: string; at: (l: ReturnType<typeof lab>) => string; cmd: string[]; cwd: "wt" | "prim" }> = [
  { name: "logs/HEAD", at: (l) => join(l.G, "logs", "HEAD"), cmd: ["status"], cwd: "prim" },
  { name: "FETCH_HEAD", at: (l) => join(l.G, "FETCH_HEAD"), cmd: ["fetch", "origin"], cwd: "prim" },
  { name: "ORIG_HEAD", at: (l) => join(l.G, "ORIG_HEAD"), cmd: ["status"], cwd: "prim" },
  { name: "packed-refs", at: (l) => join(l.G, "packed-refs"), cmd: ["log", "-1"], cwd: "wt" },
  { name: "worktree index", at: (l) => join(l.WG, "index"), cmd: ["add", "-A"], cwd: "wt" },
  { name: "worktree HEAD", at: (l) => join(l.WG, "HEAD"), cmd: ["status"], cwd: "wt" },
  { name: "a loose ref", at: (l) => join(l.G, "refs", "heads", "feat2"), cmd: ["status"], cwd: "wt" },
  { name: "config", at: (l) => join(l.G, "config"), cmd: ["status"], cwd: "wt" },
];
for (const c of HARD) {
  test(`hard link at ${c.name}: refused in both modes, the other name is never written`, async () => {
    for (const trust of MODES) {
      const l = lab();
      writeFileSync(l.victim, "VICTIM-BEFORE\n");
      const at = c.at(l);
      mkdirSync(dirname(at), { recursive: true });
      const keep = existsSync(at) ? readFileSync(at) : null;
      rmSync(at, { force: true });
      // the planted name shares the victim's inode; the git directory's own content moves to the victim's side
      if (keep) writeFileSync(l.victim, keep);
      linkSync(l.victim, at);
      const before = readFileSync(l.victim);
      const r = await safeGit(c.cmd, { cwd: l[c.cwd], trust, timeoutMs: 20_000 });
      assert.equal(r.code, 128, `${trust} ${c.name}: ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, /more than one hard link/, `${trust} ${c.name}`);
      assert.deepEqual(readFileSync(l.victim), before, `${trust} ${c.name}: the other name changed`);
    }
  });
}

test("a hard link inside objects/ is fine (a local clone makes them), and a single-name repository passes", async () => {
  const l = lab();
  sh("git clone -q --local prim clone", l.dir); // hard-links its objects to prim's
  const r = await safeGit(["status", "--short"], { cwd: join(l.dir, "clone") });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await safeGit(["status", "--short"], { cwd: l.wt })).code, 0);
});

// ─── special files, the budget and the other worktrees ─────────────────────────────────────────────────────────

test("a FIFO deep in refs/ is refused (the walk, not only the top level, looks at entry types)", async () => {
  const l = lab();
  mkdirSync(join(l.G, "refs", "heads", "deep"), { recursive: true });
  execFileSync("mkfifo", [join(l.G, "refs", "heads", "deep", "f")]);
  const r = await safeGit(["status"], { cwd: l.wt, timeoutMs: 5_000 });
  assert.equal(r.code, 128);
  assert.match(r.stderr, /refs\/heads\/deep\/f is not a regular file/);
});

test("another worktree's admin directory is scanned too (its index and its logs), not only the caller's own", async () => {
  for (const rel of ["index", join("logs", "HEAD")]) {
    const l = lab();
    const target = join(l.WG2, rel);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    symlinkSync(l.victim, target);
    const r = await safeGit(["status"], { cwd: l.wt, timeoutMs: 10_000 });
    assert.equal(r.code, 128, rel);
    assert.match(r.stderr, /worktrees\/wt2\/.*symbolic link/, rel);
  }
});

test("the scan budget is spent across the whole tree: too many loose refs refuses with the way out, and only pack-refs / gc are let through", async () => {
  const l = lab();
  for (let i = 0; i < 60; i++)
    writeFileSync(join(l.G, "refs", "heads", `b${i}`), `${sh("git rev-parse HEAD", l.prim).trim()}\n`);
  setTreeScanLimitForTests(45);
  const refused = await safeGit(["status"], { cwd: l.prim });
  assert.equal(refused.code, 128);
  assert.match(refused.stderr, /more loose refs or log files than Pi can verify/);
  assert.match(refused.stderr, /git pack-refs --all/);
  assert.equal(scanRepoTreeDetailed({ gitDir: l.G, commonDir: l.G }).overLimit, true);
  for (const trust of MODES) {
    const packed = await safeGit(["pack-refs", "--all"], { cwd: l.prim, trust });
    assert.equal(packed.code, 0, packed.stderr);
  }
  assert.equal(existsSync(join(l.G, "packed-refs")), true);
  // the way out is for the amount only: a symbolic link still refuses pack-refs
  const l2 = lab();
  for (let i = 0; i < 60; i++)
    writeFileSync(join(l2.G, "refs", "heads", `b${i}`), `${sh("git rev-parse HEAD", l2.prim).trim()}\n`);
  symlinkSync(l2.victim, join(l2.G, "refs", "heads", "evil"));
  const still = await safeGit(["pack-refs", "--all"], { cwd: l2.prim });
  assert.equal(still.code, 128);
  assert.match(still.stderr, /symbolic link|too many|more loose/);
  assert.equal(existsSync(l2.victim), false);
});

// ─── the window between the look and the spawn ──────────────────────────────────────────────────────────────────

test("a link planted after the shadow is built (while Pi's own internal git calls run) is still caught by the last look before git starts", async () => {
  for (const trust of MODES) {
    const l = lab();
    writeFileSync(join(l.wt, "newfile"), "n");
    testHooks.afterShadow = () => {
      rmSync(join(l.WG, "index"), { force: true });
      symlinkSync(l.victim, join(l.WG, "index"));
    };
    const r = await safeGit(["add", "-A"], { cwd: l.wt, trust, timeoutMs: 20_000 });
    testHooks.afterShadow = undefined;
    assert.equal(r.code, 128, `${trust}: ${r.stderr}`);
    assert.match(r.stderr, /symbolic link/);
    assert.equal(existsSync(l.victim), false, `${trust}: git wrote through the link`);
  }
});

test("a read-only command gets private copies of shallow and info/grafts: a link flipped in after the last look is never opened", async () => {
  for (const [name, rel, body] of [
    ["shallow", "shallow", (l: ReturnType<typeof lab>) => `${sh("git rev-parse HEAD", l.prim).trim()}\n`],
    ["grafts", join("info", "grafts"), () => ""],
  ] as const) {
    for (const trust of MODES) {
      const l = lab();
      writeFileSync(l.secret, "SECRETLINE-one\nSECRETLINE-two\n");
      mkdirSync(join(l.G, "info"), { recursive: true });
      writeFileSync(join(l.G, rel), body(l));
      testHooks.afterPlan = () => {
        // after Pi's last look: the shared path becomes a link to a file that is not a shallow / grafts file
        rmSync(join(l.G, rel), { force: true });
        symlinkSync(l.secret, join(l.G, rel));
      };
      const r = await safeGit(["log", "-1", "--format=%s"], { cwd: l.wt, trust, timeoutMs: 20_000 });
      testHooks.afterPlan = undefined;
      assert.equal(r.code, 0, `${name} ${trust}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "one");
      assert.doesNotMatch(r.stdout + r.stderr, /SECRETLINE/);
      assert.doesNotMatch(r.stderr, /bad graft|bad shallow|withheld/, `${name} ${trust}: git opened the shared path`);
      assert.deepEqual(readFileSync(l.secret), Buffer.from("SECRETLINE-one\nSECRETLINE-two\n"));
      // the copy is never written back over the shared file
      assert.equal(lstatSync(join(l.G, rel)).isSymbolicLink(), true);
    }
  }
});

test("a command that may write shallow (fetch, branch ...) is not given a copy: what it writes goes to the real file", async () => {
  const l = lab();
  writeFileSync(join(l.G, "shallow"), `${sh("git rev-parse HEAD", l.prim).trim()}\n`);
  const before = readFileSync(join(l.G, "shallow"));
  const r = await safeGit(["fetch", "origin"], { cwd: l.prim, timeoutMs: 20_000 });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readFileSync(join(l.G, "shallow")), before);
});

test("a symbolic link or hard link where a private copy is taken refuses the call (O_NOFOLLOW, one name)", async () => {
  const l = lab();
  writeFileSync(l.secret, "SECRETLINE-one\n");
  linkSync(l.secret, join(l.G, "shallow"));
  const r = await safeGit(["log", "-1"], { cwd: l.wt });
  assert.equal(r.code, 128);
  assert.match(r.stderr, /hard link/);
});

// ─── git's error text ───────────────────────────────────────────────────────────────────────────────────────────

test("git's messages that quote a line of a malformed shared file never reach the caller", async () => {
  for (const trust of MODES) {
    const l = lab();
    writeFileSync(l.secret, "SECRETLINE-one\nSECRETLINE-two\n");
    // a write command (branch) is not given a copy; the link appears after Pi's last look, so git opens it
    testHooks.afterPlan = () => {
      rmSync(join(l.G, "packed-refs"), { force: true });
      symlinkSync(l.secret, join(l.G, "packed-refs"));
    };
    const r = await safeGit(["branch", "--list"], { cwd: l.wt, trust, timeoutMs: 20_000 });
    testHooks.afterPlan = undefined;
    assert.doesNotMatch(r.stdout + r.stderr, /SECRETLINE/, `${trust}: ${r.stderr}`);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /withheld/);
  }
});

test("withholdQuotedContent keeps the name of the problem and drops the quoted part", () => {
  assert.equal(
    withholdQuotedContent("fatal: unexpected line in .git/packed-refs: SECRET"),
    "fatal: unexpected line in .git/packed-refs: <line withheld>",
  );
  assert.equal(withholdQuotedContent("fatal: bad shallow line: SECRET"), "fatal: bad shallow line: <line withheld>");
  assert.equal(withholdQuotedContent("error: bad graft data: SECRET"), "error: bad graft data: <line withheld>");
  assert.equal(withholdQuotedContent("fatal: not a git repository"), "fatal: not a git repository");
  assert.equal(withholdQuotedContent("fatal: pathspec 'x' did not match"), "fatal: pathspec 'x' did not match");
});

// ─── removal never follows a link ───────────────────────────────────────────────────────────────────────────────

test("removeShadow does not chmod or descend through a link that took a shadow directory's place", () => {
  const victim = join(root, "victim-dir");
  mkdirSync(join(victim, "keep"), { recursive: true });
  writeFileSync(join(victim, "keep", "f"), "x");
  chmodSync(victim, 0o500);
  const shadow = join(root, "shadow-a");
  mkdirSync(shadow);
  symlinkSync(victim, join(shadow, ".git"));
  removeShadow(shadow);
  assert.equal(existsSync(shadow), false);
  assert.equal(statSync(victim).mode & 0o777, 0o500, "the link target's mode was changed");
  assert.equal(readFileSync(join(victim, "keep", "f"), "utf8"), "x");
  // the root itself replaced by a link
  const link = join(root, "shadow-b");
  symlinkSync(victim, link);
  removeShadow(link);
  assert.equal(existsSync(link), false);
  assert.equal(readFileSync(join(victim, "keep", "f"), "utf8"), "x");
  chmodSync(victim, 0o700);
});
