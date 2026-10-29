/**
 * Idle spawn storm: a periodic caller (the presence poll) resolved the repository through GitRepo.open every few
 * seconds, and each safeGit call in operator trust re-ran the LFS `ls-files` scan, so an idle session spawned
 * processes ~1.6 times a second forever. Real repositories, real binaries; spawns are counted at safeGit's own
 * spawn points.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { GitRepo, forgetOpenCache } from "../../src/git/GitRepo.ts";
import { forgetRemotePinsForTests, safeGit, stateHooks, testHooks } from "../../src/git/safeGit.ts";

let root = "";
let repo = "";
let spawns: string[][] = [];
const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "PI_ENG_GIT_OPEN_TTL_MS", "PI_ENG_LFS_SCAN_MEMO"];
const prior: Record<string, string | undefined> = {};

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
  repo = join(root, "repo");
  mkdirSync(repo);
  sh(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(["add", "."], repo);
  sh(["commit", "-qm", "init"], repo);
  forgetOpenCache();
  spawns = [];
  testHooks.onSpawn = (argv) => spawns.push([...argv]);
});
afterEach(() => {
  testHooks.onSpawn = undefined;
  for (const k of KEYS) {
    if (prior[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = prior[k];
  }
  stateHooks.stateRoot = undefined;
  forgetRemotePinsForTests();
  forgetOpenCache();
  rmSync(root, { recursive: true, force: true });
});

/** A racily-clean index gets rewritten by the first status; let that happen before measuring. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 1_100));
  sh(["status", "--porcelain"], repo);
};
const status = () => safeGit(["status", "--porcelain"], { cwd: repo, trust: "operator" });

test("the LFS attribute scan runs once for repeated calls on an unchanged index", async () => {
  await settle();
  for (let i = 0; i < 6; i++) assert.equal((await status()).code, 0);
  assert.equal(lsFilesScans(), 1);
});

test("the LFS scan list is refreshed when the index changes (a nested .gitattributes is added)", async () => {
  await settle();
  await status();
  assert.equal(lsFilesScans(), 1);
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", ".gitattributes"), "*.dat filter=lfs diff=lfs merge=lfs -text\n");
  sh(["add", "sub/.gitattributes"], repo);
  await settle();
  await status();
  assert.equal(lsFilesScans(), 2, "a changed index must re-list the tracked attributes files");
  await status();
  assert.equal(lsFilesScans(), 2);
});

test("PI_ENG_LFS_SCAN_MEMO=0 restores a scan per call", async () => {
  process.env.PI_ENG_LFS_SCAN_MEMO = "0";
  for (let i = 0; i < 3; i++) await status();
  assert.equal(lsFilesScans(), 3);
});

test("GitRepo.open answers from its TTL cache without spawning", async () => {
  const first = await GitRepo.open(repo);
  assert.ok(first);
  const after = spawns.length;
  for (let i = 0; i < 20; i++) assert.equal((await GitRepo.open(repo))?.root, first.root);
  assert.equal(spawns.length, after, "cached opens must not spawn");
});

test("PI_ENG_GIT_OPEN_TTL_MS=0 disables the open cache", async () => {
  process.env.PI_ENG_GIT_OPEN_TTL_MS = "0";
  await GitRepo.open(repo);
  const after = spawns.length;
  await GitRepo.open(repo);
  assert.ok(spawns.length > after);
});

test("a non-repository is never cached", async () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.equal(await GitRepo.open(plain), null);
  sh(["init", "-q"], plain);
  assert.ok(await GitRepo.open(plain));
});

test("an idle poll (one open per tick, a minute of 5s ticks) spawns a bounded number of processes", async () => {
  await GitRepo.open(repo);
  spawns = [];
  for (let tick = 0; tick < 12; tick++) await GitRepo.open(repo);
  assert.ok(spawns.length <= 4, `idle polling spawned ${spawns.length} processes`);
});

test("no zombie children remain after a burst of safeGit calls", { skip: process.platform !== "linux" }, async () => {
  await Promise.all(Array.from({ length: 40 }, () => status()));
  await new Promise((r) => setTimeout(r, 200));
  const out = execFileSync("ps", ["--ppid", String(process.pid), "-o", "stat="], { encoding: "utf8" });
  const zombies = out.split("\n").filter((l) => l.trim().startsWith("Z"));
  assert.equal(zombies.length, 0, `defunct children: ${zombies.length}`);
});
