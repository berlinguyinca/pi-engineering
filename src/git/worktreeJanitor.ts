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
 *  - Planner-worker worktrees are retained for their executor/recovery owner,
 *    including unregistered directories whose Git metadata was pruned.
 *  - A worktree whose owning mission is still live (any non-terminal status)
 *    is kept untouched.
 *  - Only worktrees on `pi-eng-candidate-*` / `pi-eng-orch-*` branches (or
 *    detached, with such a name) are ever reclaimed. Any other branch belongs
 *    to the user and is kept and reported, however idle.
 *  - A pi-eng-owned worktree whose mission is terminal is reclaimed.
 *  - Reclaiming never loses work (owner rule 2026-10-30: "we can't lose data
 *    due to sweeps"). It fails closed, keeping and reporting the worktree, when
 *    HEAD is detached (a commit made there would become unreachable), when
 *    ignored files other than known derived directories exist, when changes
 *    remain after the preserving commit, or when a plain (never forced)
 *    `git worktree remove` refuses. Otherwise uncommitted changes are committed
 *    onto the worktree's own branch, the branch is kept and only the checkout
 *    goes away.
 *  - Sibling directories inside the namespace that git no longer lists (their
 *    admin metadata was pruned) are re-registered with `git worktree repair`
 *    when possible; otherwise they are reported as strays and never removed.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitRepo } from "./GitRepo.ts";
import { rustTargetDir } from "./rustBuildCache.ts";
import { safeGitOrThrow } from "./safeGit.ts";

const exec = promisify(execFile);

/** Hours a worktree with no known owner may sit idle before it is reclaimed. */
export const WORKTREE_IDLE_HOURS_ENV = "PI_WORKTREE_IDLE_HOURS";
export const DEFAULT_WORKTREE_IDLE_HOURS = 24;

/**
 * Hours before which nothing is reclaimed, whatever its owner's state. Must be
 * at least the longest mission inactivity window (1 h, docs/usage.md).
 */
export const WORKTREE_MIN_AGE_HOURS_ENV = "PI_WORKTREE_MIN_AGE_HOURS";
export const DEFAULT_WORKTREE_MIN_AGE_HOURS = 1;

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
  /** Nothing younger than this is reclaimed. Default 1 h, env-raisable; never lower in production. */
  minAgeMs?: number;
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

export function worktreeMinAgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[WORKTREE_MIN_AGE_HOURS_ENV]);
  const hours = Number.isFinite(raw) && raw >= DEFAULT_WORKTREE_MIN_AGE_HOURS ? raw : DEFAULT_WORKTREE_MIN_AGE_HOURS;
  return hours * 60 * 60 * 1000;
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
  repo.assertSafeWorktreePath(path);
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

/** Rebuildable output directories: never committed, never counted as user data. */
const DERIVED_DIRS = ["node_modules", "target", ".next", "dist", "coverage"] as const;

function isDerivedPath(entry: string): boolean {
  return entry
    .replace(/\/+$/, "")
    .split("/")
    .some((segment) => (DERIVED_DIRS as readonly string[]).includes(segment));
}

/** Status lines (`XY path`) that are not derived-directory noise. */
async function meaningfulStatus(path: string, ignored: boolean): Promise<string[]> {
  const status = await safeGitOrThrow(["status", "--porcelain", ...(ignored ? ["--ignored"] : [])], {
    cwd: path,
    trust: "operator",
    // Read-only: a refreshed index would reset the idle clock the next sweep reads.
    env: { GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return status.stdout.split("\n").filter((line) => line.trim() && !isDerivedPath(line.slice(3).replace(/^"|"$/g, "")));
}

/** Is `commit` reachable from any branch, tag or remote-tracking ref? */
async function isReachableFromRef(repo: GitRepo, commit: string): Promise<boolean> {
  const refs = await safeGitOrThrow(["for-each-ref", "--count=1", "--contains", commit, "refs/"], {
    cwd: repo.root,
    trust: "operator",
    timeoutMs: 60_000,
  });
  return refs.stdout.trim().length > 0;
}

/** Only pi-eng candidate/orchestrator branches (or their detached worktrees, by name) are the runtime's own. */
function isPiEngOwned(repo: GitRepo, wt: { path: string; branch: string | null }): boolean {
  const pattern = /^pi-eng-(candidate|orch)-/;
  if (wt.branch) return pattern.test(wt.branch);
  return pattern.test(basename(wt.path).slice(repo.worktreeNamespacePrefix().length));
}

/**
 * Commit everything in the worktree onto its own branch so removing the
 * checkout loses nothing. Returns the commit sha, or null when clean.
 * Derived directories (node_modules, target, ...) are never committed.
 */
async function preserveUncommittedWork(path: string, branch: string | null): Promise<string | null> {
  if ((await meaningfulStatus(path, false)).length === 0) return null;
  const env = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "pi-engineering janitor",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "pi-engineering@localhost",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "pi-engineering janitor",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "pi-engineering@localhost",
  };
  const base = { cwd: path, trust: "operator", env } as const;
  await safeGitOrThrow(["add", "-A", "--", ".", ...DERIVED_DIRS.map((d) => `:(exclude,glob)**/${d}/**`)], {
    ...base,
    timeoutMs: 120_000,
  });
  await safeGitOrThrow(
    [
      "commit",
      "-q",
      "--no-verify",
      "-m",
      `pi-engineering: preserve uncommitted work from reclaimed worktree${branch ? ` ${branch}` : ""}`,
    ],
    { ...base, timeoutMs: 120_000 },
  );
  const { stdout } = await safeGitOrThrow(["rev-parse", "HEAD"], { ...base, timeoutMs: 30_000 });
  return stdout.trim();
}

/**
 * Reclaim abandoned worktrees in this repository's namespace. Safe to run at
 * any time, including while missions are executing: live owners are kept.
 */
export async function sweepWorktrees(opts: JanitorOptions): Promise<JanitorReport> {
  const { repo } = opts;
  const now = opts.now?.() ?? Date.now();
  const minAge = opts.minAgeMs ?? worktreeMinAgeMs();
  const maxIdle = Math.max(opts.maxIdleMs ?? worktreeIdleMs(), minAge);
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
    if (basename(path).startsWith(`${prefix}pi-eng-pw-`)) {
      // Reported below with the planner-worker recovery reason.
      registered.set(path, { path, branch: null, head: null });
      continue;
    }
    // Re-register when git can (metadata only, no file is touched). Anything
    // else is reported as a stray and never removed.
    const repaired = opts.dryRun
      ? false
      : await safeGitOrThrow(["worktree", "repair", path], {
          cwd: repo.root,
          trust: "operator",
          timeoutMs: 60_000,
        })
          .then(() => true)
          .catch(() => false);
    const after = repaired ? (await repo.listLinkedWorktrees()).find((wt) => wt.path === path) : undefined;
    if (after) {
      registered.set(path, after);
      continue;
    }
    report.kept.push({
      path,
      branch: null,
      reason: "stray, not removed: git no longer lists this directory; inspect it and delete it yourself if unwanted",
    });
  }

  const referenced = await repo.durablyReferencedWorktreePaths([...registered.keys()]);

  for (const wt of registered.values()) {
    // Planner-worker retirement/recovery fences live outside candidate records.
    // Only that executor (on success) or explicit recovery may remove its trees.
    // The path check also protects output after Git admin metadata is pruned.
    if (
      wt.branch?.startsWith("pi-eng-pw-") ||
      basename(wt.path).startsWith(`${repo.worktreeNamespacePrefix()}pi-eng-pw-`)
    ) {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: "planner-worker executor or recovery owns removal",
      });
      continue;
    }
    // A durable candidate/cleanup record still names this checkout: the
    // mission's recovery path owns its removal, never the janitor.
    if (referenced.has(wt.path)) {
      report.kept.push({ path: wt.path, branch: wt.branch, reason: "a durable mission record still references it" });
      continue;
    }
    if (!isPiEngOwned(repo, wt)) {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: wt.branch
          ? `user branch ${wt.branch}: not a pi-eng-candidate/orch branch, never reclaimed`
          : "no pi-eng-candidate/orch branch: not the runtime's own, never reclaimed",
      });
      continue;
    }
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
    // An owner we cannot prove terminal is presumed alive in another process
    // (or parked for days waiting on inference): the idle rule is only for
    // checkouts that name no owner at all.
    if ((owner.missionId || owner.taskId) && liveness !== "terminal") {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: `owner ${owner.missionId ?? owner.taskId} is not durably terminal`,
      });
      continue;
    }
    const ageMs = now - (await worktreeLastActivity(wt.path));
    if (ageMs < minAge) {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: `active ${Math.round(ageMs / 60_000)} min ago (< ${Math.round(minAge / 60_000)} min minimum age)`,
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
      // wt.head === null only for a worktree git could not list; strays never reach here.
      const dirty = await meaningfulStatus(wt.path, false);
      if (!wt.branch) {
        // Detached: a preserving commit would be unreachable once the admin dir goes.
        const reachable = wt.head ? await isReachableFromRef(repo, wt.head) : false;
        if (!reachable || dirty.length > 0) {
          report.kept.push({
            path: wt.path,
            branch: wt.branch,
            reason: !reachable
              ? `detached HEAD ${wt.head?.slice(0, 12) ?? "?"} is not reachable from any ref; removing would lose it`
              : "detached HEAD with uncommitted changes that could not be kept on a branch",
          });
          continue;
        }
      }
      const ignoredFiles = (await meaningfulStatus(wt.path, true)).filter((l) => l.startsWith("!! "));
      if (ignoredFiles.length > 0) {
        const names = ignoredFiles.map((l) => l.slice(3)).slice(0, 5);
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `ignored files present (${names.join(", ")}${ignoredFiles.length > 5 ? ", ..." : ""}); git does not track them`,
        });
        continue;
      }
      if (opts.dryRun) {
        report.reclaimed.push({ path: wt.path, branch: wt.branch, preservedCommit: null, reason, bytes });
        continue;
      }
      // Resolved while the worktree is still registered: it needs git.
      const target = await rustTargetDir(wt.path).catch(() => null);
      const preservedCommit = await preserveUncommittedWork(wt.path, wt.branch);
      const left = await meaningfulStatus(wt.path, false);
      if (left.length > 0) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `changes remain after the preserving commit (${left.slice(0, 3).join("; ")}); kept`,
        });
        continue;
      }
      try {
        // Plain remove, never --force: git refuses on locks and untracked files.
        await safeGitOrThrow(["worktree", "remove", wt.path], {
          cwd: repo.root,
          trust: "operator",
          timeoutMs: 300_000,
        });
      } catch (error) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `git worktree remove refused, kept (not forced): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}${preservedCommit ? `; uncommitted work was preserved as ${preservedCommit}` : ""}`,
        });
        continue;
      }
      // The worktree's own cargo target dir is derived output; it goes with it.
      if (target) await rm(target, { recursive: true, force: true }).catch(() => {});
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
