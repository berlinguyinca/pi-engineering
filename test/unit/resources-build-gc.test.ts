/**
 * Issue #145: pressure GC of owned, unreferenced build caches. Real mkdtemp
 * trees; the filesystem pressure reader is the only stub (a test cannot fill a
 * real disk) and it reads the real tree, so removal changes what it reports.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lutimes, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ResourceRegistry } from "../../src/resources/ResourceRegistry.ts";
import { DEFAULT_BUILD_BUDGET, type StatfsReader } from "../../src/resources/buildBudget.ts";
import { pressureGc, safeRemove } from "../../src/resources/buildGc.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const HOUR = 3600_000;

let base: string;
let stateDir: string;
let root: string;
let registry: ResourceRegistry;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pi-build-gc-"));
  stateDir = join(base, "state");
  root = join(stateDir, "build");
  await mkdir(root, { recursive: true });
  registry = new ResourceRegistry(stateDir, "host-a");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Registers a build dir holding one 1 KiB file whose last use was `ageH` hours before NOW. */
async function cache(id: string, mission: string, ageH: number, kind: "build_dir" | "cache" = "build_dir") {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "artifact.bin"), Buffer.alloc(1024, 1));
  const when = new Date(NOW - ageH * HOUR);
  await utimes(dir, when, when);
  await registry.register({
    id,
    kind,
    ownerMissionId: mission,
    ownerExecutionId: `${mission}-x`,
    locator: dir,
    lease: "l",
  });
  return dir;
}

/** Reports warn while more than `keep` registered dirs remain under root, else ok. */
function pressureWhileMoreThan(keep: number, ids: string[]): StatfsReader {
  return async () => {
    const left = ids.filter((id) => existsSync(join(root, id))).length;
    const usedPct = left > keep ? 85 : 50;
    return {
      bsize: 4096,
      blocks: 1000,
      bfree: 1000 - usedPct * 10,
      bavail: 1000 - usedPct * 10,
      files: 1000,
      ffree: 900,
    };
  };
}

const cfg = (statfs: StatfsReader) => ({
  root,
  statfs,
  minIdleMs: HOUR,
  budget: { ...DEFAULT_BUILD_BUDGET, reserveBytes: 0 },
});

describe("safeRemove", () => {
  it("refuses a symlink that escapes the root and leaves the outside tree intact", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "keep");
    const link = join(root, "sneaky");
    await symlink(outside, link);
    await assert.rejects(() => safeRemove(link, root), /outside/);
    assert.ok(existsSync(join(outside, "precious.txt")));
  });

  it("refuses a dot-dot traversal and the root itself", async () => {
    await assert.rejects(() => safeRemove(join(root, "..", "state"), root), /outside|root/);
    await assert.rejects(() => safeRemove(root, root), /root/);
    assert.ok(existsSync(root));
  });

  it("removes a real directory inside the root", async () => {
    const dir = join(root, "plain");
    await mkdir(dir);
    await writeFile(join(dir, "f"), "x");
    await safeRemove(dir, root);
    assert.equal(existsSync(dir), false);
  });

  it("unlinks an in-root symlink without following it", async () => {
    const target = join(root, "real");
    await mkdir(target);
    await writeFile(join(target, "f"), "x");
    const link = join(root, "alias");
    await symlink(target, link);
    await safeRemove(link, root);
    assert.equal(existsSync(link), false);
    assert.ok(existsSync(join(target, "f")));
  });

  it("treats an already missing path as removed", async () => {
    await safeRemove(join(root, "gone"), root);
  });
});

describe("pressureGc", () => {
  it("lists a cache owned by an active mission as skipped and keeps it", async () => {
    const live = await cache("live", "m-active", 48);
    const idle = await cache("idle", "m-done", 47);
    const result = await pressureGc(
      registry,
      cfg(pressureWhileMoreThan(0, ["live", "idle"])),
      (m) => m === "m-active",
      NOW,
    );
    assert.ok(existsSync(live));
    assert.equal(existsSync(idle), false);
    assert.deepEqual(result.removed, ["idle"]);
    assert.deepEqual(
      result.skipped.map((s) => [s.id, s.reason]),
      [["live", "mission_active"]],
    );
    assert.ok(result.bytesFreed >= 1024);
  });

  it("removes the least recently used cache first and stops once pressure is below warn", async () => {
    const oldest = await cache("a-oldest", "m1", 72);
    const middle = await cache("b-middle", "m2", 48);
    const newest = await cache("c-newest", "m3", 24);
    const result = await pressureGc(
      registry,
      cfg(pressureWhileMoreThan(2, ["a-oldest", "b-middle", "c-newest"])),
      () => false,
      NOW,
    );
    assert.deepEqual(result.removed, ["a-oldest"]);
    assert.equal(existsSync(oldest), false);
    assert.ok(existsSync(middle));
    assert.ok(existsSync(newest));
  });

  it("removes nothing when pressure is already ok", async () => {
    const dir = await cache("calm", "m1", 72);
    const result = await pressureGc(registry, cfg(pressureWhileMoreThan(5, ["calm"])), () => false, NOW);
    assert.deepEqual(result.removed, []);
    assert.ok(existsSync(dir));
  });

  it("never touches a cache used within the minimum idle window", async () => {
    const fresh = await cache("fresh", "m1", 0.1);
    const result = await pressureGc(registry, cfg(pressureWhileMoreThan(0, ["fresh"])), () => false, NOW);
    assert.ok(existsSync(fresh));
    assert.deepEqual(
      result.skipped.map((s) => s.reason),
      ["recently_used"],
    );
  });

  it("ignores kinds other than build_dir and cache and other hosts' records", async () => {
    const wt = join(root, "wt");
    await mkdir(wt);
    await registry.register({
      id: "wt",
      kind: "worktree",
      ownerMissionId: "m1",
      ownerExecutionId: "e",
      locator: wt,
      lease: "l",
    });
    const foreign = new ResourceRegistry(stateDir, "host-b");
    const theirs = join(root, "theirs");
    await mkdir(theirs);
    await foreign.register({
      id: "theirs",
      kind: "cache",
      ownerMissionId: "m9",
      ownerExecutionId: "e",
      locator: theirs,
      lease: "l",
    });
    const result = await pressureGc(registry, cfg(pressureWhileMoreThan(0, ["wt", "theirs"])), () => false, NOW);
    assert.ok(existsSync(wt));
    assert.ok(existsSync(theirs));
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      result.skipped.map((s) => s.id),
      ["theirs"],
    );
  });

  it("refuses a registered locator that resolves outside the root, retains the record, and removes nothing outside", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "keep");
    const link = join(root, "escape");
    await symlink(outside, link);
    await lutimes(link, new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
    await registry.register({
      id: "escape",
      kind: "cache",
      ownerMissionId: "m1",
      ownerExecutionId: "e",
      locator: link,
      lease: "l",
    });
    const result = await pressureGc(
      registry,
      cfg(async () => ({ bsize: 4096, blocks: 1000, bfree: 100, bavail: 100, files: 1000, ffree: 900 })),
      () => false,
      NOW,
    );
    assert.ok(existsSync(join(outside, "precious.txt")));
    assert.deepEqual(result.removed, []);
    assert.equal(result.skipped[0]?.id, "escape");
    assert.match(result.skipped[0]?.reason ?? "", /outside/);
    const [record] = await registry.listAll();
    assert.equal(record?.state, "retained");
  });

  it("marks a removed cache released in the registry", async () => {
    await cache("done", "m1", 72);
    await pressureGc(registry, cfg(pressureWhileMoreThan(0, ["done"])), () => false, NOW);
    const [record] = await registry.listAll();
    assert.equal(record?.state, "released");
  });
});
