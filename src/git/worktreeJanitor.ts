/**
 * Worktree janitor: reclaim candidate worktrees the runtime abandoned.
 *
 * The broker removes the worktrees it tracks in memory when a mission reaches
 * cleanup (`ExecutionBroker.cleanupMission`). That bookkeeping dies with the
 * process, so a crashed session, a killed worker or a mission that never
 * reached its terminal state leaves `pi-eng-<hash>-<branch>` checkouts next to
 * the repository forever. Each one carries a full checkout plus whatever the
 * worker built; across a few weeks of autonomous runs that filled a disk.
 *
 * This module sweeps the runtime's own worktree namespace (and nothing else):
 *
 *  - A worktree whose owning mission is still live (any non-terminal status)
 *    is kept untouched.
 *  - A worktree whose mission is terminal, or whose owner cannot be found and
 *    which has been idle longer than `maxIdleMs`, is reclaimed.
 *  - Reclaiming never loses work: uncommitted changes are committed onto the
 *    worktree's own branch first, and the branch is always kept. Only the
 *    checkout on disk goes away. If the preserving commit fails, the worktree
 *    is left alone and reported.
 *  - Sibling directories inside the namespace that git no longer lists (their
 *    admin metadata was pruned) are re-registered with `git worktree repair`
 *    when possible so the same preserve-then-remove path applies; otherwise
 *    they are removed only once idle.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitRepo } from "./GitRepo.ts";

const exec = promisify(execFile);

/** Hours a worktree with no known owner may sit idle before it is reclaimed. */
export const WORKTREE_IDLE_HOURS_ENV = "PI_WORKTREE_IDLE_HOURS";
export const DEFAULT_WORKTREE_IDLE_HOURS = 24;

/** Who a runtime worktree belongs to, parsed from its branch name. */
export interface WorktreeOwner {
  missionId?: string;
  taskId?: string;
}

export type OwnerLiveness = "live" | "terminal" | "unknown";

export interface JanitorOptions {
  repo: GitRepo;
  /**
   * Resolve whether a worktree's owner still needs it. `live` keeps the
   * worktree; `terminal` reclaims it immediately; `unknown` (or no resolver)
   * falls back to the idle timeout.
   */
  ownerLiveness?: (owner: WorktreeOwner) => OwnerLiveness | Promise<OwnerLiveness>;
  maxIdleMs?: number;
  /** Report what would happen without touching anything. */
  dryRun?: boolean;
  now?: () => number;
}

export interface ReclaimedWorktree {
  path: string;
  branch: string | null;
  /** Commit created to preserve uncommitted work, if any. */
  preservedCommit: string | null;
  reason: string;
  /** Bytes the checkout occupied, when it could be measured. */
  bytes: number | null;
}

export interface JanitorReport {
  reclaimed: ReclaimedWorktree[];
  kept: Array<{ path: string; branch: string | null; reason: string }>;
  failed: Array<{ path: string; branch: string | null; error: string }>;
  dryRun: boolean;
}

/** Parse `pi-eng-candidate-<mission>-…` / `pi-eng-orch-<task>` branch names. */
export function parseWorktreeOwner(branch: string | null): WorktreeOwner {
  if (!branch) return {};
  const candidate = /^pi-eng-candidate-([A-Za-z]+-[A-Za-z0-9]+)-/.exec(branch);
  if (candidate?.[1]) return { missionId: candidate[1] };
  const orch = /^pi-eng-orch-([A-Za-z]+-[A-Za-z0-9]+)/.exec(branch);
  if (orch?.[1]) return { taskId: orch[1] };
  return {};
}

export function worktreeIdleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[WORKTREE_IDLE_HOURS_ENV]);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKTREE_IDLE_HOURS;
  return hours * 60 * 60 * 1000;
}

/**
 * Most recent activity inside a worktree: the newest of the checkout dir, its
 * `.git` link, and the admin files git touches on checkout/commit/status.
 */
export async function worktreeLastActivity(path: string): Promise<number> {
  const probes = [path, join(path, ".git")];
  try {
    const link = (await readFile(join(path, ".git"), "utf8")).trim();
    const gitdir = link.startsWith("gitdir:") ? link.slice("gitdir:".length).trim() : null;
    if (gitdir) {
      const abs = isAbsolute(gitdir) ? gitdir : resolve(path, gitdir);
      probes.push(join(abs, "index"), join(abs, "HEAD"), join(abs, "logs", "HEAD"));
    }
  } catch {
    /* no .git link: fall back to the directory itself */
  }
  let newest = 0;
  for (const probe of probes) {
    try {
      const s = await stat(probe);
      newest = Math.max(newest, s.mtimeMs);
    } catch {
      /* missing probe */
    }
  }
  return newest;
}

async function directoryBytes(path: string): Promise<number | null> {
  try {
    const { stdout } = await exec("du", ["-sk", path], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Refuse anything that is not a namespace sibling of the repo root. */
async function assertNamespacePath(repo: GitRepo, path: string): Promise<void> {
  const parent = dirname(repo.root);
  const prefix = repo.worktreeNamespacePrefix();
  if (dirname(path) !== parent || !basename(path).startsWith(prefix) || path === repo.root) {
    throw new Error(`refusing to reclaim ${path}: outside the runtime worktree namespace ${parent}/${prefix}*`);
  }
  const [realPath, realRoot] = await Promise.all([realpath(path).catch(() => path), realpath(repo.root)]);
  if (realPath === realRoot || realRoot.startsWith(`${realPath}/`)) {
    throw new Error(`refusing to reclaim ${path}: it is (or contains) the primary checkout`);
  }
}

/**
 * Commit everything in the worktree onto its own branch so removing the
 * checkout loses nothing. Returns the commit sha, or null when clean.
 */
async function preserveUncommittedWork(path: string, branch: string | null): Promise<string | null> {
  const status = await exec("git", ["-C", path, "status", "--porcelain"], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!status.stdout.trim()) return null;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "pi-engineering janitor",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "pi-engineering@localhost",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "pi-engineering janitor",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "pi-engineering@localhost",
  };
  await exec("git", ["-C", path, "add", "-A"], { timeout: 120_000, env });
  await exec(
    "git",
    [
      "-C",
      path,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      `pi-engineering: preserve uncommitted work from reclaimed worktree${branch ? ` ${branch}` : ""}`,
    ],
    { timeout: 120_000, env },
  );
  const { stdout } = await exec("git", ["-C", path, "rev-parse", "HEAD"], { timeout: 30_000 });
  return stdout.trim();
}

/**
 * Reclaim abandoned worktrees in this repository's namespace. Safe to run at
 * any time, including while missions are executing: live owners are kept.
 */
export async function sweepWorktrees(opts: JanitorOptions): Promise<JanitorReport> {
  const { repo } = opts;
  const now = opts.now?.() ?? Date.now();
  const maxIdle = opts.maxIdleMs ?? worktreeIdleMs();
  const report: JanitorReport = { reclaimed: [], kept: [], failed: [], dryRun: Boolean(opts.dryRun) };
  const prefix = repo.worktreeNamespacePrefix();
  const parent = dirname(repo.root);

  const linked = (await repo.listLinkedWorktrees()).filter(
    (wt) => dirname(wt.path) === parent && basename(wt.path).startsWith(prefix),
  );
  const registered = new Map(linked.map((wt) => [wt.path, wt]));

  // Namespace siblings on disk that git no longer lists: admin metadata lost.
  const strays: string[] = [];
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue;
    const path = join(parent, name);
    if (registered.has(path)) continue;
    const s = await stat(path).catch(() => null);
    if (s?.isDirectory()) strays.push(path);
  }
  for (const path of strays) {
    if (opts.dryRun) {
      registered.set(path, { path, branch: null, head: null });
      continue;
    }
    // Re-register so the preserve-then-remove path applies; failure means the
    // directory is handled as an unrecoverable stray below.
    const repaired = await exec("git", ["-C", repo.root, "worktree", "repair", path], { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    const after = repaired ? (await repo.listLinkedWorktrees()).find((wt) => wt.path === path) : undefined;
    registered.set(path, after ?? { path, branch: null, head: null });
  }

  for (const wt of registered.values()) {
    const owner = parseWorktreeOwner(wt.branch);
    let liveness: OwnerLiveness = "unknown";
    if (opts.ownerLiveness && (owner.missionId || owner.taskId)) {
      try {
        liveness = await opts.ownerLiveness(owner);
      } catch {
        liveness = "unknown";
      }
    }
    if (liveness === "live") {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: `owner ${owner.missionId ?? owner.taskId} is live`,
      });
      continue;
    }
    let reason: string;
    if (liveness === "terminal") {
      reason = `owner ${owner.missionId ?? owner.taskId} finished`;
    } else {
      const idleMs = now - (await worktreeLastActivity(wt.path));
      if (idleMs < maxIdle) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `no known owner; active ${Math.round(idleMs / 60_000)} min ago (< ${Math.round(maxIdle / 3_600_000)} h)`,
        });
        continue;
      }
      reason = `no known owner; idle ${Math.round(idleMs / 3_600_000)} h`;
    }

    try {
      await assertNamespacePath(repo, wt.path);
      const bytes = await directoryBytes(wt.path);
      if (opts.dryRun) {
        report.reclaimed.push({ path: wt.path, branch: wt.branch, preservedCommit: null, reason, bytes });
        continue;
      }
      const isRegistered = wt.head !== null;
      let preservedCommit: string | null = null;
      if (isRegistered) {
        preservedCommit = await preserveUncommittedWork(wt.path, wt.branch);
        await exec("git", ["-C", repo.root, "worktree", "remove", "--force", wt.path], { timeout: 300_000 });
      } else {
        // Unrecoverable stray: no git metadata, so nothing can be preserved.
        // Only reached once the directory has sat idle past the threshold.
        await rm(wt.path, { recursive: true, force: true });
      }
      report.reclaimed.push({ path: wt.path, branch: wt.branch, preservedCommit, reason, bytes });
    } catch (error) {
      report.failed.push({
        path: wt.path,
        branch: wt.branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/** One-line human summary for a notification or log. */
export function describeJanitorReport(report: JanitorReport): string {
  const bytes = report.reclaimed.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  const gb = bytes / 1024 ** 3;
  const size = gb >= 0.1 ? ` (${gb.toFixed(1)} GB)` : "";
  const verb = report.dryRun ? "would reclaim" : "reclaimed";
  const parts = [
    `${verb} ${report.reclaimed.length} abandoned worktree${report.reclaimed.length === 1 ? "" : "s"}${size}`,
  ];
  const preserved = report.reclaimed.filter((r) => r.preservedCommit).length;
  if (preserved > 0) parts.push(`${preserved} with uncommitted work committed to its branch`);
  if (report.kept.length > 0) parts.push(`${report.kept.length} kept`);
  if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
  return parts.join(" · ");
}
