/**
 * #455 — the repository's own config was listed from git on EVERY safeGit call,
 * which cost one extra git process per call (~10 ms measured) and, because that
 * listing ran through `runSync`, blocked the event loop even from async callers.
 *
 * The listing decides what the generated shadow config contains, so caching it is
 * only acceptable if staleness is impossible. These tests pin both halves: the read
 * happens once per changed config, and every way the config can change — an edit
 * from outside, Pi's own write-back, a listing that fails — forces a re-read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  forgetRemotePinsForTests,
  safeGit,
  safeGitEnv,
  setConfigListLimitForTests,
  testHooks,
} from "../../src/git/safeGit.ts";

const sh = (cmd: string, cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();

interface Fixture {
  root: string;
  repo: string;
  env: Record<string, string>;
  config(): string;
}

/** `SafeGitOptions.env` is `Record<string, string>`; `process.env` is not. */
function gitEnv(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(safeGitEnv())) if (value !== undefined) out[key] = value;
  return { ...out, ...overrides };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "safe-git-config-cache-"));
  const home = join(root, "home");
  mkdirSync(home);
  const repo = join(root, "repo");
  const env = { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  sh(
    `git init -q -b main repo && cd repo && git config user.name first && git config user.email t@t && echo a > f.ts && git add . && git commit -qm init`,
    root,
    env,
  );
  return {
    root,
    repo,
    env: gitEnv(env),
    config: () => join(repo, ".git", "config"),
  };
}

/** Count the times the repository config is listed FROM GIT. */
function counter(): { lists(): number; reset(): void } {
  let n = 0;
  testHooks.onConfigList = () => {
    n += 1;
  };
  return {
    lists: () => n,
    reset: () => {
      n = 0;
    },
  };
}

function cleanup(f: Fixture): void {
  testHooks.onConfigList = undefined;
  setConfigListLimitForTests(64 * 1024 * 1024);
  forgetRemotePinsForTests();
  rmSync(f.root, { recursive: true, force: true });
}

test("an unchanged repository config is listed once, not once per call", async () => {
  const f = fixture();
  try {
    const lists = counter();
    const first = await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env });
    assert.equal(first.stdout.trim(), "first");
    assert.equal(lists.lists(), 1, "the first call must list it");

    for (let i = 0; i < 5; i++) {
      const again = await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env });
      assert.equal(again.stdout.trim(), "first");
    }
    assert.equal(lists.lists(), 1, "five more calls against an unchanged config must not re-list it");
  } finally {
    cleanup(f);
  }
});

test("an edit made outside safeGit is seen on the next call", async () => {
  const f = fixture();
  try {
    const lists = counter();
    assert.equal((await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env })).stdout.trim(), "first");
    assert.equal(lists.lists(), 1);

    // Somebody edits the file behind Pi's back — the stamp has to catch it, because
    // a stale listing would hand git a shadow config built from the old contents.
    appendFileSync(f.config(), "\n[user]\n\tname = second\n");
    const after = await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env });
    assert.equal(lists.lists(), 2, "a changed config must be re-listed");
    assert.equal(after.stdout.trim(), "second", `git saw: ${after.stdout} (stderr: ${after.stderr})`);
  } finally {
    cleanup(f);
  }
});

test("Pi's own write-back invalidates the listing it cached", async () => {
  const f = fixture();
  try {
    const lists = counter();
    assert.equal((await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env })).stdout.trim(), "first");
    assert.equal(lists.lists(), 1);

    const write = await safeGit(["config", "user.name", "written"], { cwd: f.repo, env: f.env });
    assert.equal(write.code, 0, write.stderr);

    const after = await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env });
    assert.equal(after.stdout.trim(), "written");
    assert.ok(lists.lists() >= 2, `a write-back must drop the cached listing (lists: ${lists.lists()})`);
  } finally {
    cleanup(f);
  }
});

test("a listing that fails or is cut short is never cached", async () => {
  const f = fixture();
  try {
    const lists = counter();
    // A worker can pad the shared config with junk keys; a truncated listing means
    // the allow-list cannot be applied, so the call refuses. Refusals must not be
    // remembered, or the next call would reuse a listing it never completed.
    setConfigListLimitForTests(16);
    const first = await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env });
    assert.notEqual(first.code, 0);
    assert.match(first.stderr, /too large to inspect|unreadable/);
    assert.equal(lists.lists(), 1);

    const second = await safeGit(["config", "--get", "user.name"], { cwd: f.repo, env: f.env });
    assert.notEqual(second.code, 0);
    assert.equal(lists.lists(), 2, "a refusal must be re-derived, not replayed from cache");
  } finally {
    cleanup(f);
  }
});

test("the cache is per repository, not global", async () => {
  const a = fixture();
  const bRoot = mkdtempSync(join(tmpdir(), "safe-git-config-cache-b-"));
  const bHome = join(bRoot, "home");
  mkdirSync(bHome);
  const bRepo = join(bRoot, "repo");
  const bEnv = { HOME: bHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  sh(
    `git init -q -b main repo && cd repo && git config user.name other && git config user.email t@t && echo a > f.ts && git add . && git commit -qm init`,
    bRoot,
    bEnv,
  );
  try {
    const env = gitEnv(bEnv);
    const lists = counter();
    assert.equal((await safeGit(["config", "--get", "user.name"], { cwd: a.repo, env: a.env })).stdout.trim(), "first");
    assert.equal((await safeGit(["config", "--get", "user.name"], { cwd: bRepo, env })).stdout.trim(), "other");
    // Two repositories, two listings: a hit on one must never answer for the other.
    assert.equal(lists.lists(), 2);
    assert.equal((await safeGit(["config", "--get", "user.name"], { cwd: a.repo, env: a.env })).stdout.trim(), "first");
    assert.equal((await safeGit(["config", "--get", "user.name"], { cwd: bRepo, env })).stdout.trim(), "other");
    assert.equal(lists.lists(), 2, "both repositories are now warm");
  } finally {
    testHooks.onConfigList = undefined;
    forgetRemotePinsForTests();
    rmSync(a.root, { recursive: true, force: true });
    rmSync(bRoot, { recursive: true, force: true });
  }
});
