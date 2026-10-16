import { createHash } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRustProject } from "../git/rustBuildCache.ts";
import type { MissionActivity, ResourceRegistry } from "./ResourceRegistry.ts";
import { type GcResult, pressureGc } from "./buildGc.ts";

/**
 * Build budgets (autospec R-BUILD, issue #144).
 *
 * Each mission builds into its own `CARGO_TARGET_DIR`, and new builds are not
 * admitted when the disk is under pressure. The limits are derived from what
 * they protect: a cache does not bound `target/`, so the target budget is
 * separate from the cache budget, and quotas count bytes AND inodes (a disk can
 * be out of inodes with plenty of free bytes).
 *
 * This module measures and decides. It deletes nothing itself: reclaiming
 * unreferenced owned caches is the pressure GC's job (issue #145), which
 * {@link admitMissionBuild} invokes under disk pressure; the shared sccache
 * evicts by its own LRU.
 */

const GiB = 1024 ** 3;

export interface BuildBudgetConfig {
  /** Shared compile cache (sccache) bound. */
  cacheBytes: number;
  /** Initial per-mission `target/` budget. */
  targetBytes: number;
  /** Percent of bytes or inodes used at which a warning is raised. */
  warnPct: number;
  /** Percent of bytes or inodes used at which new builds are refused. */
  stopPct: number;
  /** Free bytes below which new builds are refused whatever the percentages say. */
  reserveBytes: number;
}

/**
 * Spec defaults: sccache 40 GiB, 100 GiB initial target budget, warn at 80 %,
 * stop at 90 % or below the free-space reserve. The spec leaves the reserve
 * size to the machine; 20 GiB keeps a toolchain-sized build from filling the
 * last of the disk.
 */
export const DEFAULT_BUILD_BUDGET: Readonly<BuildBudgetConfig> = {
  cacheBytes: 40 * GiB,
  targetBytes: 100 * GiB,
  warnPct: 80,
  stopPct: 90,
  reserveBytes: 20 * GiB,
};

/** Retention (spec R-BUILD): failure artifacts 24 h, logs 7 d. */
export const FAILURE_ARTIFACT_RETENTION_MS = 24 * 3600_000;
export const LOG_RETENTION_MS = 7 * 24 * 3600_000;

export type PressureLevel = "ok" | "warn" | "stop";

export interface DiskPressure {
  level: PressureLevel;
  /** Why the level is not ok; absent at ok. */
  reason?: string;
  bytesUsedPct: number;
  inodesUsedPct: number;
  freeBytes: number;
  totalBytes: number;
  freeInodes: number;
  totalInodes: number;
}

/** The fields of `fs.statfs` this module reads (injectable for tests). */
export interface StatfsResult {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
}
export type StatfsReader = (path: string) => Promise<StatfsResult>;

const realStatfs: StatfsReader = async (path) => {
  const s = await statfs(path);
  return {
    bsize: Number(s.bsize),
    blocks: Number(s.blocks),
    bfree: Number(s.bfree),
    bavail: Number(s.bavail),
    files: Number(s.files),
    ffree: Number(s.ffree),
  };
};

/** statfs the path, or its nearest existing ancestor when it is not created yet. */
async function readNearest(path: string, reader: StatfsReader): Promise<StatfsResult> {
  let current = path;
  for (;;) {
    try {
      return await reader(current);
    } catch (error) {
      const parent = dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
      current = parent;
    }
  }
}

/** Percent used the way `df` reports it: used / (used + available to unprivileged users). */
function pct(used: number, available: number): number {
  const total = used + available;
  return total > 0 ? (used / total) * 100 : 0;
}

/**
 * Disk and inode pressure for the filesystem holding `path`.
 * `stop` at or above `stopPct` (bytes or inodes) or below the free-space
 * reserve; `warn` at or above `warnPct`; otherwise `ok`. A filesystem that
 * reports no inode count (`files` = 0, e.g. btrfs) is judged on bytes alone.
 */
export async function diskPressure(
  path: string,
  cfg: BuildBudgetConfig = DEFAULT_BUILD_BUDGET,
  reader: StatfsReader = realStatfs,
): Promise<DiskPressure> {
  const s = await readNearest(path, reader);
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  const bytesUsedPct = pct((s.blocks - s.bfree) * s.bsize, freeBytes);
  const inodesUsedPct = s.files > 0 ? pct(s.files - s.ffree, s.ffree) : 0;
  const base = { bytesUsedPct, inodesUsedPct, freeBytes, totalBytes, freeInodes: s.ffree, totalInodes: s.files };
  const hot = Math.max(bytesUsedPct, inodesUsedPct);
  if (bytesUsedPct >= cfg.stopPct || inodesUsedPct >= cfg.stopPct) {
    const what = inodesUsedPct >= cfg.stopPct && inodesUsedPct >= bytesUsedPct ? "inode" : "byte";
    return {
      level: "stop",
      reason: `${what} use ${hot.toFixed(1)}% is at or above the ${cfg.stopPct}% stop level`,
      ...base,
    };
  }
  if (freeBytes < cfg.reserveBytes) {
    return {
      level: "stop",
      reason: `free space ${freeBytes} bytes is below the ${cfg.reserveBytes} byte reserve`,
      ...base,
    };
  }
  if (hot >= cfg.warnPct) {
    return { level: "warn", reason: `use ${hot.toFixed(1)}% is at or above the ${cfg.warnPct}% warn level`, ...base };
  }
  return { level: "ok", ...base };
}

/**
 * The per-mission Cargo target directory under the runtime state dir. The id
 * is hashed into the name, so a hostile or odd mission id can neither escape
 * the state dir nor collide with another mission's directory.
 */
export function missionTargetDir(stateDir: string, missionId: string): string {
  if (missionId.trim().length === 0) throw new Error("mission id must be a non-empty string");
  const slug =
    missionId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 48) || "mission";
  const hash = createHash("sha256").update(missionId).digest("hex").slice(0, 12);
  return join(stateDir, "build", `${slug}-${hash}`, "target");
}

/** How a verification run is told to build for a mission. */
export interface MissionBuildOptions {
  /** Runtime state dir; the mission directory lives under it. */
  stateDir: string;
  /** Records the directory as an owned `build_dir` before it is created. */
  registry?: ResourceRegistry;
  /** Execution that owns the directory; defaults to the mission id. */
  executionId?: string;
  budget?: BuildBudgetConfig;
  /**
   * Whether a mission is still using its build caches. Under disk pressure the
   * admission frees idle caches of finished missions through
   * {@link pressureGc}; that GC runs only when this predicate is supplied (it
   * must never guess which missions are alive) and a `registry` is present.
   */
  isMissionActive?: MissionActivity;
  /** Idle time below which the pressure GC never removes a cache. */
  gcMinIdleMs?: number;
  /** Clock for the pressure GC's idle check. */
  now?: () => number;
  /** Test seam for the filesystem reader. */
  statfs?: StatfsReader;
}

export interface BuildAdmission {
  /** Variables to add to the stage env (empty when the stage is not a mission Rust build). */
  env: Record<string, string>;
  /** Pressure at admission; absent when no check applied. */
  pressure?: DiskPressure;
  /** Set when the stage must not run; the text says why. */
  refused?: string;
  /** What the pressure GC did, when disk pressure made admission run it. */
  gc?: GcResult;
}

/**
 * Admission for one stage of a mission's verification. Only Rust projects get a
 * mission target dir; an operator-set `CARGO_TARGET_DIR` is theirs and is left
 * alone. At the stop level the stage is refused before it runs.
 */
export async function admitMissionBuild(
  cwd: string,
  missionId: string,
  build: MissionBuildOptions,
  operatorEnv: NodeJS.ProcessEnv = process.env,
): Promise<BuildAdmission> {
  if (operatorEnv.CARGO_TARGET_DIR?.trim() || !(await isRustProject(cwd))) return { env: {} };
  const dir = missionTargetDir(build.stateDir, missionId);
  let pressure = await diskPressure(dir, build.budget ?? DEFAULT_BUILD_BUDGET, build.statfs);
  // Production caller of the pressure GC (issue #259): at warn or stop, free
  // idle caches of finished missions before deciding. A failing GC never blocks
  // admission by itself; the pressure measured before it then stands.
  let gc: GcResult | undefined;
  if (pressure.level !== "ok" && build.registry && build.isMissionActive) {
    try {
      gc = await pressureGc(
        build.registry,
        {
          root: join(build.stateDir, "build"),
          ...(build.budget ? { budget: build.budget } : {}),
          ...(build.gcMinIdleMs !== undefined ? { minIdleMs: build.gcMinIdleMs } : {}),
          ...(build.statfs ? { statfs: build.statfs } : {}),
        },
        build.isMissionActive,
        (build.now ?? Date.now)(),
      );
      pressure = gc.after;
    } catch {
      gc = undefined;
    }
  }
  if (pressure.level === "stop") {
    return {
      env: {},
      pressure,
      ...(gc ? { gc } : {}),
      refused: `build refused for mission ${missionId}: ${pressure.reason ?? "disk pressure"}`,
    };
  }
  if (build.registry) {
    await build.registry.register({
      id: `build-dir:${missionId}`,
      kind: "build_dir",
      ownerMissionId: missionId,
      ownerExecutionId: build.executionId ?? missionId,
      locator: dir,
      lease: `verify:${missionId}`,
    });
  }
  await mkdir(dir, { recursive: true });
  return { env: { CARGO_TARGET_DIR: dir }, pressure, ...(gc ? { gc } : {}) };
}
