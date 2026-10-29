/**
 * Runtime housekeeping: reclaim what autonomous runs leave behind.
 *
 * Binds the worktree janitor (src/git/worktreeJanitor.ts) to the mission store
 * so live missions keep their worktrees, and runs the shared Rust cache sweep
 * (src/git/rustBuildCache.ts). Invoked at session start, on a timer while a
 * session stays open, and on demand through `/gc`.
 */

import { GitRepo } from "../git/GitRepo.ts";
import { type RustCacheSweepReport, sweepRustCache } from "../git/rustBuildCache.ts";
import {
  type JanitorReport,
  type OwnerLiveness,
  type WorktreeOwner,
  describeJanitorReport,
  sweepWorktrees,
} from "../git/worktreeJanitor.ts";
import type { MissionStatus } from "../orchestration/types.ts";
import { discoverMissionHandover } from "./host/missionHandover.ts";

/** Mission statuses after which a mission never touches its worktrees again. */
const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set<MissionStatus>([
  "COMPLETE",
  "CANCELED",
  "FAILED",
]);

/** The slice of MissionStore the janitor needs; keeps the binding testable. */
export interface MissionLookup {
  getMission(missionId: string): { status: MissionStatus } | undefined;
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

/** `PI_HOUSEKEEPING`: `0` is off, `dry-run` reports only, anything else (default) acts. */
export function housekeepingMode(env: Record<string, string | undefined> = process.env): "on" | "off" | "dry-run" {
  const raw = env.PI_HOUSEKEEPING?.trim().toLowerCase();
  return raw === "0" ? "off" : raw === "dry-run" ? "dry-run" : "on";
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
        dryRun: opts.dryRun,
      })
    : null;
  signal?.throwIfAborted();
  const rustCache = await sweepRustCache({ dryRun: opts.dryRun });
  return { worktrees, rustCache };
}

/** Lines worth telling the operator; empty when nothing happened. */
export function describeHousekeeping(result: HousekeepingResult, opts: { verbose?: boolean } = {}): string[] {
  const lines: string[] = [];
  const wt = result.worktrees;
  if (wt && (wt.reclaimed.length > 0 || wt.failed.length > 0 || opts.verbose)) {
    lines.push(describeJanitorReport(wt));
    if (opts.verbose) {
      for (const r of wt.reclaimed)
        lines.push(`  ${wt.dryRun ? "would reclaim" : "reclaimed"} ${r.path} — ${r.reason}`);
      for (const k of wt.kept) lines.push(`  kept ${k.path} — ${k.reason}`);
    }
    for (const f of wt.failed) lines.push(`  failed ${f.path}: ${f.error}`);
  }
  const rc = result.rustCache;
  if (rc.removed.length > 0 || (opts.verbose && rc.kept.length > 0)) {
    const verb = rc.dryRun ? "would remove" : "removed";
    lines.push(
      `${verb} ${rc.removed.length} unused Rust target cache${rc.removed.length === 1 ? "" : "s"}, ${rc.kept.length} kept`,
    );
    if (opts.verbose) for (const r of rc.removed) lines.push(`  ${verb} ${r.path} (idle ${r.idleDays} d)`);
  }
  return lines;
}
