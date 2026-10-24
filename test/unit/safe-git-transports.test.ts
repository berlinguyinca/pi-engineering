/**
 * T16 round 4 (MED-HIGH): the remote pin could be bypassed. A worker rewrote its worktree's `.git` file to name a
 * repository of its own whose `origin` is a local bare repository with a post-receive hook; Pi's `push origin HEAD`
 * then ran that hook as the operator, in strict and operator mode.
 *
 * Fixes under test: a work tree is remembered against the repository Pi saw it use (and a worktree Pi creates is
 * recorded at creation), local-path / file:// / `<helper>::` remotes need the operator's `pi.allowedRemote` entry in
 * BOTH modes (the `file` transport is otherwise not enabled), the pins and expectations are persisted (atomic, 0600),
 * and `pi-engineering git-pins reset` is the operator's way back.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  dropPinCacheForTests,
  forgetRemotePinsForTests,
  resetSafeGitPins,
  safeGit,
  stateHooks,
  testHooks,
  unsafeOwner,
  urlClass,
} from "../../src/git/safeGit.ts";

const MODES = ["strict", "operator"] as const;
let root = "";
let state = "";
const prior: Record<string, string | undefined> = {};
const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-git-transports-"));
  state = join(root, "state");
  stateHooks.stateRoot = state;
  testHooks.localTransports = false; // the suite default is "on"; these tests are about the refusal
  for (const k of KEYS) prior[k] = process.env[k];
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = join(root, "operator.gitconfig");
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = op\n\temail = op@x\n");
});
afterEach(() => {
  for (const k of KEYS) {
    if (prior[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = prior[k];
  }
  testHooks.localTransports = true;
  stateHooks.stateRoot = undefined;
  forgetRemotePinsForTests();
  rmSync(root, { recursive: true, force: true });
});

const sh = (c: string, cwd = root) =>
  execFileSync("bash", ["-c", c], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: "pipe",
  }).toString();
const allow = (...entries: string[]) =>
  writeFileSync(
    process.env.GIT_CONFIG_GLOBAL as string,
    `[user]\n\tname = op\n\temail = op@x\n[pi]\n${entries.map((e) => `\tallowedRemote = ${e}\n`).join("")}`,
  );

function hooked(bare: string, marker: string) {
  writeFileSync(join(bare, "hooks", "post-receive"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
}

function lab() {
  const marks = join(root, "marks");
  mkdirSync(marks);
  sh(
    "git init -q -b main prim && cd prim && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one",
  );
  sh("git init -q --bare good.git && git init -q --bare evil.git");
  hooked(join(root, "good.git"), join(marks, "GOOD-HOOK"));
  hooked(join(root, "evil.git"), join(marks, "EVIL-HOOK"));
  sh(`git remote add origin ${join(root, "good.git")}`, join(root, "prim"));
  return {
    prim: join(root, "prim"),
    good: join(root, "good.git"),
    evil: join(root, "evil.git"),
    marks: () => (existsSync(marks) ? require_readdir(marks) : []),
  };
}
const require_readdir = (d: string): string[] => execFileSync("ls", [d]).toString().split("\n").filter(Boolean);

/** The attack: the worker builds its own repository whose origin is evil.git and points its worktree at it. */
function swapGitFile(wt: string) {
  sh(
    `git init -q -b main mine && cd mine && git config user.email a@b && git config user.name x && echo q > q && git add -A && git commit -qm q && git remote add origin ${join(root, "evil.git")}`,
  );
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "mine", ".git")}\n`);
}

for (const trust of MODES) {
  test(`${trust}: a worktree Pi created, whose .git file is rewritten to name another repository, is refused (the hook never runs)`, async () => {
    const l = lab();
    allow(l.good, l.evil); // even an allow-listed evil remote is not reached: the repository itself changed
    const wt = join(root, "wt");
    const add = await safeGit(["worktree", "add", "-q", "-b", "feat", wt], { cwd: l.prim, trust });
    assert.equal(add.code, 0, add.stderr);
    writeFileSync(join(wt, "n.txt"), "n\n");
    swapGitFile(wt);
    const r = await safeGit(["push", "origin", "HEAD"], { cwd: wt, trust });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /belonged to the repository/);
    assert.deepEqual(l.marks(), [], "the post-receive hook of the worker's repository did not run");
  });

  test(`${trust}: the same swap on a work tree Pi never saw before is still refused, because a local remote is not allow-listed`, async () => {
    const l = lab();
    allow(l.good); // only the real remote
    sh(`git worktree add -q -b feat ../wt`, l.prim);
    const wt = join(root, "wt");
    swapGitFile(wt);
    const r = await safeGit(["push", "origin", "HEAD"], { cwd: wt, trust });
    assert.equal(r.code, 128);
    assert.match(r.stderr, /local path or file:\/\/ URL/);
    assert.deepEqual(l.marks(), []);
    // control: raw git runs the hook
    sh("git push -q origin HEAD", wt);
    assert.deepEqual(l.marks(), ["EVIL-HOOK"], "control: raw git ran the hook, so the swap is live");
  });

  test(`${trust}: local path, file:// and relative remotes are refused for network commands unless on the allow-list; helpers never run`, async () => {
    const l = lab();
    const cmds = [
      ["push", "origin", "HEAD:refs/heads/x"],
      ["fetch", "origin"],
      ["pull", "origin", "main"],
      ["ls-remote", "origin"],
    ];
    for (const url of [l.good, `file://${l.good}`, "../good.git"]) {
      sh(`git config remote.origin.url ${url}`, l.prim);
      forgetRemotePinsForTests();
      for (const args of cmds) {
        const r = await safeGit(args, { cwd: l.prim, trust, timeoutMs: 10_000 });
        assert.equal(r.code, 128, `${url} ${args.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, /local path or file:\/\/ URL/);
      }
    }
    assert.deepEqual(l.marks(), []);
    sh("git config remote.origin.url 'ext::sh -c touch% /tmp/should-not-exist'", l.prim);
    forgetRemotePinsForTests();
    allow("ext::*"); // listing a helper does not enable it
    const ext = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust, timeoutMs: 10_000 });
    assert.equal(ext.code, 128);
    assert.match(ext.stderr, /helper transport/);
  });

  test(`${trust}: an allow-listed local remote works (exact URL or prefix), and only that one`, async () => {
    const l = lab();
    sh(`git config remote.origin.url ${l.good}`, l.prim);
    for (const entry of [l.good, `${root}/*`]) {
      allow(entry);
      forgetRemotePinsForTests();
      const r = await safeGit(["push", "origin", "HEAD:refs/heads/ok"], { cwd: l.prim, trust, timeoutMs: 20_000 });
      assert.equal(r.code, 0, `${entry}: ${r.stderr}`);
      assert.match(sh("git --git-dir good.git rev-parse refs/heads/ok").trim(), /^[0-9a-f]{40}$/);
      sh("git --git-dir good.git update-ref -d refs/heads/ok");
    }
    // a second remote that is not listed makes the call refused
    allow(l.good);
    sh(`git remote add other ${l.evil}`, l.prim);
    forgetRemotePinsForTests();
    const bad = await safeGit(["fetch", "origin"], { cwd: l.prim, trust, timeoutMs: 10_000 });
    assert.equal(bad.code, 128);
    assert.match(bad.stderr, /local path or file:\/\/ URL/);
  });

  test(`${trust}: a URL given as an argument (push /path, fetch file://..., ls-remote ../x, clone /path) needs the allow-list too`, async () => {
    const l = lab();
    sh("git remote remove origin", l.prim);
    for (const args of [
      ["push", l.evil, "HEAD:refs/heads/x"],
      ["fetch", `file://${l.evil}`],
      ["ls-remote", "../evil.git"],
      ["pull", l.evil, "main"],
    ]) {
      const r = await safeGit(args, { cwd: l.prim, trust, timeoutMs: 10_000 });
      assert.equal(r.code, 128, args.join(" "));
      assert.match(r.stderr, /local path or file:\/\/ URL/);
    }
    const clone = await safeGit(["clone", "-q", l.evil, join(root, "cl")], { cwd: root, trust, timeoutMs: 10_000 });
    assert.equal(clone.code, 128);
    assert.match(clone.stderr, /local path or file:\/\/ URL/);
    assert.equal(existsSync(join(root, "cl")), false);
    allow(l.evil);
    const ok = await safeGit(["clone", "-q", l.evil, join(root, "cl")], { cwd: root, trust, timeoutMs: 10_000 });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(l.marks(), []);
  });

  test(`${trust}: commands that do not contact the remote are unaffected by a local remote`, async () => {
    const l = lab();
    for (const args of [
      ["status"],
      ["remote", "-v"],
      ["log", "-1"],
      ["config", "--get", "remote.origin.url"],
      ["remote", "set-url", "origin", l.evil],
    ]) {
      const r = await safeGit(args, { cwd: l.prim, trust });
      assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    }
  });
}

test("the allow-list is read from the operator's config in strict mode too (strict ignores that config for git itself)", async () => {
  const l = lab();
  sh(`git config remote.origin.url ${l.good}`, l.prim);
  const refused = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "strict", timeoutMs: 10_000 });
  assert.equal(refused.code, 128);
  allow(l.good);
  forgetRemotePinsForTests();
  const ok = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "strict", timeoutMs: 10_000 });
  assert.equal(ok.code, 0, ok.stderr);
  // and a network URL outside a non-empty list is refused in strict mode as well
  sh("git config remote.origin.url https://example.invalid/x/y.git", l.prim);
  forgetRemotePinsForTests();
  const outside = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "strict", timeoutMs: 10_000 });
  assert.equal(outside.code, 128);
  assert.match(outside.stderr, /pi\.allowedRemote/);
});

test("urlClass: helpers, network URLs, scp-like addresses and paths", () => {
  assert.equal(urlClass("ext::sh -c x"), "ext");
  assert.equal(urlClass("fd::17"), "ext");
  assert.equal(urlClass("https://h/x.git"), "net");
  assert.equal(urlClass("ssh://git@h/x.git"), "net");
  assert.equal(urlClass("git://h/x.git"), "net");
  assert.equal(urlClass("git@github.com:org/repo.git"), "net");
  assert.equal(urlClass("github.com:org/repo.git"), "net");
  assert.equal(urlClass("file:///tmp/x.git"), "local");
  assert.equal(urlClass("/tmp/x.git"), "local");
  assert.equal(urlClass("../x.git"), "local");
  assert.equal(urlClass("x.git"), "local");
});

// ─── persistence ─────────────────────────────────────────────────────────────────────────────────────────────────

test("pins and work tree records are persisted (0600, atomic) and survive a restart; reset forgets them", async () => {
  const l = lab();
  allow(l.good, l.evil);
  const first = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "operator", timeoutMs: 10_000 });
  assert.equal(first.code, 0, first.stderr);
  const file = join(state, "safegit", "pins.json");
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    pins: Record<string, string>;
    repos: Record<string, string>;
  };
  assert.ok(saved.pins[join(l.prim, ".git")]?.includes(l.good));
  assert.equal(saved.repos[l.prim], join(l.prim, ".git"));
  assert.deepEqual(
    execFileSync("ls", [join(state, "safegit")])
      .toString()
      .split("\n")
      .filter(Boolean)
      .sort(),
    ["pins.json", "shadow"],
    "no temporary file is left behind",
  );
  // a restart: the in-memory copy is gone, the file is not
  dropPinCacheForTests();
  sh(`git config remote.origin.url ${l.evil}`, l.prim);
  const drift = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "operator", timeoutMs: 10_000 });
  assert.equal(drift.code, 128);
  assert.match(drift.stderr, /remote URLs changed/);
  assert.match(drift.stderr, /pi-engineering git-pins reset/);
  // the operator resets that repository and the new URL is accepted
  assert.deepEqual(resetSafeGitPins(join(l.prim, ".git")), { pins: 1, repos: 1 });
  const again = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "operator", timeoutMs: 10_000 });
  assert.equal(again.code, 0, again.stderr);
});

test("a corrupt pin file is refused, not read as 'nothing is pinned'", async () => {
  const l = lab();
  allow(l.good);
  await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "operator", timeoutMs: 10_000 });
  writeFileSync(join(state, "safegit", "pins.json"), "{not json");
  dropPinCacheForTests();
  const r = await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "operator", timeoutMs: 10_000 });
  assert.equal(r.code, 128);
  assert.match(r.stderr, /pin file .* is unreadable/);
});

test("a primary checkout whose .git directory is replaced by a .git file naming another repository is refused (work tree record)", async () => {
  const l = lab();
  allow(l.good, l.evil);
  assert.equal((await safeGit(["status"], { cwd: l.prim, trust: "strict" })).code, 0);
  sh(
    "git init -q -b main other && cd other && git config user.email a@b && git config user.name x && echo z > z && git add -A && git commit -qm z",
  );
  rmSync(join(l.prim, ".git"), { recursive: true });
  writeFileSync(join(l.prim, ".git"), `gitdir: ${join(root, "other", ".git")}\n`);
  const r = await safeGit(["status"], { cwd: l.prim, trust: "strict" });
  assert.equal(r.code, 128);
  assert.match(r.stderr, /belonged to the repository/);
  // the same bytes at the same place (a re-created .git directory of the SAME repository) are not an alarm
});

test("expectCommonDir: a caller that knows its repository gets a refusal when the work tree names another", async () => {
  const l = lab();
  sh("git worktree add -q -b feat ../wt", l.prim);
  const wt = join(root, "wt");
  const ok = await safeGit(["status"], { cwd: wt, trust: "strict", expectCommonDir: join(l.prim, ".git") });
  assert.equal(ok.code, 0, ok.stderr);
  swapGitFile(wt);
  const r = await safeGit(["status"], { cwd: wt, trust: "strict", expectCommonDir: join(l.prim, ".git") });
  assert.equal(r.code, 128);
  assert.match(r.stderr, /now belongs to another repository/);
});

test("safe.directory: a repository owned by another user is refused unless the operator listed it", () => {
  const layout = { gitDir: "/tmp/a/.git", commonDir: "/tmp/a/.git", workTree: "/tmp/a" };
  const cfg = { allowedRemotes: [], safeDirectories: [], hasLfsFilter: false };
  const mine = lstatSyncUid(root);
  assert.equal(unsafeOwner({ gitDir: root, commonDir: root, workTree: root }, cfg, mine), null);
  assert.match(
    String(unsafeOwner({ gitDir: root, commonDir: root, workTree: root }, cfg, mine + 1)),
    /owned by another user/,
  );
  assert.equal(
    unsafeOwner({ gitDir: root, commonDir: root, workTree: root }, { ...cfg, safeDirectories: [root] }, mine + 1),
    null,
  );
  assert.equal(
    unsafeOwner({ gitDir: root, commonDir: root, workTree: root }, { ...cfg, safeDirectories: ["*"] }, mine + 1),
    null,
  );
  assert.equal(unsafeOwner(layout, cfg, mine), null, "a path that does not exist is not judged");
});
const lstatSyncUid = (p: string): number => lstatSync(p).uid;

test("pi-engineering git-pins list / reset", async () => {
  const l = lab();
  allow(l.good);
  await safeGit(["ls-remote", "origin"], { cwd: l.prim, trust: "operator", timeoutMs: 10_000 });
  const env = { ...process.env, PI_ENGINEERING_STATE_DIR: state };
  const script = join(import.meta.dirname, "..", "..", "scripts", "pi-engineering.ts");
  const list = spawnSync("node", [script, "git-pins", "list"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(l.prim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const reset = spawnSync("node", [script, "git-pins", "reset", join(l.prim, ".git")], { env, encoding: "utf8" });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /forgot 1 remote pin\(s\) and 1 work tree record\(s\)/);
  const bad = spawnSync("node", [script, "git-pins"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("safe.directory is enforced on the call path: another owner's repository is refused, listed ones are not", async () => {
  const l = lab();
  testHooks.uid = lstatSync(l.prim).uid + 1;
  try {
    for (const trust of MODES) {
      const r = await safeGit(["status"], { cwd: l.prim, trust });
      assert.equal(r.code, 128, trust);
      assert.match(r.stderr, /owned by another user/);
    }
    writeFileSync(
      process.env.GIT_CONFIG_GLOBAL as string,
      `[user]\n\tname = op\n\temail = op@x\n[safe]\n\tdirectory = ${l.prim}\n`,
    );
    for (const trust of MODES) assert.equal((await safeGit(["status"], { cwd: l.prim, trust })).code, 0, trust);
  } finally {
    testHooks.uid = undefined;
  }
});
