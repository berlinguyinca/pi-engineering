/**
 * Issue #149: a fingerprinted test result cache. A passing stage result is
 * reused only when source tree, lockfiles, toolchain, command, an explicit
 * environment allowlist and the base SHA all match exactly; failures are never
 * cached. Tree hashes come from real git fixture repos.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import type { StageRun } from "../../src/verify/Verifier.ts";
import {
  DEFAULT_ENV_ALLOWLIST,
  type FingerprintInput,
  TestResultCache,
  collectFingerprintInput,
  fingerprint,
  lockfileHashes,
  stageCommand,
  toolchainString,
  treeHash,
} from "../../src/verify/testResultCache.ts";

const run = promisify(execFile);

let root: string;
let repo: string;
let stateDir: string;
const g = async (...args: string[]) => (await run("git", ["-C", repo, ...args])).stdout.trim();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-trc-"));
  repo = join(root, "repo");
  stateDir = join(root, "state");
  await mkdir(repo);
  await run("git", ["init", "-q", "-b", "main", repo]);
  await g("config", "user.email", "t@example.com");
  await g("config", "user.name", "T");
  await writeFile(join(repo, "a.txt"), "hello\n");
  await writeFile(join(repo, ".gitignore"), "ignored.log\n");
  await g("add", "-A");
  await g("commit", "-q", "-m", "init");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const base: FingerprintInput = {
  treeHash: "t".repeat(40),
  lockHashes: { "package-lock.json": "l1" },
  toolchain: "node v22.0.0",
  command: "node --test",
  env: { NODE_ENV: "test" },
  baseSha: "b".repeat(40),
};

const passingRun = (name = "test"): StageRun => ({
  stage: { name, command: "node", args: ["--test"], required: true },
  exitCode: 0,
  passed: true,
  summary: { tests: 3 },
  artifactUri: "artifact://x",
  durationMs: 12,
});

describe("fingerprint", () => {
  it("is a stable 64 hex digest independent of key order", () => {
    const a = fingerprint(base);
    assert.match(a, /^[0-9a-f]{64}$/);
    const reordered: FingerprintInput = {
      ...base,
      env: { NODE_ENV: "test" },
      lockHashes: { "package-lock.json": "l1" },
    };
    assert.equal(fingerprint(reordered), a);
    assert.equal(fingerprint({ ...base, env: { B: "2", A: "1" } }), fingerprint({ ...base, env: { A: "1", B: "2" } }));
  });

  it("changes when any single input changes", () => {
    const variants: FingerprintInput[] = [
      { ...base, treeHash: "u".repeat(40) },
      { ...base, lockHashes: { "package-lock.json": "l2" } },
      { ...base, lockHashes: { ...base.lockHashes, "Cargo.lock": "c" } },
      { ...base, toolchain: "node v22.0.1" },
      { ...base, command: "node --test --watch" },
      { ...base, env: { NODE_ENV: "production" } },
      { ...base, env: {} },
      { ...base, baseSha: "c".repeat(40) },
    ];
    const seen = new Set([fingerprint(base)]);
    for (const v of variants) seen.add(fingerprint(v));
    assert.equal(seen.size, variants.length + 1);
  });

  it("does not let adjacent fields trade characters", () => {
    assert.notEqual(
      fingerprint({ ...base, command: "a", toolchain: "bc" }),
      fingerprint({ ...base, command: "ab", toolchain: "c" }),
    );
  });
});

describe("collectFingerprintInput from a real repo", () => {
  const collect = (over: Partial<Parameters<typeof collectFingerprintInput>[0]> = {}) =>
    collectFingerprintInput({
      cwd: repo,
      command: "node --test",
      baseSha: "b".repeat(40),
      toolchain: "node v22",
      env: {},
      ...over,
    });

  it("changing 1 byte in a tracked file changes the fingerprint (committed or not)", async () => {
    const before = fingerprint(await collect());
    await writeFile(join(repo, "a.txt"), "hellp\n");
    const dirty = fingerprint(await collect());
    assert.notEqual(dirty, before);
    await g("commit", "-aq", "-m", "edit");
    assert.equal(fingerprint(await collect()), dirty, "same content, committed, is the same source tree");
  });

  it("an untracked file counts, an ignored file does not, and the repo is left untouched", async () => {
    const before = fingerprint(await collect());
    await writeFile(join(repo, "ignored.log"), "noise");
    assert.equal(fingerprint(await collect()), before);
    await writeFile(join(repo, "new.txt"), "x");
    assert.notEqual(fingerprint(await collect()), before);
    const status = await g("status", "--porcelain");
    assert.equal(status, "?? new.txt", "the real index must not be modified");
  });

  it("is independent of file mtimes", async () => {
    const before = await treeHash(repo);
    const t = new Date(Date.now() - 86_400_000);
    await utimes(join(repo, "a.txt"), t, t);
    assert.equal(await treeHash(repo), before);
  });

  it("finds lockfiles anywhere in the tree, tracked or new, and hashes their content", async () => {
    assert.deepEqual(await lockfileHashes(repo), {});
    await mkdir(join(repo, "web"));
    await writeFile(join(repo, "web", "package-lock.json"), "{}");
    await writeFile(join(repo, "Cargo.lock"), "v1");
    const first = await lockfileHashes(repo);
    assert.deepEqual(Object.keys(first).sort(), ["Cargo.lock", "web/package-lock.json"]);
    await writeFile(join(repo, "Cargo.lock"), "v2");
    const second = await lockfileHashes(repo);
    assert.notEqual(second["Cargo.lock"], first["Cargo.lock"]);
    assert.equal(second["web/package-lock.json"], first["web/package-lock.json"]);
  });

  it("only allowlisted environment variables take part", async () => {
    const before = fingerprint(await collect({ env: { RUSTFLAGS: "-O", UNRELATED: "1" } }));
    assert.equal(fingerprint(await collect({ env: { RUSTFLAGS: "-O", UNRELATED: "2" } })), before);
    assert.notEqual(fingerprint(await collect({ env: { RUSTFLAGS: "-C debuginfo=2", UNRELATED: "1" } })), before);
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes("RUSTFLAGS"));
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes("NODE_ENV"));
    const custom = fingerprint(await collect({ env: { MY_FLAG: "a" }, envAllowlist: ["MY_FLAG"] }));
    assert.notEqual(custom, fingerprint(await collect({ env: { MY_FLAG: "b" }, envAllowlist: ["MY_FLAG"] })));
  });

  it("changing baseSha alone changes the fingerprint", async () => {
    assert.notEqual(
      fingerprint(await collect({ baseSha: "1".repeat(40) })),
      fingerprint(await collect({ baseSha: "2".repeat(40) })),
    );
  });

  it("rejects an empty base SHA: a cache without a base proves nothing about integration", async () => {
    await assert.rejects(() => collect({ baseSha: "" }), /baseSha/);
  });

  it("builds the command string from a stage", () => {
    assert.equal(stageCommand({ command: "cargo", args: ["nextest", "run"] }), "cargo nextest run");
  });

  it("reads the toolchain version string for named tools", async () => {
    const s = await toolchainString(["node"]);
    assert.match(s, /^node: v\d+\./);
    assert.match(await toolchainString(["definitely-not-installed-tool"]), /definitely-not-installed-tool: absent/);
  });
});

describe("TestResultCache", () => {
  const fp = fingerprint(base);

  it("returns null on a miss and a stored passing run on a hit, across instances", async () => {
    const cache = new TestResultCache(stateDir);
    assert.equal(await cache.get(fp), null);
    await cache.put(fp, passingRun());
    const hit = await new TestResultCache(stateDir).get(fp);
    assert.deepEqual(hit, passingRun());
  });

  it("put of a failed run leaves get returning null", async () => {
    const cache = new TestResultCache(stateDir);
    await cache.put(fp, { ...passingRun(), passed: false, exitCode: 1 });
    await cache.put(fp, { ...passingRun(), passed: true, exitCode: 2 });
    await cache.put(fp, { ...passingRun(), passed: false, exitCode: 0 });
    assert.equal(await cache.get(fp), null);
    assert.deepEqual(await readdir(join(stateDir, "test-results")).catch(() => []), []);
  });

  it("a failed run never replaces an earlier pass", async () => {
    const cache = new TestResultCache(stateDir);
    await cache.put(fp, passingRun());
    await cache.put(fp, { ...passingRun(), passed: false, exitCode: 1 });
    assert.deepEqual(await cache.get(fp), passingRun());
  });

  it("changing baseSha alone causes a cache miss", async () => {
    const cache = new TestResultCache(stateDir);
    await cache.put(fp, passingRun());
    assert.notEqual(await cache.get(fingerprint({ ...base, baseSha: "d".repeat(40) })), passingRun());
    assert.equal(await cache.get(fingerprint({ ...base, baseSha: "d".repeat(40) })), null);
  });

  it("treats a corrupt, foreign or tampered entry as a miss", async () => {
    const cache = new TestResultCache(stateDir);
    await cache.put(fp, passingRun());
    const file = join(stateDir, "test-results", `${fp}.json`);
    const entry = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, "{ not json");
    assert.equal(await cache.get(fp), null);
    await writeFile(file, JSON.stringify({ ...entry, fingerprint: "0".repeat(64) }));
    assert.equal(await cache.get(fp), null);
    await writeFile(file, JSON.stringify({ ...entry, run: { ...entry.run, passed: false } }));
    assert.equal(await cache.get(fp), null);
    await writeFile(file, JSON.stringify({ ...entry, schemaVersion: 99 }));
    assert.equal(await cache.get(fp), null);
  });

  it("refuses a fingerprint that is not a digest (no path traversal)", async () => {
    const cache = new TestResultCache(stateDir);
    await assert.rejects(() => cache.put("../../escape", passingRun()), /fingerprint/);
    await assert.rejects(() => cache.get("../../escape"), /fingerprint/);
  });

  it("bounds the number of stored entries, dropping the oldest", async () => {
    const cache = new TestResultCache(stateDir, { maxEntries: 3 });
    const fps = [0, 1, 2, 3].map((i) => fingerprint({ ...base, command: `c${i}` }));
    for (const [i, f] of fps.entries()) {
      await cache.put(f, passingRun());
      const when = new Date(Date.now() - (10 - i) * 1000);
      await utimes(join(stateDir, "test-results", `${f}.json`), when, when);
    }
    assert.equal(await cache.get(fps[0] as string), null);
    assert.notEqual(await cache.get(fps[3] as string), null);
    assert.equal((await readdir(join(stateDir, "test-results"))).length, 3);
  });
});
