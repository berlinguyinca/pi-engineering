/**
 * Issue #144: per-mission build directories and disk admission. Limits come
 * from the budget they protect (spec R-BUILD): warn at 80 percent, refuse new
 * builds at 90 percent or below the free-space reserve, bytes AND inodes.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { ResourceRegistry } from "../../src/resources/ResourceRegistry.ts";
import {
  DEFAULT_BUILD_BUDGET,
  FAILURE_ARTIFACT_RETENTION_MS,
  LOG_RETENTION_MS,
  type StatfsReader,
  diskPressure,
  missionTargetDir,
} from "../../src/resources/buildBudget.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";

const GiB = 1024 ** 3;

/** A filesystem of `blocks` 4 KiB blocks and `files` inodes with the given used fractions. */
function fs(opts: { bytesUsed: number; inodesUsed: number; blocks?: number; files?: number }): StatfsReader {
  const blocks = opts.blocks ?? 100 * 1024 * 1024; // 400 GiB
  const files = opts.files ?? 10_000_000;
  return async () => ({
    bsize: 4096,
    blocks,
    bfree: Math.round(blocks * (1 - opts.bytesUsed)),
    bavail: Math.round(blocks * (1 - opts.bytesUsed)),
    files,
    ffree: Math.round(files * (1 - opts.inodesUsed)),
  });
}

describe("diskPressure", () => {
  it("defaults follow the spec: 40 GiB cache, 100 GiB target, warn 80, stop 90", () => {
    assert.equal(DEFAULT_BUILD_BUDGET.cacheBytes, 40 * GiB);
    assert.equal(DEFAULT_BUILD_BUDGET.targetBytes, 100 * GiB);
    assert.equal(DEFAULT_BUILD_BUDGET.warnPct, 80);
    assert.equal(DEFAULT_BUILD_BUDGET.stopPct, 90);
    assert.equal(FAILURE_ARTIFACT_RETENTION_MS, 24 * 3600_000);
    assert.equal(LOG_RETENTION_MS, 7 * 24 * 3600_000);
  });

  it("is ok well below the thresholds", async () => {
    const p = await diskPressure("/x", DEFAULT_BUILD_BUDGET, fs({ bytesUsed: 0.5, inodesUsed: 0.1 }));
    assert.equal(p.level, "ok");
  });

  it("returns warn at 85 percent byte use", async () => {
    const p = await diskPressure("/x", DEFAULT_BUILD_BUDGET, fs({ bytesUsed: 0.85, inodesUsed: 0.1 }));
    assert.equal(p.level, "warn");
    assert.ok(Math.abs(p.bytesUsedPct - 85) < 0.5, String(p.bytesUsedPct));
  });

  it("returns stop at 91 percent inode use with free bytes available", async () => {
    const p = await diskPressure("/x", DEFAULT_BUILD_BUDGET, fs({ bytesUsed: 0.1, inodesUsed: 0.91 }));
    assert.equal(p.level, "stop");
    assert.ok(p.freeBytes > 100 * GiB, "bytes are plentiful; the inode count alone stops it");
    assert.ok(Math.abs(p.inodesUsedPct - 91) < 0.5, String(p.inodesUsedPct));
    assert.match(p.reason ?? "", /inode/);
  });

  it("returns stop at 90 percent byte use", async () => {
    const p = await diskPressure("/x", DEFAULT_BUILD_BUDGET, fs({ bytesUsed: 0.9, inodesUsed: 0.1 }));
    assert.equal(p.level, "stop");
  });

  it("returns stop below the free-space reserve even when the percentages are low", async () => {
    const small = fs({ bytesUsed: 0.5, inodesUsed: 0.1, blocks: 10 * 1024 * 1024 }); // 40 GiB, 20 GiB free
    const p = await diskPressure("/x", { ...DEFAULT_BUILD_BUDGET, reserveBytes: 30 * GiB }, small);
    assert.equal(p.level, "stop");
    assert.match(p.reason ?? "", /reserve/);
  });

  it("ignores inodes on a filesystem that reports none (files = 0)", async () => {
    const p = await diskPressure("/x", DEFAULT_BUILD_BUDGET, fs({ bytesUsed: 0.1, inodesUsed: 0, files: 0 }));
    assert.equal(p.level, "ok");
  });

  it("reads the real filesystem when no reader is injected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-budget-"));
    try {
      const p = await diskPressure(dir, { ...DEFAULT_BUILD_BUDGET, reserveBytes: 0, stopPct: 100.1, warnPct: 100.1 });
      assert.equal(p.level, "ok");
      assert.ok(p.totalBytes > 0 && p.freeBytes >= 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("measures an existing ancestor when the build dir does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-budget-"));
    try {
      const p = await diskPressure(join(dir, "not", "yet", "there"), { ...DEFAULT_BUILD_BUDGET, reserveBytes: 0 });
      assert.ok(p.totalBytes > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("missionTargetDir", () => {
  it("gives two missions 2 distinct directories under the state dir", () => {
    const a = missionTargetDir("/state", "mission-a");
    const b = missionTargetDir("/state", "mission-b");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("/state/"));
    assert.equal(a, missionTargetDir("/state", "mission-a"));
  });

  it("cannot be steered out of the state dir by a hostile mission id", () => {
    const dir = missionTargetDir("/state", "../../etc/x");
    assert.ok(dir.startsWith("/state/"), dir);
    assert.ok(!dir.includes(".."), dir);
    assert.notEqual(missionTargetDir("/state", "a/b"), missionTargetDir("/state", "a-b"));
  });

  it("rejects an empty mission id", () => {
    assert.throws(() => missionTargetDir("/state", "  "));
  });
});

describe("Verifier stage env", () => {
  let dir: string;
  let stateDir: string;
  let saved: string | undefined;
  let savedCache: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-budget-ver-"));
    stateDir = join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
    saved = process.env.CARGO_TARGET_DIR;
    savedCache = process.env.PI_RUST_CACHE;
    delete process.env.CARGO_TARGET_DIR;
    // Keep the machine-wide worktree cache out of this test; the mission dir is independent of it.
    process.env.PI_RUST_CACHE = "0";
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = saved;
    if (savedCache === undefined) delete process.env.PI_RUST_CACHE;
    else process.env.PI_RUST_CACHE = savedCache;
    await rm(dir, { recursive: true, force: true });
  });

  const profile = (cwd: string) => ({
    name: "rust",
    stages: [
      {
        name: "probe",
        command: "node",
        args: ["-e", "require('fs').writeFileSync('target-dir.txt', process.env.CARGO_TARGET_DIR || '')"],
        required: true,
        cwd,
      },
    ],
  });

  it("two missions get 2 distinct CARGO_TARGET_DIR values, each registered as an owned build_dir", async () => {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const registry = new ResourceRegistry(stateDir, "host-1");
    const seen: string[] = [];
    for (const missionId of ["mission-a", "mission-b"]) {
      const outcome = await new CommandVerifier().run(dir, profile(dir), store, {
        missionId,
        build: { stateDir, registry, statfs: fs({ bytesUsed: 0.1, inodesUsed: 0.1 }) },
      });
      assert.equal(outcome.passed, true);
      seen.push(await readFile(join(dir, "target-dir.txt"), "utf8"));
    }
    assert.notEqual(seen[0], seen[1]);
    assert.equal(seen[0], missionTargetDir(stateDir, "mission-a"));
    assert.equal(seen[1], missionTargetDir(stateDir, "mission-b"));
    const owned = await registry.listOwned("mission-a");
    assert.equal(owned.length, 1);
    assert.equal(owned[0]?.kind, "build_dir");
    assert.equal(owned[0]?.locator, seen[0]);
    assert.ok((await stat(seen[0]!)).isDirectory(), "the directory exists before the build runs");
  });

  it("fails the stage before running when the disk is at the stop level", async () => {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const outcome = await new CommandVerifier().run(dir, profile(dir), store, {
      missionId: "mission-a",
      build: { stateDir, statfs: fs({ bytesUsed: 0.1, inodesUsed: 0.95 }) },
    });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.stages[0]?.summary.infrastructureFailure, true);
    assert.equal(outcome.stages[0]?.summary.buildPressure, "stop");
    await assert.rejects(stat(join(dir, "target-dir.txt")), "the command must not have run");
  });

  it("records a warning at the warn level and still runs", async () => {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const outcome = await new CommandVerifier().run(dir, profile(dir), store, {
      missionId: "mission-a",
      build: { stateDir, statfs: fs({ bytesUsed: 0.85, inodesUsed: 0.1 }) },
    });
    assert.equal(outcome.passed, true);
    assert.equal(outcome.stages[0]?.summary.buildPressure, "warn");
  });

  it("leaves a non-Rust directory and a run without a mission untouched", async () => {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    await new CommandVerifier().run(dir, profile(dir), store);
    assert.notEqual(await readFile(join(dir, "target-dir.txt"), "utf8"), missionTargetDir(stateDir, "mission-a"));
    await rm(join(dir, "Cargo.toml"));
    await new CommandVerifier().run(dir, profile(dir), store, { missionId: "mission-a", build: { stateDir } });
    assert.equal(await readFile(join(dir, "target-dir.txt"), "utf8"), "");
  });

  it("an operator-set CARGO_TARGET_DIR wins over the mission directory", async () => {
    process.env.CARGO_TARGET_DIR = join(dir, "operator-target");
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    await new CommandVerifier().run(dir, profile(dir), store, {
      missionId: "mission-a",
      build: { stateDir, statfs: fs({ bytesUsed: 0.1, inodesUsed: 0.1 }) },
    });
    assert.equal(await readFile(join(dir, "target-dir.txt"), "utf8"), join(dir, "operator-target"));
  });
});
