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
 *    detached, with such a folder name) are ever reclaimed. Any other branch
 *    belongs to the user and is kept and reported, however idle.
 *  - Reclaiming needs a provable owner: a parsable mission/task id in the
 *    branch (or folder) name whose mission is durably terminal. A worktree with
 *    no parsable owner is kept; age alone never reclaims anything.
 *  - Reclaiming never loses work (owner rule 2026-10-30: "we can't lose data
 *    due to sweeps"). Before anything is committed or removed, the worktree is
 *    kept and reported when: git has it locked; it holds an initialized
 *    submodule; it holds ignored files other than collapsed derived folders
 *    (node_modules, target, .next, dist, coverage); an untracked derived folder
 *    would block a plain remove; index flags (assume-unchanged, skip-worktree)
 *    could hide edits; HEAD is detached and either unreachable from every
 *    branch/tag/remote ref (stash does not count) or the tree is dirty; or the
 *    shared `_shared` Rust cache key would be the cleanup target. Otherwise
 *    uncommitted changes are committed onto the worktree's own branch and a
 *    plain (never forced) `git worktree remove` runs; if changes remain after
 *    the commit or git refuses, the worktree is kept. The branch always stays.
 *  - Sibling directories inside the namespace that git no longer lists are
 *    reported as strays and never removed. `git worktree repair` may first
 *    re-register one (metadata only; no file is touched), after which it is
 *    treated as an ordinary worktree.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitRepo } from "./GitRepo.ts";
import { UNSCOPED_TARGET_KEY, rustTargetDir } from "./rustBuildCache.ts";
import { safeGitOrThrow } from "./safeGit.ts";

const exec = promisify(execFile);

/** Retained for compatibility only: age alone no longer reclaims any worktree (owner rule 2026-10-30). */
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
   * worktree; `terminal` makes it eligible; `unknown` (or no resolver) keeps it.
   */
  ownerLiveness?: (owner: WorktreeOwner) => OwnerLiveness | Promise<OwnerLiveness>;
  /** Retained for callers; age alone no longer reclaims anything, so this governs nothing. */
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

/** A collapsed folder entry (`path/`) whose own name is a derived name; nothing else is derived. */
function isDerivedDir(entry: string): boolean {
  if (!entry.endsWith("/")) return false;
  const last = entry.replace(/\/+$/, "").split("/").pop() ?? "";
  return (DERIVED_DIRS as readonly string[]).includes(last);
}

const entryPath = (line: string): string => line.slice(3).replace(/^"|"$/g, "");

const READ_ONLY_GIT = { trust: "operator", env: { GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: 60_000 } as const;

/** Raw `git status --porcelain --ignored` lines. Read-only: a refreshed index would reset the idle clock. */
async function statusLines(path: string): Promise<string[]> {
  const status = await safeGitOrThrow(["status", "--porcelain", "--ignored", "--untracked-files=normal"], {
    ...READ_ONLY_GIT,
    cwd: path,
    maxBuffer: 16 * 1024 * 1024,
  });
  return status.stdout.split("\n").filter((line) => line.trim());
}

/** Paths git reports `locked` in `worktree list --porcelain` (GitRepo's listing drops the flag). */
async function lockedWorktreePaths(repo: GitRepo): Promise<Set<string>> {
  const listed = await safeGitOrThrow(["worktree", "list", "--porcelain"], { ...READ_ONLY_GIT, cwd: repo.root });
  const locked = new Set<string>();
  for (const entry of listed.stdout.split(/\n\n+/)) {
    const lines = entry.split("\n");
    const path = lines
      .find((l) => l.startsWith("worktree "))
      ?.slice("worktree ".length)
      .trim();
    if (path && lines.some((l) => l === "locked" || l.startsWith("locked "))) locked.add(path);
  }
  return locked;
}

/** Initialized submodule checkouts: their own work is invisible to a superproject commit. */
async function initializedSubmodules(path: string): Promise<string[]> {
  const files = await safeGitOrThrow(["ls-files", "-s"], { ...READ_ONLY_GIT, cwd: path, maxBuffer: 64 * 1024 * 1024 });
  const found: string[] = [];
  for (const line of files.stdout.split("\n")) {
    if (!line.startsWith("160000 ")) continue;
    const sub = line.slice(line.indexOf("\t") + 1);
    if (await stat(join(path, sub, ".git")).catch(() => null)) found.push(sub);
  }
  return found;
}

/** Index entries flagged assume-unchanged (lowercase tag) or skip-worktree (`S`): edits there are invisible to status. */
async function hiddenIndexEntries(path: string): Promise<string[]> {
  const files = await safeGitOrThrow(["ls-files", "-v"], { ...READ_ONLY_GIT, cwd: path, maxBuffer: 64 * 1024 * 1024 });
  return files.stdout
    .split("\n")
    .filter((line) => /^[a-zS] /.test(line))
    .map((line) => line.slice(2));
}

/** Is `commit` reachable from any branch, tag or remote-tracking ref? (refs/stash does not count.) */
async function isReachableFromRef(repo: GitRepo, commit: string): Promise<boolean> {
  const refs = await safeGitOrThrow(
    ["for-each-ref", "--count=1", "--contains", commit, "refs/heads", "refs/tags", "refs/remotes"],
    { ...READ_ONLY_GIT, cwd: repo.root },
  );
  return refs.stdout.trim().length > 0;
}

/** Branch name, or for a detached worktree the folder-name suffix (`<prefix><branch>`). */
function ownerName(repo: GitRepo, wt: { path: string; branch: string | null }): string {
  return wt.branch ?? basename(wt.path).slice(repo.worktreeNamespacePrefix().length);
}

/** Only pi-eng candidate/orchestrator branches (or their detached worktrees, by name) are the runtime's own. */
function isPiEngOwned(repo: GitRepo, wt: { path: string; branch: string | null }): boolean {
  return /^pi-eng-(candidate|orch)-/.test(ownerName(repo, wt));
}

const preview = (items: string[]) => `${items.slice(0, 5).join(", ")}${items.length > 5 ? ", ..." : ""}`;

/**
 * Decide, without changing anything, whether a registered pi-eng worktree may
 * be reclaimed. Returns the reason to keep it, or null when it is eligible.
 * Shared by dry-run and real runs so a preview never over-reports.
 */
async function reasonToKeep(
  repo: GitRepo,
  wt: { path: string; branch: string | null; head: string | null },
  locked: Set<string>,
): Promise<string | null> {
  if (locked.has(wt.path)) return "locked by git (`git worktree lock`); left untouched";
  const subs = await initializedSubmodules(wt.path);
  if (subs.length > 0)
    return `initialized submodule(s) ${preview(subs)}: their work is not part of this repository's commit`;
  const lines = await statusLines(wt.path);
  const ignored = lines.filter((l) => l.startsWith("!! ") && !isDerivedDir(entryPath(l)));
  if (ignored.length > 0) return `ignored files present (${preview(ignored.map(entryPath))}); git does not track them`;
  const untrackedDerived = lines.filter((l) => l.startsWith("?? ") && isDerivedDir(entryPath(l)));
  if (untrackedDerived.length > 0) {
    return `untracked derived folder(s) ${preview(untrackedDerived.map(entryPath))} would block a plain git worktree remove`;
  }
  const hidden = await hiddenIndexEntries(wt.path);
  if (hidden.length > 0) return `assume-unchanged/skip-worktree index entries hide edits from git: ${preview(hidden)}`;
  if (!wt.branch) {
    const dirty = lines.some((l) => !l.startsWith("!! "));
    if (!wt.head || !(await isReachableFromRef(repo, wt.head))) {
      return `detached HEAD ${wt.head?.slice(0, 12) ?? "?"} is not reachable from any branch, tag or remote ref; removing would lose it`;
    }
    if (dirty) return "detached HEAD with uncommitted changes that could not be kept on a branch";
  }
  const target = await rustTargetDir(wt.path).catch(() => null);
  if (target && basename(target) === UNSCOPED_TARGET_KEY) {
    return "its Rust cache key is the shared `_shared` fallback; not deleting a directory other checkouts use";
  }
  return null;
}

/**
 * Commit everything in the worktree onto its own branch so removing the
 * checkout loses nothing. Returns the commit sha, or null when clean.
 * Derived directories (node_modules, target, ...) are never committed.
 */
async function preserveUncommittedWork(path: string, branch: string | null): Promise<string | null> {
  if ((await statusLines(path)).every((l) => l.startsWith("!! "))) return null;
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
  // Nothing staged (e.g. only tracked edits inside a derived dir): no commit; the caller keeps the worktree.
  const staged = await safeGitOrThrow(["diff", "--cached", "--name-only"], { ...base, timeoutMs: 60_000 });
  if (!staged.stdout.trim()) return null;
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
  const locked = await lockedWorktreePaths(repo);

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
    const owner = parseWorktreeOwner(ownerName(repo, wt));
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
    // No parsable owner: nothing proves the runtime may reclaim it, and age alone never does.
    if (!owner.missionId && !owner.taskId) {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: "no parsable mission/task owner in its name; never reclaimed by age",
      });
      continue;
    }
    // An owner we cannot prove durably terminal is presumed alive in another
    // process (or parked for days waiting on inference).
    if (liveness !== "terminal") {
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
    const reason = `owner ${owner.missionId ?? owner.taskId} finished`;

    try {
      await assertNamespacePath(repo, wt.path);
      const bytes = await directoryBytes(wt.path);
      const keep = await reasonToKeep(repo, wt, locked);
      if (keep) {
        report.kept.push({ path: wt.path, branch: wt.branch, reason: keep });
        continue;
      }
      if (opts.dryRun) {
        report.reclaimed.push({ path: wt.path, branch: wt.branch, preservedCommit: null, reason, bytes });
        continue;
      }
      // Resolved while the worktree is still registered: it needs git.
      const target = await rustTargetDir(wt.path).catch(() => null);
      const preservedCommit = await preserveUncommittedWork(wt.path, wt.branch);
      const left = (await statusLines(wt.path)).filter((l) => !l.startsWith("!! "));
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
