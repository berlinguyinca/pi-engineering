import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import {
  UNSCOPED_TARGET_KEY,
  findSccache,
  resetRustTargetKeys,
  resetSccacheLookup,
  rustBuildEnv,
  rustCacheEnabled,
  rustCacheRoot,
  rustTargetDir,
  rustTargetKey,
  withRustBuildEnv,
} from "../../src/git/rustBuildCache.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

/** Make a fixture repo a Rust project: a committed minimal Cargo.toml at its root. */
async function makeRust(root: string): Promise<void> {
  await writeFile(join(root, "Cargo.toml"), '[package]\nname = "fx"\nversion = "0.0.0"\nedition = "2021"\n');
  await exec("git", ["-C", root, "add", "Cargo.toml"]);
  await exec("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "cargo"]);
}

/** An env with no operator overrides and an empty PATH (no sccache). */
function bareEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { HOME: "/home/example", PATH: "", ...extra };
}

test("cache root defaults to ~/.rust/cache and honours PI_RUST_CACHE_DIR", () => {
  assert.equal(rustCacheRoot(bareEnv()), join("/home/example", ".rust", "cache"));
  assert.equal(rustCacheRoot(bareEnv({ PI_RUST_CACHE_DIR: "/mnt/fast/rust" })), "/mnt/fast/rust");
  assert.equal(rustCacheRoot(bareEnv({ PI_RUST_CACHE_DIR: "~/other" })), join("/home/example", "other"));
  assert.equal(rustCacheRoot(bareEnv({ PI_RUST_CACHE_DIR: "   " })), join("/home/example", ".rust", "cache"));
});

test("PI_RUST_CACHE=0 (and friends) disables the shared cache", async () => {
  assert.equal(rustCacheEnabled(bareEnv()), true);
  for (const off of ["0", "false", "off", "no", " OFF "]) {
    assert.equal(rustCacheEnabled(bareEnv({ PI_RUST_CACHE: off })), false, off);
  }
  assert.equal(rustCacheEnabled(bareEnv({ PI_RUST_CACHE: "1" })), true);
  assert.deepEqual(await rustBuildEnv(process.cwd(), bareEnv({ PI_RUST_CACHE: "0" })), {});
});

test("each worktree gets its own CARGO_TARGET_DIR under one per-repository dir", async () => {
  resetRustTargetKeys();
  const a = await makeFixtureRepo();
  const b = await makeFixtureRepo();
  await makeRust(a.root);
  await makeRust(b.root);
  const worktree = join(a.root, "..", `wt-${Date.now().toString(36)}`);
  try {
    await exec("git", ["-C", a.root, "worktree", "add", "-q", worktree, "-b", "candidate"]);
    const nested = join(worktree, "src");

    const env = bareEnv({ PI_RUST_CACHE_DIR: "/cache" });
    const main = await rustBuildEnv(a.root, env);
    const fromWorktree = await rustBuildEnv(worktree, env);
    const fromNested = await rustBuildEnv(nested, env);
    const other = await rustBuildEnv(b.root, env);

    assert.ok(main.CARGO_TARGET_DIR?.startsWith(`${join("/cache", "target")}/`), main.CARGO_TARGET_DIR);
    assert.notEqual(
      fromWorktree.CARGO_TARGET_DIR,
      main.CARGO_TARGET_DIR,
      "a worktree never shares a target dir: cargo's path+mtime freshness would serve another checkout's build",
    );
    assert.equal(
      dirname(fromWorktree.CARGO_TARGET_DIR!),
      dirname(main.CARGO_TARGET_DIR!),
      "but it sits under the same per-repository directory",
    );
    assert.equal(fromNested.CARGO_TARGET_DIR, fromWorktree.CARGO_TARGET_DIR, "a subdirectory shares its worktree's");
    assert.notEqual(dirname(other.CARGO_TARGET_DIR!), dirname(main.CARGO_TARGET_DIR!), "unrelated repos differ");
    assert.equal(main.RUSTC_WRAPPER, undefined, "no sccache on an empty PATH");
    assert.equal(main.SCCACHE_DIR, undefined);

    const key = await rustTargetKey(a.root);
    assert.match(key, /^[A-Za-z0-9._-]+-[0-9a-z]+\/[0-9a-z]+$/);
    assert.notEqual(key, UNSCOPED_TARGET_KEY);
    assert.equal(await rustTargetDir(a.root, env), join("/cache", "target", key));
    assert.equal(await rustTargetDir(a.root, { ...env, CARGO_TARGET_DIR: "/mine" }), null, "operator dir is theirs");
    assert.equal(await rustTargetDir(a.root, { ...env, PI_RUST_CACHE: "0" }), null);
  } finally {
    await exec("git", ["-C", a.root, "worktree", "remove", "--force", worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true });
    await a.cleanup();
    await b.cleanup();
  }
});

test("a cwd outside any repository maps to the unscoped key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-cache-"));
  try {
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "fx"\n');
    assert.equal(await rustTargetKey(dir), UNSCOPED_TARGET_KEY);
    const env = await rustBuildEnv(dir, bareEnv({ PI_RUST_CACHE_DIR: "/cache" }));
    assert.equal(env.CARGO_TARGET_DIR, join("/cache", "target", UNSCOPED_TARGET_KEY));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator-set CARGO_TARGET_DIR, RUSTC_WRAPPER and SCCACHE_DIR are never overridden", async () => {
  resetSccacheLookup();
  const bin = await mkdtemp(join(tmpdir(), "pi-sccache-bin-"));
  const crate = await mkdtemp(join(tmpdir(), "pi-rust-crate-"));
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "fx"\n');
  try {
    await writeFile(join(bin, "sccache"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "sccache"), 0o755);
    const found = findSccache(bareEnv({ PATH: bin }));
    assert.equal(found, join(bin, "sccache"));

    const env = bareEnv({ PATH: bin, PI_RUST_CACHE_DIR: "/cache" });
    const auto = await rustBuildEnv(crate, env);
    assert.equal(auto.RUSTC_WRAPPER, join(bin, "sccache"));
    assert.equal(auto.SCCACHE_DIR, join("/cache", "sccache"));

    const pinned = await rustBuildEnv(crate, {
      ...env,
      CARGO_TARGET_DIR: "/custom/target",
      RUSTC_WRAPPER: "/usr/bin/my-wrapper",
      SCCACHE_DIR: "/custom/sccache",
    });
    assert.deepEqual(pinned, {}, "explicit operator values win");

    const wrapperOnly = await rustBuildEnv(crate, { ...env, RUSTC_WRAPPER: "/usr/bin/my-wrapper" });
    assert.ok(wrapperOnly.CARGO_TARGET_DIR, "target dir still shared");
    assert.equal(wrapperOnly.RUSTC_WRAPPER, undefined);
    assert.equal(wrapperOnly.SCCACHE_DIR, undefined, "SCCACHE_DIR only accompanies a wrapper we installed");
  } finally {
    resetSccacheLookup();
    await rm(bin, { recursive: true, force: true });
    await rm(crate, { recursive: true, force: true });
  }
});

test("withRustBuildEnv merges in place and touches nothing on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rust-root-"));
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-cwd-"));
  try {
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "fx"\n');
    const env = bareEnv({ PI_RUST_CACHE_DIR: root });
    const same = await withRustBuildEnv(env, dir);
    assert.equal(same, env);
    assert.equal(env.CARGO_TARGET_DIR, join(root, "target", UNSCOPED_TARGET_KEY));
    const { stdout } = await exec("ls", ["-A", root]);
    assert.equal(stdout.trim(), "", "cargo creates the target dir itself; the runtime only guarantees the root");
    assert.equal((await stat(root)).mode & 0o777, 0o700, "cache root is private to the user");
    const fresh = join(root, "nested", "cache");
    await withRustBuildEnv(bareEnv({ PI_RUST_CACHE_DIR: fresh }), dir);
    assert.equal((await stat(fresh)).mode & 0o777, 0o700, "a root the runtime creates is mode 0700");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("nothing is exported process-wide; sccache is looked up per command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-percmd-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "fx"\n');
  await writeFile(join(bin, "sccache"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "sccache"), 0o755);
  try {
    const env = bareEnv({ PI_RUST_CACHE_DIR: join(dir, "cache"), PATH: bin });
    resetSccacheLookup();
    assert.equal((await rustBuildEnv(dir, env)).RUSTC_WRAPPER, join(bin, "sccache"));
    // sccache disappears after startup: the next command's env simply omits the wrapper.
    await rm(join(bin, "sccache"));
    resetSccacheLookup();
    const after = await rustBuildEnv(dir, env);
    assert.equal(after.RUSTC_WRAPPER, undefined);
    assert.equal(after.SCCACHE_DIR, undefined);
    assert.ok(after.CARGO_TARGET_DIR);
  } finally {
    resetSccacheLookup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("verification stages run with the shared Rust cache in their environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rust-verify-"));
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-project-"));
  const savedRoot = process.env.PI_RUST_CACHE_DIR;
  const savedTarget = process.env.CARGO_TARGET_DIR;
  const expected = join(root, "target", UNSCOPED_TARGET_KEY);
  try {
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "fx"\n');
    process.env.PI_RUST_CACHE_DIR = root;
    process.env.PI_TEST_EXPECTED_TARGET = expected;
    delete process.env.CARGO_TARGET_DIR;
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e 'process.exit(process.env.CARGO_TARGET_DIR === process.env.PI_TEST_EXPECTED_TARGET ? 0 : 1)'",
        },
      }),
    );
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const verifier = new CommandVerifier();
    const profile = await verifier.detect(dir);
    const outcome = await verifier.run(dir, profile, store);
    assert.ok(outcome.passed, `stage must see CARGO_TARGET_DIR=${expected}`);
  } finally {
    if (savedRoot === undefined) delete process.env.PI_RUST_CACHE_DIR;
    else process.env.PI_RUST_CACHE_DIR = savedRoot;
    delete process.env.PI_TEST_EXPECTED_TARGET;
    if (savedTarget !== undefined) process.env.CARGO_TARGET_DIR = savedTarget;
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweepRustCache removes target dirs idle past the threshold and keeps active ones", async () => {
  const { sweepRustCache, rustCacheMaxAgeMs } = await import("../../src/git/rustBuildCache.ts");
  const { utimes } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-rust-sweep-"));
  try {
    assert.equal(rustCacheMaxAgeMs({}), 30 * 86_400_000);
    assert.equal(rustCacheMaxAgeMs({ PI_RUST_CACHE_MAX_AGE_DAYS: "7" }), 7 * 86_400_000);
    const stale = join(root, "target", "old-repo-abc", "wt1");
    const active = join(root, "target", "busy-repo-def", "wt2");
    await mkdir(join(stale, "debug"), { recursive: true });
    await mkdir(join(active, "debug"), { recursive: true });
    await writeFile(join(stale, "debug", ".cargo-lock"), "");
    await writeFile(join(active, "debug", ".cargo-lock"), "");
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const p of [stale, join(stale, "debug"), join(stale, "debug", ".cargo-lock")]) await utimes(p, old, old);
    // The active dir itself is old, but a recent build touched its lock file.
    await utimes(active, old, old);
    const env = { HOME: root, PATH: "", PI_RUST_CACHE_DIR: root };
    const dry = await sweepRustCache({ env, dryRun: true });
    assert.deepEqual(
      dry.removed.map((r) => r.path),
      [stale],
    );
    const { stdout: still } = await exec("ls", [join(root, "target")]);
    assert.match(still, /old-repo-abc/, "dry run removes nothing");
    const report = await sweepRustCache({ env });
    assert.deepEqual(
      report.removed.map((r) => r.path),
      [stale],
    );
    assert.deepEqual(
      report.kept.map((r) => r.path),
      [active],
    );
    const { stdout } = await exec("ls", [join(root, "target")]);
    assert.equal(stdout.trim(), "busy-repo-def", "an emptied repository dir is removed too");
    assert.deepEqual(await sweepRustCache({ env: { ...env, PI_RUST_CACHE: "0" } }), {
      removed: [],
      kept: [],
      dryRun: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two worktrees of one Rust repo share one cache root but get distinct target dirs; a Node repo gets no Rust env", async () => {
  resetRustTargetKeys();
  const rust = await makeFixtureRepo();
  const node = await makeFixtureRepo();
  const wt1 = join(rust.root, "..", `wt1-${Date.now().toString(36)}`);
  const wt2 = join(rust.root, "..", `wt2-${Date.now().toString(36)}`);
  const nodeWt = join(node.root, "..", `nwt-${Date.now().toString(36)}`);
  try {
    await makeRust(rust.root);
    await writeFile(join(node.root, "package.json"), "{}\n");
    await exec("git", ["-C", rust.root, "worktree", "add", "-q", wt1, "-b", "cand-1"]);
    await exec("git", ["-C", rust.root, "worktree", "add", "-q", wt2, "-b", "cand-2"]);
    await exec("git", ["-C", node.root, "worktree", "add", "-q", nodeWt, "-b", "cand-n"]);

    const env = bareEnv({ PI_RUST_CACHE_DIR: "/cache" });
    const one = await rustBuildEnv(wt1, env);
    const two = await rustBuildEnv(wt2, env);
    assert.ok(one.CARGO_TARGET_DIR && two.CARGO_TARGET_DIR);
    assert.notEqual(one.CARGO_TARGET_DIR, two.CARGO_TARGET_DIR, "distinct target dirs");
    assert.equal(dirname(one.CARGO_TARGET_DIR), dirname(two.CARGO_TARGET_DIR), "one per-repository cache location");

    // The shared dependency cache is the same for both when sccache exists.
    const bin = await mkdtemp(join(tmpdir(), "pi-sccache-two-"));
    try {
      await writeFile(join(bin, "sccache"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin, "sccache"), 0o755);
      resetSccacheLookup();
      const withCache = bareEnv({ PI_RUST_CACHE_DIR: "/cache", PATH: bin });
      const a = await rustBuildEnv(wt1, withCache);
      const b = await rustBuildEnv(wt2, withCache);
      assert.equal(a.SCCACHE_DIR, b.SCCACHE_DIR);
      assert.equal(a.SCCACHE_DIR, join("/cache", "sccache"));
      assert.deepEqual(await rustBuildEnv(nodeWt, withCache), {}, "Node repo worktree: no Rust env, even with sccache");
    } finally {
      resetSccacheLookup();
      await rm(bin, { recursive: true, force: true });
    }
    assert.deepEqual(await rustBuildEnv(node.root, env), {}, "Node repo: no Rust env vars");
  } finally {
    for (const [repo, wt] of [
      [rust.root, wt1],
      [rust.root, wt2],
      [node.root, nodeWt],
    ] as const) {
      await exec("git", ["-C", repo, "worktree", "remove", "--force", wt]).catch(() => {});
      await rm(wt, { recursive: true, force: true });
    }
    await rust.cleanup();
    await node.cleanup();
  }
});
