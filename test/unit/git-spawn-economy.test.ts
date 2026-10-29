/**
 * Idle spawn storm: a periodic caller (the presence poll) resolved the repository through GitRepo.open every few
 * seconds, and each safeGit call in operator trust re-ran the LFS `ls-files` scan, so an idle session spawned
 * processes ~1.6 times a second forever. Real repositories, real binaries; spawns are counted at safeGit's own
 * spawn points.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { GitRepo, forgetOpenCache } from "../../src/git/GitRepo.ts";
import { RepoKeyResolver } from "../../src/git/repoKey.ts";
import { forgetRemotePinsForTests, safeGit, stateHooks, testHooks } from "../../src/git/safeGit.ts";

let root = "";
let repo = "";
let spawns: string[][] = [];
const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "PI_ENG_GIT_OPEN_TTL_MS", "PI_ENG_LFS_SCAN_MEMO"];
const prior: Record<string, string | undefined> = {};
const LONG_AGO = new Date(Date.now() - 3_600_000);

const sh = (args: string[], cwd: string) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
const lsFilesScans = () => spawns.filter((a) => a.includes("ls-files") && a.includes(".gitattributes")).length;
/** Files older than the index they are staged into are never "racily clean", so status does not rewrite the index. */
const write = (dir: string, name: string, text: string) => {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), text);
  utimesSync(join(dir, name), LONG_AGO, LONG_AGO);
};
const newRepo = (name: string, attrs: string): string => {
  const dir = join(root, name);
  mkdirSync(dir);
  sh(["init", "-q", "-b", "main"], dir);
  write(dir, ".gitattributes", attrs);
  write(dir, "a.txt", "a\n");
  sh(["add", "."], dir);
  sh(["commit", "-qm", "init"], dir);
  return dir;
};
const LFS = (glob: string) => `${glob} filter=lfs diff=lfs merge=lfs -text\n`;
const status = (cwd = repo) => safeGit(["status", "--porcelain"], { cwd, trust: "operator" });
const filterOf = async (file: string) =>
  (await safeGit(["check-attr", "filter", "--", file], { cwd: repo, trust: "operator" })).stdout.trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spawn-economy-"));
  stateHooks.stateRoot = join(root, "state");
  for (const k of KEYS) prior[k] = process.env[k];
  mkdirSync(join(root, "home"));
  writeFileSync(
    join(root, "operator.gitconfig"),
    `[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[user]\n\tname = op\n\temail = op@x\n`,
  );
  process.env.HOME = join(root, "home");
  process.env.GIT_CONFIG_GLOBAL = join(root, "operator.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  Reflect.deleteProperty(process.env, "PI_ENG_GIT_OPEN_TTL_MS");
  Reflect.deleteProperty(process.env, "PI_ENG_LFS_SCAN_MEMO");
  repo = newRepo("repo", LFS("*.bin"));
  forgetOpenCache();
  spawns = [];
  testHooks.onSpawn = (argv) => spawns.push([...argv]);
});
afterEach(() => {
  testHooks.onSpawn = undefined;
  testHooks.lfsListTtlMs = undefined;
  for (const k of KEYS) {
    if (prior[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = prior[k];
  }
  stateHooks.stateRoot = undefined;
  forgetRemotePinsForTests();
  forgetOpenCache();
  rmSync(root, { recursive: true, force: true });
});

test("the LFS attribute scan runs once for repeated calls on an unchanged index", async () => {
  for (let i = 0; i < 6; i++) assert.equal((await status()).code, 0);
  assert.equal(lsFilesScans(), 1);
});

test("editing an existing .gitattributes changes the generated LFS attributes while the listing memo is live", async () => {
  await status();
  assert.equal(lsFilesScans(), 1);
  assert.match(await filterOf("x.bin"), /filter: lfs/);
  assert.match(await filterOf("x.dat"), /filter: unspecified/);
  write(repo, ".gitattributes", LFS("*.dat"));
  assert.match(await filterOf("x.dat"), /filter: lfs/, "the new content must apply at once");
  assert.match(await filterOf("x.bin"), /filter: unspecified/);
  assert.equal(lsFilesScans(), 1, "the listing itself stayed memoized (the index did not change)");
});

test("the LFS listing is refreshed when the index changes (a nested .gitattributes is added)", async () => {
  await status();
  write(repo, "sub/.gitattributes", LFS("*.dat"));
  sh(["add", "sub/.gitattributes"], repo);
  await status();
  assert.equal(lsFilesScans(), 2, "a changed index must re-list the tracked attributes files");
  assert.match(await filterOf("sub/x.dat"), /filter: lfs/);
  await status();
  assert.equal(lsFilesScans(), 2);
});

test("the LFS listing memo expires after its TTL", async () => {
  testHooks.lfsListTtlMs = 40;
  await status();
  await status();
  assert.equal(lsFilesScans(), 1);
  await new Promise((r) => setTimeout(r, 80));
  await status();
  assert.equal(lsFilesScans(), 2);
});

test("PI_ENG_LFS_SCAN_MEMO=0 restores a scan per call", async () => {
  process.env.PI_ENG_LFS_SCAN_MEMO = "0";
  for (let i = 0; i < 3; i++) await status();
  assert.equal(lsFilesScans(), 3);
});

test("the memo is isolated per repository and per linked worktree", async () => {
  const other = newRepo("other", LFS("*.dat"));
  await status();
  await status(other);
  assert.equal(lsFilesScans(), 2, "each repository scans for itself");
  const linked = join(root, "linked");
  sh(["worktree", "add", "-q", "-b", "wt", linked], repo);
  for (const f of [".gitattributes", "a.txt"]) utimesSync(join(linked, f), LONG_AGO, LONG_AGO);
  sh(["status", "--porcelain"], linked);
  spawns = [];
  await status(linked);
  assert.equal(lsFilesScans(), 1, "a linked worktree has its own index and its own entry");
  await status();
  await status(other);
  await status(linked);
  assert.equal(lsFilesScans(), 1);
});

test("GitRepo.open is uncached by default: a deleted or moved repository is seen at once", async () => {
  const first = await GitRepo.open(repo);
  assert.ok(first);
  const moved = `${repo}-moved`;
  renameSync(repo, moved);
  assert.equal(await GitRepo.open(repo), null);
  assert.ok(await GitRepo.open(moved));
  rmSync(moved, { recursive: true, force: true });
  assert.equal(await GitRepo.open(moved), null);
});

test("an opted-in cached open spawns nothing on a hit, and revalidates a moved repository", async () => {
  const first = await GitRepo.open(repo, undefined, { cacheMs: 60_000 });
  assert.ok(first);
  const after = spawns.length;
  for (let i = 0; i < 20; i++)
    assert.equal((await GitRepo.open(repo, undefined, { cacheMs: 60_000 }))?.root, first.root);
  assert.equal(spawns.length, after, "cached opens must not spawn");
  const aborted = AbortSignal.abort();
  assert.equal(await GitRepo.open(repo, aborted, { cacheMs: 60_000 }), null, "an aborted signal never uses the cache");
  renameSync(repo, `${repo}-moved`);
  assert.equal(await GitRepo.open(repo, undefined, { cacheMs: 60_000 }), null);
});

test("idle presence ticks (RepoKeyResolver.lookup, as refreshPresence does) spawn no git", async () => {
  const runtimes = new Map<string, string>([[(await GitRepo.open(repo))?.root as string, "runtime"]]);
  const keys = new RepoKeyResolver();
  assert.equal(await keys.lookup(repo, runtimes), "runtime");
  spawns = [];
  for (let tick = 0; tick < 12; tick++) assert.equal(await keys.lookup(repo, runtimes), "runtime");
  assert.equal(spawns.length, 0, `idle ticks spawned ${spawns.length} processes`);
});

test("a stale remembered key falls through to a fresh resolve; a non-repository key is never remembered", async () => {
  const keys = new RepoKeyResolver();
  const real = await keys.resolve(repo);
  assert.equal(keys.cached(repo), real);
  const rekeyed = new Map<string, string>([["/somewhere/else", "old"]]);
  assert.equal(await keys.lookup(repo, rekeyed), undefined);
  rekeyed.set(real, "runtime");
  assert.equal(await keys.lookup(repo, rekeyed), "runtime");
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.equal(await keys.resolve(plain), plain);
  assert.equal(keys.cached(plain), undefined);
});
