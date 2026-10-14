import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import {
  UNSCOPED_TARGET_KEY,
  applyRustBuildEnvToProcess,
  findSccache,
  resetRustTargetKeys,
  resetSccacheLookup,
  rustBuildEnv,
  rustCacheEnabled,
  rustCacheRoot,
  rustTargetKey,
  withRustBuildEnv,
} from "../../src/git/rustBuildCache.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

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

test("a repository and its linked worktrees share one CARGO_TARGET_DIR; other repos do not", async () => {
  resetRustTargetKeys();
  const a = await makeFixtureRepo();
  const b = await makeFixtureRepo();
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
    assert.equal(fromWorktree.CARGO_TARGET_DIR, main.CARGO_TARGET_DIR, "worktree must share the main checkout's cache");
    assert.equal(fromNested.CARGO_TARGET_DIR, main.CARGO_TARGET_DIR, "subdirectory of a worktree shares it too");
    assert.notEqual(other.CARGO_TARGET_DIR, main.CARGO_TARGET_DIR, "unrelated repositories get their own cache");
    assert.equal(main.RUSTC_WRAPPER, undefined, "no sccache on an empty PATH");
    assert.equal(main.SCCACHE_DIR, undefined);

    const key = await rustTargetKey(a.root);
    assert.match(key, /^[A-Za-z0-9._-]+-[0-9a-z]+$/);
    assert.notEqual(key, UNSCOPED_TARGET_KEY);
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
  try {
    await writeFile(join(bin, "sccache"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "sccache"), 0o755);
    const found = findSccache(bareEnv({ PATH: bin }));
    assert.equal(found, join(bin, "sccache"));

    const env = bareEnv({ PATH: bin, PI_RUST_CACHE_DIR: "/cache" });
    const auto = await rustBuildEnv(process.cwd(), env);
    assert.equal(auto.RUSTC_WRAPPER, join(bin, "sccache"));
    assert.equal(auto.SCCACHE_DIR, join("/cache", "sccache"));

    const pinned = await rustBuildEnv(process.cwd(), {
      ...env,
      CARGO_TARGET_DIR: "/custom/target",
      RUSTC_WRAPPER: "/usr/bin/my-wrapper",
      SCCACHE_DIR: "/custom/sccache",
    });
    assert.deepEqual(pinned, {}, "explicit operator values win");

    const wrapperOnly = await rustBuildEnv(process.cwd(), { ...env, RUSTC_WRAPPER: "/usr/bin/my-wrapper" });
    assert.ok(wrapperOnly.CARGO_TARGET_DIR, "target dir still shared");
    assert.equal(wrapperOnly.RUSTC_WRAPPER, undefined);
    assert.equal(wrapperOnly.SCCACHE_DIR, undefined, "SCCACHE_DIR only accompanies a wrapper we installed");
  } finally {
    resetSccacheLookup();
    await rm(bin, { recursive: true, force: true });
  }
});

test("withRustBuildEnv merges in place and creates the cache directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rust-root-"));
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-cwd-"));
  try {
    const env = bareEnv({ PI_RUST_CACHE_DIR: root });
    const same = await withRustBuildEnv(env, dir);
    assert.equal(same, env);
    assert.equal(env.CARGO_TARGET_DIR, join(root, "target", UNSCOPED_TARGET_KEY));
    const { stdout } = await exec("ls", [join(root, "target")]);
    assert.equal(stdout.trim(), UNSCOPED_TARGET_KEY);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyRustBuildEnvToProcess exports the cache to process.env for inherited children", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rust-proc-"));
  const saved = {
    PI_RUST_CACHE_DIR: process.env.PI_RUST_CACHE_DIR,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR,
    RUSTC_WRAPPER: process.env.RUSTC_WRAPPER,
    SCCACHE_DIR: process.env.SCCACHE_DIR,
  };
  try {
    delete process.env.CARGO_TARGET_DIR;
    delete process.env.RUSTC_WRAPPER;
    delete process.env.SCCACHE_DIR;
    process.env.PI_RUST_CACHE_DIR = root;
    const added = await applyRustBuildEnvToProcess(root);
    assert.ok(added.CARGO_TARGET_DIR?.startsWith(join(root, "target")));
    assert.equal(process.env.CARGO_TARGET_DIR, added.CARGO_TARGET_DIR);
    const { stdout } = await exec("sh", ["-c", 'printf %s "$CARGO_TARGET_DIR"']);
    assert.equal(stdout, added.CARGO_TARGET_DIR, "a child inherits it");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("verification stages run with the shared Rust cache in their environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rust-verify-"));
  const dir = await mkdtemp(join(tmpdir(), "pi-rust-project-"));
  const savedRoot = process.env.PI_RUST_CACHE_DIR;
  const savedTarget = process.env.CARGO_TARGET_DIR;
  const expected = join(root, "target", UNSCOPED_TARGET_KEY);
  try {
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
