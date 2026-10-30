/**
 * Runtime housekeeping: reclaim what autonomous runs leave behind.
 *
 * Binds the worktree janitor (src/git/worktreeJanitor.ts) to the mission store
 * so live missions keep their worktrees, and runs the shared Rust cache sweep
 * (src/git/rustBuildCache.ts). Invoked at session start, on a timer while a
 * session stays open, and on demand through `/gc`.
 */

import { join } from "node:path";
import { GitRepo } from "../git/GitRepo.ts";
import {
  type RustCacheSweepReport,
  hasRootMarker,
  rustCacheEnabled,
  rustCacheRoot,
  rustTargetDir,
  sweepRustCache,
} from "../git/rustBuildCache.ts";
import {
  DEFAULT_PURGE_OLDER_THAN_DAYS,
  MIN_PURGE_OLDER_THAN_DAYS,
  type TrashPurgeReport,
  defaultTrashRoot,
  purgeTrash,
} from "../git/trashStore.ts";
import {
  type JanitorReport,
  type OwnerLiveness,
  type WorktreeOwner,
  describeJanitorReport,
  sweepWorktrees,
} from "../git/worktreeJanitor.ts";
import type { MissionStatus } from "../orchestration/types.ts";
import { discoverMissionHandover } from "./host/missionHandover.ts";

/**
 * Mission statuses after which a mission never touches its worktrees again.
 * FAILED is deliberately absent: a failed mission can be reopened and resumed
 * in the same worktree, so its checkout is never reclaimed.
 */
const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set<MissionStatus>(["COMPLETE", "CANCELED"]);

/** The slice of MissionStore the janitor needs; keeps the binding testable. */
export interface MissionLookup {
  getMission(
    missionId: string,
  ): { status: MissionStatus; completed_at?: string | null; updated_at?: string } | undefined;
  getTask(taskId: string): { mission_id: string } | undefined;
}

/**
 * Liveness of a worktree's owning mission. `terminal` only when a source
 * proves it (this process's store, or the durable event log which also holds
 * missions run by OTHER pi processes); a mission nobody here knows is
 * `unknown`, which the janitor treats as keep.
 */
export function missionOwnerLiveness(
  store: MissionLookup | null | undefined,
  durableStatuses: Readonly<Record<string, string>> = {},
): (owner: WorktreeOwner) => OwnerLiveness {
  return (owner) => {
    const missionId = owner.missionId ?? (owner.taskId ? store?.getTask(owner.taskId)?.mission_id : undefined);
    if (!missionId) return "unknown";
    const statuses = [store?.getMission(missionId)?.status, durableStatuses[missionId]].filter(
      (s): s is string => typeof s === "string",
    );
    if (statuses.length === 0) return "unknown";
    return statuses.every((s) => TERMINAL_MISSION_STATUSES.has(s as MissionStatus)) ? "terminal" : "live";
  };
}

/**
 * `PI_HOUSEKEEPING`: acts only for an explicit `1|true|on|yes`; `0|false|off|no`
 * disables; unset, empty, `dry-run` or anything unknown only reports.
 * Owner rule 2026-10-30: "we can't lose data due to sweeps".
 */
export function housekeepingMode(env: Record<string, string | undefined> = process.env): "on" | "off" | "dry-run" {
  const raw = env.PI_HOUSEKEEPING?.trim().toLowerCase();
  if (raw === undefined) return "dry-run";
  if (/^(1|true|on|yes)$/.test(raw)) return "on";
  if (/^(0|false|off|no)$/.test(raw)) return "off";
  return "dry-run";
}

/**
 * When the owning mission durably ended (epoch ms): the EARLIEST of the sources that know it, so a
 * disagreement keeps more worktrees, never fewer. null when no source has a timestamp.
 */
export function missionTerminalAt(
  store: MissionLookup | null | undefined,
  durableEndedAt: Readonly<Record<string, string>> = {},
): (owner: WorktreeOwner) => number | null {
  return (owner) => {
    const missionId = owner.missionId ?? (owner.taskId ? store?.getTask(owner.taskId)?.mission_id : undefined);
    if (!missionId) return null;
    const mission = store?.getMission(missionId);
    const times = [mission?.completed_at ?? mission?.updated_at, durableEndedAt[missionId]]
      .filter((t): t is string => typeof t === "string")
      .map((t) => Date.parse(t))
      .filter(Number.isFinite);
    return times.length > 0 ? Math.min(...times) : null;
  };
}

export interface GcPlan {
  dryRun: boolean;
  /** Present for `--purge-trash`: purge trash instead of sweeping. */
  purge?: { olderThanDays: number };
  note?: string;
}

/**
 * `/gc` arguments. It previews by default; only an explicit `--apply` acts.
 * `--dry-run` is accepted as a no-op alias and wins over `--apply`.
 * `--purge-trash [--older-than <days>]` lists (or, with `--apply`, permanently deletes) trashed
 * worktrees and Rust caches older than <days> (default 14, minimum 7); it never sweeps. Any other
 * token is unknown and makes the command fall back to a preview, with a note.
 */
export function gcPlan(args: string): GcPlan {
  const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const unknown: string[] = [];
  let purge = false;
  let days: number = DEFAULT_PURGE_OLDER_THAN_DAYS;
  let daysProblem: string | undefined;
  let sawOlderThan = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--apply" || a === "--dry-run") continue;
    if (a === "--purge-trash") purge = true;
    else if (a === "--older-than" || a.startsWith("--older-than=")) {
      sawOlderThan = true;
      const raw = a === "--older-than" ? argv[++i] : a.slice("--older-than=".length);
      const n = Number(raw);
      if (raw === undefined || raw === "" || !Number.isFinite(n) || n < MIN_PURGE_OLDER_THAN_DAYS) {
        daysProblem = `--older-than needs at least ${MIN_PURGE_OLDER_THAN_DAYS} days (got ${raw ?? "nothing"}): nothing will be purged`;
      } else days = n;
    } else unknown.push(a);
  }
  const apply = argv.includes("--apply") && !argv.includes("--dry-run");
  if (unknown.length > 0) {
    return {
      dryRun: true,
      note: `unknown argument(s) ${unknown.join(", ")}: showing a preview instead; use \`/gc --apply\` alone to act`,
    };
  }
  if (daysProblem) return { dryRun: true, note: daysProblem };
  if (!purge && sawOlderThan) {
    return { dryRun: true, note: "--older-than only applies to --purge-trash: showing a preview instead" };
  }
  if (purge && !apply) {
    return {
      dryRun: true,
      purge: { olderThanDays: days },
      note: "purging trash needs --apply; listing what it would purge",
    };
  }
  return purge ? { dryRun: false, purge: { olderThanDays: days } } : { dryRun: !apply };
}

export interface HousekeepingResult {
  worktrees: JanitorReport | null;
  rustCache: RustCacheSweepReport;
}

export async function runHousekeeping(opts: {
  cwd: string;
  missions?: MissionLookup | null;
  dryRun?: boolean;
  /** Aborting kills in-flight git children and rejects with the abort reason. */
  signal?: AbortSignal;
}): Promise<HousekeepingResult> {
  const { signal } = opts;
  const repo = await GitRepo.open(opts.cwd, signal);
  signal?.throwIfAborted();
  // Durable facts include missions run by other pi processes on this worktree.
  const durable = await discoverMissionHandover(opts.cwd).catch(() => null);
  signal?.throwIfAborted();
  const worktrees = repo
    ? await sweepWorktrees({
        repo,
        ownerLiveness: missionOwnerLiveness(opts.missions, durable?.statuses),
        ownerTerminalAt: missionTerminalAt(opts.missions, durable?.endedAt),
        dryRun: opts.dryRun,
      })
    : null;
  signal?.throwIfAborted();
  // Target dirs of every worktree still registered (and the primary checkout) are never swept.
  const liveTargetDirs = new Set<string>();
  if (repo) {
    for (const path of [repo.root, ...(await repo.listLinkedWorktrees()).map((w) => w.path)]) {
      const dir = await rustTargetDir(path).catch(() => null);
      if (dir) liveTargetDirs.add(dir);
    }
  }
  const rustCache = await sweepRustCache({ dryRun: opts.dryRun, liveTargetDirs });
  return { worktrees, rustCache };
}

export interface TrashPurgeResult {
  worktreeTrash: TrashPurgeReport;
  rustCacheTrash: TrashPurgeReport | null;
  rustCacheRefused?: string;
}

/** `/gc --purge-trash`: the only code path that deletes anything a sweep moved to the trash. */
export async function runTrashPurge(opts: {
  olderThanDays: number;
  apply: boolean;
  env?: Record<string, string | undefined>;
}): Promise<TrashPurgeResult> {
  const env = opts.env ?? process.env;
  const worktreeTrash = await purgeTrash(defaultTrashRoot(env), opts);
  if (!rustCacheEnabled(env)) return { worktreeTrash, rustCacheTrash: null };
  const root = rustCacheRoot(env);
  // Read-only: a purge or its preview never marks, adopts or chmods a cache root.
  if (!(await hasRootMarker(root))) {
    return {
      worktreeTrash,
      rustCacheTrash: null,
      rustCacheRefused: `${root} is not a marked pi-engineering Rust cache (no .pi-eng-rust-cache-root); its .trash is not purged`,
    };
  }
  return { worktreeTrash, rustCacheTrash: await purgeTrash(join(root, ".trash"), opts) };
}

export function describeTrashPurge(result: TrashPurgeResult, dryRun: boolean): string[] {
  const verb = dryRun ? "would purge" : "purged";
  const lines: string[] = [];
  for (const [label, r] of [
    ["worktree trash", result.worktreeTrash],
    ["Rust cache trash", result.rustCacheTrash],
  ] as const) {
    if (!r) continue;
    lines.push(`${label}: ${verb} ${r.purged.length}, skipped ${r.skipped.length}`);
    for (const p of r.purged) lines.push(`  ${verb} ${p.path} (trashed ${p.ageDays} d ago)`);
    for (const k of r.skipped) lines.push(`  skipped ${k.path} — ${k.reason}`);
  }
  if (result.rustCacheRefused) lines.push(`Rust cache trash not touched: ${result.rustCacheRefused}`);
  return lines;
}

/** Lines worth telling the operator; empty when nothing happened. */
export function describeHousekeeping(result: HousekeepingResult, opts: { verbose?: boolean } = {}): string[] {
  const lines: string[] = [];
  const wt = result.worktrees;
  if (wt && (wt.reclaimed.length > 0 || wt.failed.length > 0 || opts.verbose)) {
    lines.push(describeJanitorReport(wt));
    if (opts.verbose) {
      for (const r of wt.reclaimed)
        lines.push(`  ${wt.dryRun ? "would move to the trash" : "moved to the trash"} ${r.path} — ${r.reason}`);
      for (const k of wt.kept) lines.push(`  kept ${k.path} — ${k.reason}`);
    }
    for (const f of wt.failed) lines.push(`  failed ${f.path}: ${f.error}`);
  }
  const rc = result.rustCache;
  if (rc.refused) lines.push(`Rust cache sweep refused: ${rc.refused}`);
  if (rc.trashed.length > 0 || (opts.verbose && rc.kept.length > 0)) {
    const verb = rc.dryRun ? "would move to the trash" : "moved to the trash";
    lines.push(
      `${verb} ${rc.trashed.length} unused Rust target cache${rc.trashed.length === 1 ? "" : "s"}, ${rc.kept.length} kept`,
    );
    if (opts.verbose) {
      for (const r of rc.trashed) lines.push(`  ${verb} ${r.path} (idle ${r.idleDays} d)`);
      for (const k of rc.kept) lines.push(`  kept ${k.path} — ${k.reason}`);
    }
  }
  return lines;
}
