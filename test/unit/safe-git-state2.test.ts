/**
 * T16 round 5: Pi's private state (the pin file, the shadow root, the sweeper) under concurrency and hostile conditions,
 * the operator's reset command, and the rollback of a half-made work tree.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forgetRemotePinsForTests, safeGit, stateHooks, testHooks } from "../../src/git/safeGit.ts";
import {
  SWEEP_MAX_AGE_MS,
  dropPinCacheForTests,
  listSafeGitPins,
  lockHooks,
  pinStore,
  resetSafeGitPins,
  resetSweepForTests,
  safeGitStateDir,
  sweepStaleShadows,
} from "../../src/git/safeGitState.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-state2-"));
  stateHooks.stateRoot = join(root, "state");
  mkdirSync(join(root, "home"));
});
afterEach(() => {
  stateHooks.stateRoot = undefined;
  stateHooks.shadowRoot = undefined;
  stateHooks.legacyDir = null;
  stateHooks.uid = undefined;
  stateHooks.sweepUid = undefined;
  testHooks.failWriteBack = undefined;
  testHooks.failWriteBackAfter = undefined;
  lockHooks.waitMs = undefined;
  dropPinCacheForTests();
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

// ─── the pin file under concurrency ─────────────────────────────────────────────────────────────────────────────

test("eight processes recording 40 pins each lose none (advisory lock, re-read under the lock, atomic rename)", async () => {
  const worker = join(import.meta.dirname, "..", "support", "pinWorker.ts");
  const state = join(root, "state");
  const runs = Array.from(
    { length: 8 },
    (_, i) =>
      new Promise<number>((resolve) => {
        const child = spawn("node", [worker, state, `p${i}`, "40"], { stdio: "ignore" });
        child.on("close", (code) => resolve(code ?? 1));
      }),
  );
  const codes = await Promise.all(runs);
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0, 0, 0]);
  dropPinCacheForTests();
  const listed = listSafeGitPins();
  assert.equal(listed.pins.length, 8 * 40, "a pin was lost to a concurrent writer");
  assert.equal(listed.repos.length, 8 * 20);
  assert.equal(existsSync(join(state, "safegit", "pins.json.lock")), false, "the lock file is released");
  assert.equal(statSync(join(state, "safegit", "pins.json")).mode & 0o777, 0o600);
});

test("a lock left by a dead process is stale and removed; a lock held by a live one is waited for, then reported", () => {
  const dir = safeGitStateDir();
  const lock = join(dir, "pins.json.lock");
  writeFileSync(lock, "2147483646\n"); // no such process
  pinStore.setPin("/a", "x");
  assert.equal(pinStore.getPin("/a"), "x");
  assert.equal(existsSync(lock), false);
  // a live owner (this process) within the wait limit
  writeFileSync(lock, `${process.pid}\n`);
  lockHooks.waitMs = 150;
  assert.throws(() => pinStore.setPin("/b", "y"), /locked by another process/);
  // older than the stale age: removed even though its owner is alive
  const old = (Date.now() - 5 * 60_000) / 1000;
  utimesSync(lock, old, old);
  pinStore.setPin("/b", "y");
  assert.equal(pinStore.getPin("/b"), "y");
});

test("reset <path> forgets only the entries naming that path (pins by common dir, records by work tree or common dir)", () => {
  pinStore.setPin("/repo/a/.git", "u1");
  pinStore.setPin("/repo/b/.git", "u2");
  pinStore.setRepo("/repo/a", "/repo/a/.git");
  pinStore.setRepo("/repo/b", "/repo/b/.git");
  pinStore.setRepo("/repo/a-wt", "/repo/a/.git");
  assert.deepEqual(resetSafeGitPins("/repo/a"), { pins: 0, repos: 1 });
  assert.deepEqual(resetSafeGitPins("/repo/a/.git"), { pins: 1, repos: 1 });
  const left = listSafeGitPins();
  assert.deepEqual(
    left.pins.map((p) => p.commonDir),
    ["/repo/b/.git"],
  );
  assert.deepEqual(
    left.repos.map((r) => r.workTree),
    ["/repo/b"],
  );
  assert.deepEqual(resetSafeGitPins("/nothing/here"), { pins: 0, repos: 0 });
  assert.deepEqual(resetSafeGitPins(), { pins: 1, repos: 1 });
});

test("the CLI reset command is scoped the same way", () => {
  const state = join(root, "state");
  const run = (...a: string[]) =>
    execFileSync("node", [join(import.meta.dirname, "..", "..", "scripts", "pi-engineering.ts"), "git-pins", ...a], {
      env: { ...process.env, PI_ENGINEERING_STATE_DIR: state },
      encoding: "utf8",
    });
  pinStore.setPin("/repo/a/.git", "u1");
  pinStore.setPin("/repo/b/.git", "u2");
  assert.match(
    run("reset", "/repo/a/.git"),
    /forgot 1 remote pin\(s\) and 0 work tree record\(s\) for \/repo\/a\/\.git/,
  );
  assert.match(run("list"), /\/repo\/b\/\.git/);
  assert.doesNotMatch(run("list"), /\/repo\/a\/\.git/);
});

// ─── the private directory ──────────────────────────────────────────────────────────────────────────────────────

test("the state directory must be a plain directory owned by this user; a loose mode is repaired", () => {
  const state = join(root, "state");
  mkdirSync(join(state, "safegit"), { recursive: true, mode: 0o755 });
  chmodSync(join(state, "safegit"), 0o755);
  assert.equal(safeGitStateDir(), join(state, "safegit"));
  assert.equal(statSync(join(state, "safegit")).mode & 0o777, 0o700, "a mode open to others is repaired");
  // owned by somebody else
  stateHooks.uid = (process.getuid?.() ?? 1000) + 1;
  assert.throws(() => safeGitStateDir(), /not owned by this user/);
  stateHooks.uid = undefined;
  // a symbolic link in its place
  rmSync(join(state, "safegit"), { recursive: true });
  const other = join(root, "other");
  mkdirSync(other);
  symlinkSync(other, join(state, "safegit"));
  assert.throws(() => safeGitStateDir(), /not a plain directory/);
});

test("an unusable state directory is refused with its path and what to do about it, not with a bare errno", async () => {
  writeFileSync(join(root, "blocker"), "x"); // a file where the directory would go
  stateHooks.stateRoot = join(root, "blocker", "state");
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && git commit -q --allow-empty -m one",
  );
  const r = await safeGit(["status"], { cwd: join(root, "r") });
  assert.equal(r.code, 128);
  assert.match(r.stderr, /git state directory .*blocker.* cannot be used/);
  assert.match(r.stderr, /0700/);
  assert.doesNotMatch(r.stderr, /PI_ENGINEERING_STATE_DIR/);
});

// ─── the sweeper ────────────────────────────────────────────────────────────────────────────────────────────────

test("the sweeper never follows a link and never removes what is not ours", () => {
  const shadows = join(root, "shadows");
  stateHooks.shadowRoot = shadows;
  mkdirSync(shadows, { recursive: true, mode: 0o700 });
  const victim = join(root, "victim");
  mkdirSync(join(victim, "keep"), { recursive: true });
  const old = (Date.now() - SWEEP_MAX_AGE_MS * 3) / 1000;
  utimesSync(victim, old, old);
  symlinkSync(victim, join(shadows, "s-link"));
  const stale = join(shadows, "s-stale");
  mkdirSync(stale);
  utimesSync(stale, old, old);
  assert.equal(sweepStaleShadows(SWEEP_MAX_AGE_MS), 1);
  assert.equal(existsSync(victim), true, "the link's target was removed");
  assert.equal(existsSync(join(shadows, "s-link")), true);
  assert.equal(existsSync(stale), false);
  // a directory of somebody else's is left alone
  const theirs = join(shadows, "s-theirs");
  mkdirSync(theirs);
  utimesSync(theirs, old, old);
  stateHooks.sweepUid = (process.getuid?.() ?? 1000) + 1;
  assert.equal(sweepStaleShadows(SWEEP_MAX_AGE_MS), 0);
  assert.equal(existsSync(theirs), true);
});

test("the legacy /tmp scan runs at most once a day (a stamp in the state directory)", () => {
  const legacyRoot = join(root, "legacy");
  mkdirSync(legacyRoot);
  stateHooks.legacyDir = legacyRoot;
  stateHooks.shadowRoot = join(root, "shadows");
  const old = (Date.now() - SWEEP_MAX_AGE_MS * 3) / 1000;
  const mk = (name: string) => {
    const d = join(legacyRoot, name);
    mkdirSync(d);
    utimesSync(d, old, old);
    return d;
  };
  const first = mk("pi-safegit-1");
  assert.equal(sweepStaleShadows(SWEEP_MAX_AGE_MS), 1);
  assert.equal(existsSync(first), false);
  const second = mk("pi-safegit-2");
  assert.equal(sweepStaleShadows(SWEEP_MAX_AGE_MS), 0, "swept again within a day");
  assert.equal(existsSync(second), true);
  const stamp = join(safeGitStateDir(), "legacy-sweep");
  const yesterday = (Date.now() - 25 * 3_600_000) / 1000;
  utimesSync(stamp, yesterday, yesterday);
  assert.equal(sweepStaleShadows(SWEEP_MAX_AGE_MS), 1);
  assert.equal(existsSync(second), false);
  resetSweepForTests();
});

// ─── the operator's own config is read from its own scopes only ────────────────────────────────────────────────

test("a repository at the temp directory cannot add to the operator's allow-list (only system and global scope count)", async () => {
  const tmp = join(root, "tmp-is-a-repo");
  mkdirSync(tmp);
  sh("git init -q . && git config pi.allowedRemote /elsewhere/evil.git && git config safe.directory '*'", tmp);
  const prior = process.env.TMPDIR;
  const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
  const priorHome = process.env.HOME;
  process.env.TMPDIR = tmp;
  process.env.HOME = join(root, "home");
  process.env.GIT_CONFIG_GLOBAL = join(root, "empty.gitconfig");
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  const priorLocal = testHooks.localTransports;
  testHooks.localTransports = false;
  forgetRemotePinsForTests();
  try {
    sh(
      "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && git commit -q --allow-empty -m one && git init -q --bare ../remote.git && git remote add origin /elsewhere/evil.git",
    );
    const r = await safeGit(["fetch", "origin"], { cwd: join(root, "r"), trust: "operator", timeoutMs: 10_000 });
    assert.equal(r.code, 128, r.stderr);
    assert.match(r.stderr, /local path or file:\/\/ URL/);
  } finally {
    testHooks.localTransports = priorLocal;
    if (prior === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = prior;
    if (priorGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
    else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
    if (priorHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = priorHome;
  }
});

// ─── a half-made work tree ──────────────────────────────────────────────────────────────────────────────────────

test("when the write-back after `worktree add` fails, the work tree this call made is rolled back", async () => {
  sh(
    "git init -q -b main r && cd r && git config user.name t && git config user.email t@t && git commit -q --allow-empty -m one",
  );
  const r = join(root, "r");
  const newTree = join(root, "newwt");
  testHooks.failWriteBack = true;
  const res = await safeGit(["worktree", "add", newTree, "-b", "nb"], { cwd: r, timeoutMs: 20_000 });
  testHooks.failWriteBack = undefined;
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /rolled back/);
  assert.equal(existsSync(newTree), false, "the half-made work tree was left behind");
  assert.equal(existsSync(join(r, ".git", "worktrees", "newwt")), false);
  // and the repository is still usable
  assert.equal((await safeGit(["status", "--short"], { cwd: r })).code, 0);
  assert.equal(readFileSync(join(r, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/main");
  // a PARTIAL write-back (the admin directory already moved back) is rolled back as well, not repaired into a half-made state
  const partial = join(root, "partialwt");
  testHooks.failWriteBackAfter = true;
  const half = await safeGit(["worktree", "add", partial, "-b", "nb3"], { cwd: r, timeoutMs: 20_000 });
  testHooks.failWriteBackAfter = undefined;
  assert.notEqual(half.code, 0);
  assert.match(half.stderr, /rolled back/);
  assert.equal(existsSync(partial), false);
  assert.equal(existsSync(join(r, ".git", "worktrees", "partialwt")), false);
  // without the injected failure the same command works and the work tree is linked to the real repository
  const ok = await safeGit(["worktree", "add", newTree, "-b", "nb2"], { cwd: r, timeoutMs: 20_000 });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(
    readFileSync(join(newTree, ".git"), "utf8"),
    new RegExp(`${r.replace(/[/.]/g, "\\$&")}/\\.git/worktrees/`),
  );
});
