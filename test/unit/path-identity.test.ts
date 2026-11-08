/**
 * One directory, one spelling — the invariant behind #582.
 *
 * Pi resolves repositories with `realpathSync` and used to keep its own git state in the path
 * spelling it was handed. On macOS every `$TMPDIR` lives behind `/var` → `/private/var`, so the two
 * halves of one git call named the same directory differently: safeGit's shadow sat under
 * `/var/folders/…` while the real common dir was `/private/var/folders/…`. Git resolved those two
 * spellings against each other and produced `/private/private/var/…`, so every `mkdir` under a
 * repository's common dir failed with `ENOENT` — 548 unit-test failures and one infinite hang, from
 * a name, not from logic.
 *
 * Nothing else in the suite asserts the invariant, which is why this file exists: the next
 * normalization site regressing should fail *here*, in one test that says what broke, and not as a
 * few hundred unrelated failures on one operating system.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { discoverRepo, safeGit, testHooks } from "../../src/git/safeGit.ts";
import { GitRepo } from "../../src/git/GitRepo.ts";
import {
  makeShadowRoot,
  removeShadow,
  resetSweepForTests,
  safeGitStateDir,
  shadowParentDir,
  stateHooks,
} from "../../src/git/safeGitState.ts";

let root = "";
const saved = { stateRoot: stateHooks.stateRoot, shadowRoot: stateHooks.shadowRoot };

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "path-identity-"));
  resetSweepForTests();
});

afterEach(() => {
  stateHooks.stateRoot = saved.stateRoot;
  stateHooks.shadowRoot = saved.shadowRoot;
  testHooks.afterPlan = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A repository with one commit, the way the other safeGit suites build one. */
function fixtureRepo(): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (script: string, cwd: string) => execFileSync("bash", ["-c", script], { cwd, env, stdio: "pipe" });
  sh("git init -q -b main . && git config user.name t && git config user.email t@t && echo a > a.txt && git add . && git commit -qm one", repo);
  return repo;
}

test("normalizing an already-normalized path is identity", () => {
  // The whole fix in one line, stated as a law: applying the canonicalization twice changes nothing.
  // Every site that resolves a path must obey it, or two spellings of one directory are in play.
  const once = realpathSync(root);
  assert.equal(realpathSync(once), once);
  assert.equal(realpathSync(realpathSync(once)), once);
});

test("the state directory is reported canonically, even when it is configured through a symlink", () => {
  // The exact shape of the bug: a state root reached through a symlink. `privateDir` refuses a
  // symlink AT the last component but historically returned the path as given, so an ancestor
  // symlink — which is what macOS's `/var` is — survived into git's environment.
  const real = join(root, "real-state");
  mkdirSync(real, { mode: 0o700 });
  const via = join(root, "via-link");
  symlinkSync(real, via);
  stateHooks.stateRoot = via;

  const dir = safeGitStateDir();
  assert.equal(dir, join(realpathSync(real), "safegit"), "the resolved spelling, not the configured one");
  assert.ok(!dir.includes("via-link"), `the alias must not survive into a path git is handed: ${dir}`);
  assert.equal(realpathSync(dir), dir, "and it must already be canonical");
  // Calling it again is a no-op, not a second resolution of an already-resolved path.
  assert.equal(safeGitStateDir(), dir);
});

test("the shadow root and the repository it mirrors share one representation", () => {
  // #582 needed BOTH sides to agree: the shadow safeGit builds per call, and the common dir of the
  // repository it shadows. Either one in the unresolved form is enough for git to double a prefix.
  const shadowParent = join(root, "shadows");
  mkdirSync(shadowParent, { mode: 0o700 });
  stateHooks.shadowRoot = shadowParent;

  const repo = fixtureRepo();
  const layout = discoverRepo(repo);
  assert.ok(layout && layout !== "invalid", "the fixture is a repository");
  const commonDir = (layout as { commonDir: string }).commonDir;
  assert.equal(realpathSync(commonDir), commonDir, "a repository's common dir is canonical");

  const shadow = makeShadowRoot();
  try {
    assert.equal(realpathSync(shadow), shadow, "a shadow root is canonical");
    // Same representation: neither side is an alias of the other, so a path built from one can never
    // be resolved against the other's spelling — which is what made git emit /private/private/….
    assert.ok(shadow.startsWith(realpathSync(shadowParent)), "the shadow lives under its parent's canonical path");
    assert.ok(!shadow.includes("/private/private"));
  } finally {
    removeShadow(shadow);
  }
});

test("the common dir git reports through the shadow needs no repair", async () => {
  // The invariant behind #582 and #602, asserted where it actually mattered. safeGit runs git with
  // GIT_COMMON_DIR set to a shadow directory, and `rev-parse --path-format=absolute --git-common-dir`
  // resolves that against the GIT_DIR it is handed. When the two halves of one call spelled the same
  // directory differently (`/var/folders/…` and `/private/var/folders/…`), the answer came back
  // `/private/private/var/folders/…`, and every caller that created a directory under it
  // (`pi-engineering-locks`, `pi-engineering-candidates`) died with ENOENT — 548 failures and one
  // infinite hang, from a spelling.
  //
  // Asserted on git's RAW answer, not on `GitRepo.commonDir()`: #602 made the caller repair a
  // reported path that does not exist by falling back to the discovered layout, so the caller is
  // correct even when the report is wrong. What has to hold is that no repair is needed.
  //
  // Scope, stated because I checked it and it is not what a reader will assume: reverting the
  // `privateDir` canonicalization does NOT trip this test — safeGit canonicalizes the shadow path
  // itself (`realpathOrSelf`), so the two causes are independently guarded. The test that pins
  // `privateDir` is the symlink test above; this one pins the report git is given and the caller's
  // agreement with it.
  const realState = join(root, "state-target");
  mkdirSync(realState, { mode: 0o700 });
  const alias = join(root, "state-alias");
  symlinkSync(realState, alias);
  stateHooks.stateRoot = alias;

  const repo = fixtureRepo();
  const reported = await safeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repo,
    trust: "operator",
  });
  assert.equal(reported.code, 0, reported.stderr);
  const common = reported.stdout.trim();
  assert.doesNotMatch(common, /\/private\/private|\/(var|tmp|Users)\/.*\/\1\//, `doubled prefix: ${common}`);
  assert.equal(realpathSync(common), common, `git reported a path that is not its own canonical form: ${common}`);

  // And the caller must agree with the report — agreement is the invariant; the fallback is a
  // repair we should never be relying on here.
  const g = await GitRepo.open(repo);
  assert.ok(g, "the fixture is a repository");
  assert.equal(await g!.commonDir(), common, "the caller had to repair what git reported");

  // Not just a clean string: the directory has to be creatable, which is what actually broke.
  const locks = join(common, "pi-engineering-locks");
  await mkdir(locks, { mode: 0o700 });
  assert.ok((await lstat(locks)).isDirectory());
});
