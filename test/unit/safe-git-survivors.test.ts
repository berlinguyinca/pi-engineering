/**
 * T16 round 3: tests for the mutation survivors of the allow-list rewrite. Each one pins a behaviour that earlier tests
 * only touched by accident (the forced command-line settings, the nested-repo/network classification, repository
 * discovery edge cases, the remote pin across reads, the operator allow-list cache, output path mapping).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  contactsNetwork,
  discoverRepo,
  forgetRemotePinsForTests,
  generateConfig,
  parseFileConfig,
  safeGit,
  safeGitPrefix,
  stateHooks,
  testHooks,
} from "../../src/git/safeGit.ts";

// a private shadow root for this file alone (no other file's directories are ever counted)
const shadowDir = mkdtempSync(join(tmpdir(), "safe-git-surv-shadows-"));
stateHooks.shadowRoot = shadowDir;

afterEach(() => {
  testHooks.afterPlan = undefined;
  forgetRemotePinsForTests();
});

function lab() {
  const root = mkdtempSync(join(tmpdir(), "safe-git-surv-"));
  mkdirSync(join(root, "home"));
  const env = { ...process.env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (c: string, cwd = root) => execFileSync("bash", ["-c", c], { cwd, env, stdio: "pipe" }).toString();
  sh(
    "git init -q -b main repo && cd repo && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one && git init -q -b main --bare ../remote.git && git init -q -b main --bare ../other.git && git remote add origin ../remote.git && git push -q origin main",
  );
  return { root, repo: join(root, "repo"), sh };
}

test("the forced command-line settings are present in both trust modes (hooks off, gc off, no submodule summary)", async () => {
  for (const trust of ["strict", "operator"] as const) {
    const prefix = (await safeGitPrefix("/x", trust)).join(" ");
    for (const want of [
      "core.hooksPath=/dev/null",
      "gc.auto=0",
      "status.submoduleSummary=false",
      "core.fsmonitor=false",
    ]) {
      assert.ok(prefix.includes(want), `${trust}: missing ${want}`);
    }
  }
  const strict = (await safeGitPrefix("/x", "strict")).join(" ");
  for (const want of ["credential.helper=", "core.sshCommand=ssh", "core.attributesFile=/dev/null"]) {
    assert.ok(strict.includes(want), `strict: missing ${want}`);
  }
});

test("contactsNetwork: no subcommand contacts nothing; remote read verbs are local; fetch is not", () => {
  assert.equal(contactsNetwork(["--no-pager"], 1), false);
  assert.equal(contactsNetwork([], 0), false);
  assert.equal(contactsNetwork(["remote", "-v"], 0), false);
  assert.equal(contactsNetwork(["remote", "update"], 0), true);
  assert.equal(contactsNetwork(["fetch"], 0), true);
});

test("a repository-local url.<base>.insteadOf is dropped, so it cannot rewrite where a remote points", () => {
  const entries = parseFileConfig(
    "remote.origin.url\nhttp://good.example/r.git\0url.evil.insteadof\nabc\0url.evil.pushinsteadof\nabc\0",
  );
  const g = generateConfig(entries, false);
  assert.doesNotMatch(g.text, /insteadof/i);
  assert.doesNotMatch(g.text, /evil/);
  assert.match(g.text, /good\.example\/r\.git/);
});

test("repository discovery does not cross a filesystem boundary (git's own default), and does when the device is the same", () => {
  const l = lab();
  try {
    mkdirSync(join(l.repo, "deep", "er"), { recursive: true });
    const start = join(l.repo, "deep", "er");
    const found = discoverRepo(start);
    assert.ok(found && found !== "invalid");
    const crossing = (p: string): number => (p.endsWith("deep") || p === l.repo ? 2 : 1);
    assert.equal(discoverRepo(start, crossing), null);
    assert.ok(discoverRepo(start, () => 1));
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a malformed .git file is refused, not treated as 'no repository' (which would let git search upward)", async () => {
  const l = lab();
  try {
    const inner = join(l.repo, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, ".git"), "gitdir: /nonexistent/nowhere\n");
    for (const trust of ["strict", "operator"] as const) {
      const r = await safeGit(["status"], { cwd: inner, trust });
      assert.equal(r.code, 128, trust);
      assert.match(r.stderr, /refus|invalid|not a git/i);
    }
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("worktree add in a repository that has no worktrees directory yet lands in the real repository", async () => {
  const l = lab();
  try {
    assert.equal(existsSync(join(l.repo, ".git", "worktrees")), false);
    const left = () => readdirSync(shadowDir).length;
    const before = left();
    const r = await safeGit(["worktree", "add", "-b", "feat", join(l.root, "wt")], { cwd: l.repo, trust: "strict" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(join(l.repo, ".git", "worktrees")), ["wt"]);
    assert.match(l.sh("git worktree list", l.repo), /wt/);
    assert.equal(left(), before);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("stderr paths are the real ones, never the shadow's", async () => {
  const l = lab();
  try {
    const r = await safeGit(["fsck", "--verbose"], { cwd: l.repo, trust: "strict" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Checking cache tree of /);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(shadowDir));
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("reads do not clear the pin: restoring the original URL after a hand edit and some reads is allowed, the edit alone is not", async () => {
  const l = lab();
  try {
    const orig = `file://${l.root}/remote.git`;
    l.sh(`git config remote.origin.url ${orig}`, l.repo);
    const first = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator" });
    assert.equal(first.code, 0, first.stderr);
    l.sh(`git config remote.origin.url file://${l.root}/other.git`, l.repo);
    for (const argv of [
      ["remote", "-v"],
      ["config", "--get", "remote.origin.url"],
      ["remote", "get-url", "origin"],
    ]) {
      await safeGit(argv, { cwd: l.repo, trust: "operator" });
    }
    const drifted = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator" });
    assert.equal(drifted.code, 128);
    assert.match(drifted.stderr, /remote URLs changed/);
    l.sh(`git config remote.origin.url ${orig}`, l.repo);
    const back = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator" });
    assert.equal(back.code, 0, back.stderr);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("the operator pi.allowedRemote cache follows the operator's config location (a different global config is a different list)", async () => {
  const l = lab();
  const prior = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
  try {
    const a = join(l.root, "a.gitconfig");
    const b = join(l.root, "b.gitconfig");
    l.sh("git config remote.origin.url https://good.example/org/r.git", l.repo);
    writeFileSync(a, "[pi]\n\tallowedRemote = https://nowhere.example/*\n");
    writeFileSync(b, "[pi]\n\tallowedRemote = https://good.example/*\n");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = a;
    const refused = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator" });
    assert.equal(refused.code, 128);
    assert.match(refused.stderr, /pi\.allowedRemote/);
    process.env.GIT_CONFIG_GLOBAL = b;
    const allowed = await safeGit(["ls-remote", "origin"], { cwd: l.repo, trust: "operator" });
    assert.doesNotMatch(allowed.stderr, /pi\.allowedRemote/);
  } finally {
    if (prior.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prior.g;
    if (prior.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prior.n;
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a repository that appears after discovery is not picked up: git is fenced at the directory it was told about", async () => {
  const root = mkdtempSync(join(tmpdir(), "safe-git-ceil-"));
  try {
    const sub = join(root, "sub");
    mkdirSync(sub);
    testHooks.afterPlan = () => {
      execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
    };
    for (const trust of ["strict", "operator"] as const) {
      rmSync(join(root, ".git"), { recursive: true, force: true });
      const r = await safeGit(["rev-parse", "--show-toplevel"], { cwd: sub, trust });
      assert.equal(r.code, 128, `${trust}: ${r.stdout}`);
      assert.equal(r.stdout, "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
