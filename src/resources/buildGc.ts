import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { MissionActivity, ResourceRecord, ResourceRegistry } from "./ResourceRegistry.ts";
import {
  type BuildBudgetConfig,
  DEFAULT_BUILD_BUDGET,
  type DiskPressure,
  type StatfsReader,
  diskPressure,
} from "./buildBudget.ts";

/**
 * Pressure garbage collection of build caches (autospec R-BUILD, issue #145).
 *
 * Under disk pressure this removes only what the {@link ResourceRegistry} says
 * this host owns, of kind `build_dir` or `cache`, whose owning mission is not
 * active and that has not been used within `minIdleMs`; least recently used
 * first, stopping as soon as pressure is back below the warn level. Release goes
 * through the registry (`beginRelease` -> delete -> `completeRelease`), so a
 * crash in the middle is repaired by `reconcile`, and a failed delete keeps the
 * record as `retained` with the reason instead of dropping it.
 *
 * Every delete is checked by {@link safeRemove} against the registered root
 * after `realpath`, so a path-traversal locator or a symlink pointing out of the
 * root is refused and nothing outside the root is ever touched. The shared
 * sccache evicts by its own LRU and is not handled here.
 */

const GC_KINDS: ReadonlySet<string> = new Set(["build_dir", "cache"]);

/** A cache used more recently than this is left alone: a live build may be about to write to it. */
export const DEFAULT_MIN_IDLE_MS = 15 * 60_000;

export interface BuildGcConfig {
  /** The owned directory every locator must stay inside, e.g. `<stateDir>/build`. */
  root: string;
  budget?: BuildBudgetConfig;
  /** Idle time below which a cache is never removed. */
  minIdleMs?: number;
  /** Test seam for the filesystem reader. */
  statfs?: StatfsReader;
}

export interface GcSkip {
  id: string;
  reason: string;
}

export interface GcResult {
  /** Pressure before anything was removed. */
  before: DiskPressure;
  /** Pressure after the last removal (equals `before` when nothing was removed). */
  after: DiskPressure;
  removed: string[];
  skipped: GcSkip[];
  bytesFreed: number;
}

/**
 * Removes `locator`, which must lie strictly inside `root` once symlinks in its
 * parent chain are resolved. A symlink locator is refused when it resolves
 * outside the root and otherwise only the link is removed (never followed).
 * An already missing path counts as removed. Throws on any escape.
 */
export async function safeRemove(locator: string, root: string): Promise<void> {
  if (!isAbsolute(locator)) throw new Error(`locator ${locator} is not an absolute path`);
  const rootReal = await realpath(root);
  const abs = resolve(locator);
  const parentReal = await realpath(dirname(abs)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (parentReal === undefined) return;
  const target = join(parentReal, basename(abs));
  const inside = (path: string): boolean => {
    const rel = relative(rootReal, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel);
  };
  if (relative(rootReal, target) === "") throw new Error(`refusing to remove the registered root ${rootReal} itself`);
  if (!inside(target)) throw new Error(`locator ${locator} resolves outside the registered root ${rootReal}`);
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return;
  if (entry.isSymbolicLink()) {
    const resolved = await realpath(target).catch(() => undefined);
    if (resolved !== undefined && !inside(resolved)) {
      throw new Error(`symlink ${locator} resolves outside the registered root ${rootReal}`);
    }
    await unlink(target);
    return;
  }
  await rm(target, { recursive: true, force: true });
}

/** Bytes under `path`, counting symlinks as links (never followed). */
async function treeBytes(path: string): Promise<number> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry) return 0;
  if (!entry.isDirectory()) return entry.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await treeBytes(join(path, name));
  return total;
}

async function lastUsedMs(record: ResourceRecord): Promise<number> {
  const entry = await lstat(record.locator).catch(() => undefined);
  return entry ? entry.mtimeMs : Date.parse(record.createdAt) || 0;
}

/**
 * Frees owned, unreferenced build caches until pressure on `cfg.root` is below
 * the warn level. `isMissionActive` is the real activity predicate (a cache of
 * an active mission is always skipped); `now` is the clock for the idle check.
 */
export async function pressureGc(
  registry: ResourceRegistry,
  cfg: BuildGcConfig,
  isMissionActive: MissionActivity,
  now: number,
): Promise<GcResult> {
  const budget = cfg.budget ?? DEFAULT_BUILD_BUDGET;
  const minIdleMs = cfg.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
  const measure = () => diskPressure(cfg.root, budget, cfg.statfs);
  const before = await measure();
  const result: GcResult = { before, after: before, removed: [], skipped: [], bytesFreed: 0 };
  if (before.level === "ok") return result;

  const candidates: Array<{ record: ResourceRecord; lastUsed: number }> = [];
  for (const record of await registry.listAll()) {
    if (!GC_KINDS.has(record.kind)) continue;
    if (record.state !== "active" && record.state !== "retained") continue;
    candidates.push({ record, lastUsed: await lastUsedMs(record) });
  }
  candidates.sort((a, b) => a.lastUsed - b.lastUsed || a.record.id.localeCompare(b.record.id));

  for (const { record, lastUsed } of candidates) {
    const skip = (reason: string) => result.skipped.push({ id: record.id, reason });
    if (await isMissionActive(record.ownerMissionId)) {
      skip("mission_active");
      continue;
    }
    if (now - lastUsed < minIdleMs) {
      skip("recently_used");
      continue;
    }
    const begun = await registry.beginRelease(
      record.id,
      { missionId: record.ownerMissionId, executionId: record.ownerExecutionId },
      isMissionActive,
    );
    if (begun.status !== "ok") {
      skip(
        begun.status === "foreign" ? "foreign_owner_or_host" : begun.status === "active" ? "mission_active" : "missing",
      );
      continue;
    }
    try {
      const bytes = await treeBytes(record.locator);
      await safeRemove(record.locator, cfg.root);
      await registry.completeRelease(record.id);
      result.removed.push(record.id);
      result.bytesFreed += bytes;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await registry.markRetained(record.id, reason);
      skip(reason);
      continue;
    }
    result.after = await measure();
    if (result.after.level === "ok") break;
  }
  return result;
}
