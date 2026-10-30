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
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
  /** Report what would happen without modifying the repository or any worktree (temporary files live in the OS temp dir). */
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
  let newest = await newestTreeMtime(path);
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

/** Rebuildable output directory names. Only a ROOT-level, ignored, repo-free folder with one of these names is derived. */
const DERIVED_DIRS = ["node_modules", "target", ".next", "dist", "coverage"] as const;

/** Upper bound on directory entries any single janitor walk visits; beyond it the answer fails closed. */
const MAX_WALK_ENTRIES = 200_000;

/** Name-only test (any depth): used to refuse, never to permit. */
function isDerivedName(entry: string): boolean {
  if (!entry.endsWith("/")) return false;
  const last = entry.replace(/\/+$/, "").split("/").pop() ?? "";
  return (DERIVED_DIRS as readonly string[]).includes(last);
}

const entryPath = (line: string): string => line.slice(3);

const READ_ONLY_GIT = { trust: "operator", env: { GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: 60_000 } as const;

/** Newest mtime of any file or directory under `dir`, skipping `.git`, node_modules and target. Fails closed to "now". */
async function newestTreeMtime(dir: string): Promise<number> {
  let newest = 0;
  let seen = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") continue;
      if (++seen > MAX_WALK_ENTRIES) return Date.now();
      const full = join(current, entry.name);
      const s = await stat(full).catch(() => null);
      if (s) newest = Math.max(newest, s.mtimeMs);
      if (entry.isDirectory()) queue.push(full);
    }
  }
  const self = await stat(dir).catch(() => null);
  return Math.max(newest, self?.mtimeMs ?? 0);
}

/** Does anything named `.git` (file or directory) exist beneath `dir`? Too large to scan counts as yes. */
async function containsGitEntry(dir: string): Promise<boolean> {
  let seen = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (++seen > MAX_WALK_ENTRIES) return true;
      if (entry.isDirectory()) queue.push(join(current, entry.name));
    }
  }
  return false;
}

/**
 * An ignored entry is disposable derived output only when it is a collapsed
 * folder directly at the worktree root named node_modules/target/.next/dist/
 * coverage, the folder itself is ignored (not merely some files inside it),
 * and no git repository (`.git` file or dir) lives beneath it.
 */
async function isDisposableDerived(path: string, entry: string): Promise<boolean> {
  const name = entry.replace(/\/+$/, "");
  if (!entry.endsWith("/") || name.includes("/") || !(DERIVED_DIRS as readonly string[]).includes(name)) return false;
  const ignored = await safeGitOrThrow(["check-ignore", "-q", "--no-index", entry], { ...READ_ONLY_GIT, cwd: path })
    .then(() => true)
    .catch(() => false);
  return ignored && !(await containsGitEntry(join(path, name)));
}

/**
 * `GitRepo.createWorktree` symlinks the repo root's `node_modules` into every
 * worktree. That symlink is provisioning, not user data: it is never staged,
 * never counted as ignored/untracked content, and on reclaim only the link is
 * unlinked (never followed). Returns the link's target when `path/node_modules`
 * is exactly such a link.
 */
async function provisionedNodeModules(path: string, repoRoot: string): Promise<string | null> {
  const link = join(path, "node_modules");
  const l = await lstat(link).catch(() => null);
  if (!l?.isSymbolicLink()) return null;
  const [there, here] = await Promise.all([
    realpath(link).catch(() => null),
    realpath(join(repoRoot, "node_modules")).catch(() => null),
  ]);
  return there && here && there === here ? there : null;
}

/** Raw `git status --porcelain --ignored` lines, minus the provisioned node_modules link. Read-only: a refreshed index would reset the idle clock. */
async function statusLines(path: string, repoRoot: string, indexFile?: string): Promise<string[]> {
  const status = await safeGitOrThrow(["status", "--porcelain", "-z", "--ignored", "--untracked-files=normal"], {
    ...READ_ONLY_GIT,
    env: { ...READ_ONLY_GIT.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
    cwd: path,
    maxBuffer: 16 * 1024 * 1024,
  });
  const provisioned = (await provisionedNodeModules(path, repoRoot)) !== null;
  // -z: NUL-separated, paths unquoted. A rename/copy record is followed by its origin path: skip that.
  const lines: string[] = [];
  const tokens = status.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (!t.trim()) continue;
    if (/^[RC]|^.[RC]/.test(t)) i++;
    lines.push(t);
  }
  return lines.filter((line) => !(provisioned && /^(\?\?|!!) node_modules\/?$/.test(line)));
}

/** Staged AND further modified entries (MM, AM, RM, AD, UU...): `add -A` would overwrite the staged-only version. */
function partiallyStaged(lines: string[]): string[] {
  return lines.filter((l) => !/^[ ?!]/.test(l) && l[1] !== " ").map(entryPath);
}

/**
 * Stage the worktree's changes into a COPY of its index, so the user's real
 * index is never touched unless the preserving commit is completed. With
 * `simulate`, new objects go to a throw-away object directory (the real one is
 * only an alternate), so a preview writes nothing into the repository. Returns
 * the lines `git add` would leave behind (changes it cannot or will not stage).
 */
async function stageInTempIndex(
  path: string,
  repoRoot: string,
  simulate: boolean,
): Promise<{ indexFile: string; remaining: string[]; dispose: () => Promise<void> }> {
  const gitDir = (
    await safeGitOrThrow(["rev-parse", "--absolute-git-dir"], { ...READ_ONLY_GIT, cwd: path })
  ).stdout.trim();
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-janitor-index-"));
  const indexFile = join(dir, "index");
  await copyFileIfPresent(join(gitDir, "index"), indexFile);
  const dispose = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const env: Record<string, string> = { GIT_INDEX_FILE: indexFile };
    if (simulate) {
      const objects = (
        await safeGitOrThrow(["rev-parse", "--path-format=absolute", "--git-path", "objects"], {
          ...READ_ONLY_GIT,
          cwd: path,
        })
      ).stdout.trim();
      env.GIT_OBJECT_DIRECTORY = join(dir, "objects");
      await mkdir(env.GIT_OBJECT_DIRECTORY);
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objects;
    }
    // An already-ignored link needs no exclude (and git add complains about excluding ignored paths).
    const provisioned =
      (await provisionedNodeModules(path, repoRoot)) !== null &&
      !(await safeGitOrThrow(["check-ignore", "-q", "--no-index", "node_modules"], { ...READ_ONLY_GIT, cwd: path })
        .then(() => true)
        .catch(() => false));
    await safeGitOrThrow(
      [
        "add",
        "-A",
        "--",
        ".",
        ...DERIVED_DIRS.map((d) => `:(exclude,glob)**/${d}/**`),
        ...(provisioned ? [":(exclude)node_modules"] : []),
      ],
      { cwd: path, trust: "operator", env, timeoutMs: 120_000 },
    );
    // Anything whose worktree column (Y) is not clean, or untracked, was left behind.
    const remaining = (await statusLines(path, repoRoot, indexFile)).filter(
      (l) => !l.startsWith("!! ") && l[1] !== " ",
    );
    return { indexFile, remaining, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function copyFileIfPresent(from: string, to: string): Promise<void> {
  const data = await readFile(from).catch(() => null);
  if (data) await writeFile(to, data);
}

/** Replace `gitDir/index` atomically the way git does: take index.lock (fails if held), write, rename over. */
async function installIndex(gitDir: string, indexFile: string): Promise<void> {
  const lock = join(gitDir, "index.lock");
  const handle = await open(lock, "wx");
  try {
    await handle.writeFile(await readFile(indexFile));
    await handle.close();
    await rename(lock, join(gitDir, "index"));
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lock).catch(() => {});
    throw error;
  }
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

/** Is `commit` reachable from a local branch or tag? (Remote-tracking refs can be pruned; refs/stash does not count.) */
async function isReachableFromRef(repo: GitRepo, commit: string): Promise<boolean> {
  const refs = await safeGitOrThrow(["for-each-ref", "--count=1", "--contains", commit, "refs/heads", "refs/tags"], {
    ...READ_ONLY_GIT,
    cwd: repo.root,
  });
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
  const lines = await statusLines(wt.path, repo.root);
  const ignored: string[] = [];
  for (const line of lines.filter((l) => l.startsWith("!! "))) {
    if (!(await isDisposableDerived(wt.path, entryPath(line)))) ignored.push(entryPath(line));
  }
  if (ignored.length > 0) return `ignored files present (${preview(ignored)}); git does not track them`;
  const untrackedDirs = lines.filter((l) => l.startsWith("?? ") && l.endsWith("/")).map(entryPath);
  const untrackedDerived = untrackedDirs.filter(isDerivedName);
  if (untrackedDerived.length > 0) {
    return `untracked derived folder(s) ${preview(untrackedDerived)} would block a plain git worktree remove`;
  }
  const embedded: string[] = [];
  for (const dir of untrackedDirs) if (await containsGitEntry(join(wt.path, dir))) embedded.push(dir);
  if (embedded.length > 0)
    return `embedded git repository under ${preview(embedded)}: its commits are not part of this repository`;
  const partial = partiallyStaged(lines);
  if (partial.length > 0) {
    return `partially staged (index differs from both HEAD and the worktree): ${preview(partial)}; restaging would lose the staged version`;
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
  // Simulate the preserving commit's staging (same pathspec) so a preview never over-reports.
  try {
    const staged = await stageInTempIndex(wt.path, repo.root, true);
    await staged.dispose();
    if (staged.remaining.length > 0) {
      return `changes would remain after the preserving commit (${staged.remaining.slice(0, 3).join("; ")})`;
    }
  } catch (error) {
    return `could not simulate the preserving commit, kept untouched: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  return null;
}

/**
 * Commit everything in the worktree onto its own branch so removing the
 * checkout loses nothing. Staging happens in a temporary copy of the index; the
 * real index is replaced only once the commit succeeded. Returns the commit
 * sha, or null when there was nothing to commit.
 */
async function preserveUncommittedWork(path: string, branch: string | null, repoRoot: string): Promise<string | null> {
  if ((await statusLines(path, repoRoot)).every((l) => l.startsWith("!! "))) return null;
  const env = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "pi-engineering janitor",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "pi-engineering@localhost",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "pi-engineering janitor",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "pi-engineering@localhost",
  };
  const staged = await stageInTempIndex(path, repoRoot, false);
  try {
    if (staged.remaining.length > 0) {
      throw new Error(`changes would remain after the preserving commit: ${staged.remaining.slice(0, 3).join("; ")}`);
    }
    const base = { cwd: path, trust: "operator", env: { ...env, GIT_INDEX_FILE: staged.indexFile } } as const;
    const names = await safeGitOrThrow(["diff", "--cached", "--name-only"], { ...base, timeoutMs: 60_000 });
    if (!names.stdout.trim()) return null;
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
    const gitDir = (
      await safeGitOrThrow(["rev-parse", "--absolute-git-dir"], { ...READ_ONLY_GIT, cwd: path })
    ).stdout.trim();
    await installIndex(gitDir, staged.indexFile);
    const { stdout } = await safeGitOrThrow(["rev-parse", "HEAD"], { cwd: path, trust: "operator", timeoutMs: 30_000 });
    return stdout.trim();
  } finally {
    await staged.dispose();
  }
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
      const planSnapshot = await newestTreeMtime(wt.path);
      let preservedCommit: string | null;
      try {
        preservedCommit = await preserveUncommittedWork(wt.path, wt.branch, repo.root);
      } catch (error) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `could not preserve uncommitted work, kept (a preserving commit may already be on the branch): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        });
        continue;
      }
      // Re-run every keep check right before removal: anything created or changed
      // since the plan (a concurrent writer, a hook) must keep the worktree.
      const late =
        (await reasonToKeep(repo, wt, await lockedWorktreePaths(repo))) ??
        ((await newestTreeMtime(wt.path)) > planSnapshot ? "files changed while it was being reclaimed" : null);
      if (late) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `${late}${preservedCommit ? `; uncommitted work was preserved as ${preservedCommit}` : ""}`,
        });
        continue;
      }
      // Resolved while the worktree is still registered at its original path
      // (the key is derived from it); the shared fallback key is never deleted.
      const target = await rustTargetDir(wt.path).catch(() => null);
      // Quarantine: `git worktree move` (bookkeeping-aware, reversible) takes the checkout out from
      // under any writer that only knows its original path, then everything is re-checked there.
      const quarantined = join(
        parent,
        `${prefix}reclaim-${Date.now().toString(36)}-${basename(wt.path).slice(prefix.length)}`,
      );
      const moveBack = () =>
        safeGitOrThrow(["worktree", "move", quarantined, wt.path], {
          cwd: repo.root,
          trust: "operator",
          timeoutMs: 60_000,
        });
      try {
        await safeGitOrThrow(["worktree", "move", wt.path, quarantined], {
          cwd: repo.root,
          trust: "operator",
          timeoutMs: 60_000,
        });
      } catch (error) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `git worktree move to quarantine refused, kept: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}${preservedCommit ? `; uncommitted work was preserved as ${preservedCommit}` : ""}`,
        });
        continue;
      }
      const moved = { ...wt, path: quarantined };
      const lateQuarantined =
        (await reasonToKeep(repo, moved, await lockedWorktreePaths(repo)).catch(
          (e: unknown) => `re-check failed: ${e instanceof Error ? e.message : String(e)}`,
        )) ??
        ((await newestTreeMtime(quarantined)) > planSnapshot ? "files changed while it was being reclaimed" : null);
      const restore = async (why: string): Promise<void> => {
        const back = await moveBack().then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e)),
        );
        report.kept.push({
          path: back ? quarantined : wt.path,
          branch: wt.branch,
          reason: `${why}${preservedCommit ? `; uncommitted work was preserved as ${preservedCommit}` : ""}${back ? `; could not move it back from quarantine (${back})` : ""}`,
        });
      };
      if (lateQuarantined) {
        await restore(lateQuarantined);
        continue;
      }
      // Provisioned node_modules is a symlink to the repo's own: unlink the link only, never follow it.
      const linkTarget = await provisionedNodeModules(quarantined, repo.root);
      if (linkTarget) await unlink(join(quarantined, "node_modules"));
      try {
        // Plain remove, never --force: git refuses on locks and untracked files.
        await safeGitOrThrow(["worktree", "remove", quarantined], {
          cwd: repo.root,
          trust: "operator",
          timeoutMs: 300_000,
        });
      } catch (error) {
        if (linkTarget) await symlink(linkTarget, join(quarantined, "node_modules")).catch(() => {});
        await restore(
          `git worktree remove refused, kept (not forced): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
        continue;
      }
      // The worktree's own cargo target dir is derived output; it goes with it.
      if (target && basename(target) !== UNSCOPED_TARGET_KEY) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
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
