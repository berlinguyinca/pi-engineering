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
 *    local branch or tag (remote-tracking refs and stash do not count) or the tree is dirty; or the
 *    shared `_shared` Rust cache key would be the cleanup target; or it lacks
 *    the ownership marker `pi-eng-owner.json` in its git dir (proof the runtime
 *    created it for THIS repository); or a root derived folder holds files newer
 *    than the owning mission's terminal timestamp. Otherwise uncommitted
 *    changes are committed onto the worktree's own branch and the quarantined
 *    checkout is MOVED (never deleted) to `<state-dir>/trash/<ts>/<name>`, after
 *    which its git registration is pruned; if changes remain after the commit,
 *    the move crosses a filesystem or git refuses, the worktree is kept. The
 *    branch always stays. Only `/gc --purge-trash` ever deletes trash.
 *  - Fork worktrees (`pi-fork-<hash>-<id>`) are outside the `pi-eng-<hash>-` namespace and never swept here; their
 *    markers are for a future janitor.
 *  - Sibling directories inside the namespace that git no longer lists are
 *    reported as strays and never removed. `git worktree repair` may first
 *    re-register one (metadata only; no file is touched), after which it is
 *    treated as an ordinary worktree.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitRepo } from "./GitRepo.ts";
import { readOwnerMarker } from "./ownerMarker.ts";
import { UNSCOPED_TARGET_KEY, rustTargetDir } from "./rustBuildCache.ts";
import { safeGitOrThrow } from "./safeGit.ts";
import {
  defaultTrashRoot,
  moveToTrash,
  recordTrashAdmin,
  shellQuote,
  trashRootInsideProblem,
  trashRootProblem,
} from "./trashStore.ts";
import { MAX_WALK_ENTRIES, ROOT_DERIVED_DIRS, containsGitEntry } from "./worktreeSafety.ts";

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
  /**
   * Epoch ms at which the owner's mission durably became terminal. A worktree whose root
   * derived folders (node_modules, target, ...) hold anything newer, or that has such folders
   * while this is unknown (null/absent), is kept: something used the checkout after the mission ended.
   */
  ownerTerminalAt?: (owner: WorktreeOwner) => number | null | Promise<number | null>;
  /** Where reclaimed checkouts are moved. Default `<state-dir>/trash`. */
  trashRoot?: string;
  /** Retained for callers; age alone no longer reclaims anything, so this governs nothing. */
  maxIdleMs?: number;
  /** Nothing younger than this is reclaimed. Default 1 h, env-raisable; never lower in production. */
  minAgeMs?: number;
  /**
   * Report what would happen. No ref, index, worktree file or new object is written to the repository;
   * temporary files live in the OS temp dir. Git itself may re-touch the mtime of an existing identical
   * loose object it would otherwise have written (object "freshening").
   */
  dryRun?: boolean;
  now?: () => number;
}

export interface ReclaimedWorktree {
  path: string;
  branch: string | null;
  /** Commit created to preserve uncommitted work, if any. */
  preservedCommit: string | null;
  reason: string;
  /** Where the checkout was moved (null in a dry run). It is never deleted by a sweep. */
  trashedTo?: string | null;
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
  return (await worktreeActivity(path)).at;
}

/** `worktreeLastActivity` plus the unreadable directory that forced it to "now", if any. */
async function worktreeActivity(path: string): Promise<{ at: number; unreadable: string | null }> {
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
  const scan = await scanTree(path);
  let newest = scan.newest;
  for (const probe of probes) {
    try {
      const s = await stat(probe);
      newest = Math.max(newest, s.mtimeMs);
    } catch {
      /* missing probe */
    }
  }
  return { at: newest, unreadable: scan.unreadable };
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
async function assertNamespacePath(repo: GitRepo, path: string, branch: string | null): Promise<void> {
  repo.assertSafeWorktreePath(path);
  const markerWhy = ownerMarkerProblem(repo, await worktreeGitDir(path), branch);
  if (markerWhy) throw new Error(`refusing to reclaim ${path}: ${markerWhy}`);
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

async function worktreeGitDir(path: string): Promise<string> {
  return (await safeGitOrThrow(["rev-parse", "--absolute-git-dir"], { ...READ_ONLY_GIT, cwd: path })).stdout.trim();
}

/**
 * Why a worktree is not provably ours, or null. The marker is written and validated by `ownerMarker.ts`
 * (repoRootHash + full repoRootSha256 over realpath(repoRoot), exact branch, regular file); a missing, unparseable or
 * mismatching marker all mean "not provably ours": the worktree is kept. A detached worktree matches only a marker
 * that recorded no branch.
 */
function ownerMarkerProblem(repo: GitRepo, gitDir: string, branch: string | null): string | null {
  const read = readOwnerMarker(gitDir, { repoRoot: repo.root, branch });
  if (read.ok) return null;
  return read.reason === "missing"
    ? "no ownership marker (pi-eng-owner.json in its git dir): not provably created by pi-engineering"
    : `ownership marker rejected (${read.reason}): not provably created by pi-engineering for this repository and branch`;
}

/** Rebuildable output directory names. Only a ROOT-level, ignored, repo-free folder with one of these names is derived. */
const DERIVED_DIRS: readonly string[] = [...ROOT_DERIVED_DIRS];

/** Name-only test (any depth): used to refuse, never to permit. */
function isDerivedName(entry: string): boolean {
  if (!entry.endsWith("/")) return false;
  const last = entry.replace(/\/+$/, "").split("/").pop() ?? "";
  return DERIVED_DIRS.includes(last);
}

/** Exists? lstat, so a dangling symlink counts as present. Only "not there" (ENOENT/ENOTDIR) is false; any other error propagates so the caller fails closed. */
async function existsStrict(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

const entryPath = (line: string): string => line.slice(3);

const READ_ONLY_GIT = { trust: "operator", env: { GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: 60_000 } as const;

/**
 * Newest mtime of any file or directory under `dir`, skipping `.git`, node_modules and target.
 * `unreadable` names the first directory that could not be listed (or the walk limit): the tree cannot be proven idle.
 */
async function scanTree(dir: string): Promise<{ newest: number; unreadable: string | null }> {
  let newest = 0;
  let seen = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!entries) return { newest: Date.now(), unreadable: current };
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") continue;
      if (++seen > MAX_WALK_ENTRIES) return { newest: Date.now(), unreadable: current };
      const full = join(current, entry.name);
      const s = await stat(full).catch(() => null);
      if (s) newest = Math.max(newest, s.mtimeMs);
      if (entry.isDirectory()) queue.push(full);
    }
  }
  const self = await stat(dir).catch(() => null);
  return { newest: Math.max(newest, self?.mtimeMs ?? 0), unreadable: null };
}

/** Fails closed to "now" when the tree cannot be read. */
async function newestTreeMtime(dir: string): Promise<number> {
  return (await scanTree(dir)).newest;
}

/**
 * N2 guard: root derived folders (node_modules, target, ...) are only disposable while nothing touched them
 * after the owning mission ended. Returns why the worktree must be kept, or null.
 */
async function derivedActivityProblem(path: string, terminalAt: number | null): Promise<string | null> {
  for (const name of DERIVED_DIRS) {
    const dir = join(path, name);
    const l = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!l) continue;
    if (terminalAt === null) {
      return `${name}/ present but the owning mission has no durable terminal timestamp, so it cannot be shown untouched since the mission ended`;
    }
    const newer = `${name}/ holds files newer than the mission's terminal timestamp (${new Date(terminalAt).toISOString()}): the checkout was used after the mission ended`;
    if (l.mtimeMs > terminalAt) return newer;
    if (!l.isDirectory()) continue; // a symlink (the provisioned node_modules) is judged by its own mtime and never followed
    let seen = 0;
    const queue = [dir];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
      if (!entries)
        return `unreadable directory under ${current}: cannot show ${name}/ untouched since the mission ended`;
      for (const entry of entries) {
        if (++seen > MAX_WALK_ENTRIES) return `${name}/ is too large to verify untouched since the mission ended`;
        const full = join(current, entry.name);
        const s = await lstat(full).catch(() => null);
        if (!s) return `${name}/ changed while it was being checked`;
        if (s.mtimeMs > terminalAt) return newer;
        if (entry.isDirectory()) queue.push(full);
      }
    }
  }
  return null;
}

/**
 * An ignored entry is disposable derived output only when it is a collapsed
 * folder directly at the worktree root named node_modules/target/.next/dist/
 * coverage, the folder itself is ignored (not merely some files inside it),
 * and no git repository (`.git` file or dir) lives beneath it.
 */
async function isDisposableDerived(path: string, entry: string): Promise<boolean> {
  const name = entry.replace(/\/+$/, "");
  if (!entry.endsWith("/") || name.includes("/") || !DERIVED_DIRS.includes(name)) return false;
  const ignored = await safeGitOrThrow(["check-ignore", "-q", "--no-index", entry], { ...READ_ONLY_GIT, cwd: path })
    .then(() => true)
    .catch(() => false);
  return ignored && !(await containsGitEntry(join(path, name), name === "node_modules"));
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
  const dispose = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await copyFileIfPresent(join(gitDir, "index"), indexFile);
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
  // A missing index is fine (nothing staged); an unreadable one must not become an empty index.
  const data = await readFile(from).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (data) await writeFile(to, data);
}

const LOCK_MARKER = /^pi-eng-janitor pid=(\d+) ts=(\d+)/;
const STALE_LOCK_MS = 60 * 60 * 1000;

const sha1 = (data: Buffer): string => createHash("sha1").update(data).digest("hex");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take `index.lock` (fails if anyone holds it). The content marks it as ours so a crash leaves an identifiable lock. */
async function takeIndexLock(gitDir: string): Promise<string> {
  const lock = join(gitDir, "index.lock");
  const handle = await open(lock, "wx");
  try {
    await handle.writeFile(`pi-eng-janitor pid=${process.pid} ts=${Date.now()}\n`);
  } finally {
    await handle.close();
  }
  return lock;
}

/** Install the new index while the lock is held: write beside it, rename over, release the lock. */
async function installIndexUnderLock(gitDir: string, lock: string, indexFile: string): Promise<void> {
  const next = join(gitDir, "index.pi-eng-new");
  await writeFile(next, await readFile(indexFile));
  await rename(next, join(gitDir, "index"));
  await unlink(lock);
}

/**
 * Why an index.lock keeps the worktree. Never deleted: a lock may be a live git
 * command or a killed worker's; only a lock this janitor wrote (pid marker) whose
 * pid is dead and older than an hour is called stale, and is still kept.
 */
async function indexLockReason(gitDir: string): Promise<string | null> {
  const lock = join(gitDir, "index.lock");
  if (!(await existsStrict(lock))) return null;
  const marker = LOCK_MARKER.exec(await readFile(lock, "utf8").catch(() => ""));
  if (marker && !pidAlive(Number(marker[1])) && Date.now() - Number(marker[2]) > STALE_LOCK_MS) {
    return `stale index.lock left by a dead janitor run (pid ${marker[1]}); a preserving commit may exist on the branch; after checking, remove the lock yourself; run \`git reset\` (mixed) only if \`git log -1\` shows the pi-engineering preserve commit (the index is stale then), never otherwise`;
  }
  return "index.lock present (a git command may be running or was killed); never removed by housekeeping";
}

/** In-progress git operations whose state lives only in the git dir (autostash, todo lists, merge parents...). */
const OPERATION_MARKERS = [
  ["rebase-merge", "rebase in progress"],
  ["rebase-apply", "rebase/am in progress"],
  ["sequencer", "cherry-pick/revert sequence in progress"],
  ["MERGE_HEAD", "merge in progress"],
  ["CHERRY_PICK_HEAD", "cherry-pick in progress"],
  ["REVERT_HEAD", "revert in progress"],
  ["BISECT_LOG", "bisect in progress"],
  ["MERGE_AUTOSTASH", "merge with autostash in progress"],
  ["AUTO_MERGE", "merge state present (AUTO_MERGE)"],
  ["NOTES_MERGE_REF", "notes merge in progress"],
  ["NOTES_MERGE_PARTIAL", "notes merge in progress"],
  ["NOTES_MERGE_WORKTREE", "notes merge in progress"],
  ["SQUASH_MSG", "squash merge pending (SQUASH_MSG)"],
] as const;

async function operationInProgress(gitDir: string): Promise<string | null> {
  for (const [marker, why] of OPERATION_MARKERS) {
    if (await existsStrict(join(gitDir, marker))) {
      return `${why} (${marker} in the git dir); its state is not part of any branch, so removing the checkout would lose it`;
    }
  }
  return null;
}

/** Commits only the worktree itself can reach: per-worktree refs, or HEAD-reflog commits no branch/tag contains. */
async function worktreeOnlyHistory(path: string): Promise<string | null> {
  const refs = await safeGitOrThrow(
    ["for-each-ref", "--format=%(refname)", "refs/worktree", "refs/bisect", "refs/rewritten"],
    {
      ...READ_ONLY_GIT,
      cwd: path,
    },
  );
  if (refs.stdout.trim())
    return `per-worktree refs exist (${preview(refs.stdout.trim().split("\n"))}); they vanish with the worktree`;
  let entries: string[];
  try {
    const log = await safeGitOrThrow(["log", "-g", "--format=%H", "-n", "1001", "HEAD"], {
      ...READ_ONLY_GIT,
      cwd: path,
    });
    entries = log.stdout.split("\n").filter(Boolean);
  } catch (error) {
    return `HEAD reflog could not be read, kept: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  // Count raw entries BEFORE deduplicating: many resets at one commit must not hide older commits.
  if (entries.length > 1000) return "HEAD reflog too long to verify (more than 1000 entries); kept";
  const shas = [...new Set(entries)];
  if (shas.length === 0) return null;
  const lost = await safeGitOrThrow(["rev-list", "--max-count=1", ...shas, "--not", "--branches", "--tags"], {
    ...READ_ONLY_GIT,
    cwd: path,
  });
  return lost.stdout.trim()
    ? `commit ${lost.stdout.trim().slice(0, 12)} is only in this worktree's HEAD reflog (no branch or tag contains it); removing would lose it`
    : null;
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
    if (await existsStrict(join(path, sub, ".git"))) found.push(sub);
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
  return wt.branch ?? originalName(repo, wt.path);
}

/** Folder name without the namespace prefix and any `reclaim-<ts>-` quarantine prefixes a crashed run left. */
function originalName(repo: GitRepo, path: string): string {
  return basename(path)
    .slice(repo.worktreeNamespacePrefix().length)
    .replace(/^(reclaim-[a-z0-9]+-)+/, "");
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
  terminalAt: number | null,
  skipMarker = false,
): Promise<string | null> {
  // Any probe that errors (unreadable file, git failure, timeout) must keep the worktree, never pass it.
  try {
    return await reasonToKeepUnchecked(repo, wt, locked, terminalAt, skipMarker);
  } catch (error) {
    return `could not verify it is safe to reclaim, kept: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

async function reasonToKeepUnchecked(
  repo: GitRepo,
  wt: { path: string; branch: string | null; head: string | null },
  locked: Set<string>,
  terminalAt: number | null,
  skipMarker: boolean,
): Promise<string | null> {
  if (locked.has(wt.path)) return "locked by git (`git worktree lock`); left untouched";
  const gitDir = (
    await safeGitOrThrow(["rev-parse", "--absolute-git-dir"], { ...READ_ONLY_GIT, cwd: wt.path })
  ).stdout.trim();
  const markerWhy = skipMarker ? null : ownerMarkerProblem(repo, gitDir, wt.branch);
  if (markerWhy) return markerWhy;
  const lockWhy = await indexLockReason(gitDir);
  if (lockWhy) return lockWhy;
  const opWhy = await operationInProgress(gitDir);
  if (opWhy) return opWhy;
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
      return `detached HEAD ${wt.head?.slice(0, 12) ?? "?"} is not reachable from any local branch or tag; removing would lose it`;
    }
    if (dirty) return "detached HEAD with uncommitted changes that could not be kept on a branch";
  }
  const onlyHere = await worktreeOnlyHistory(wt.path);
  if (onlyHere) return onlyHere;
  const derivedWhy = await derivedActivityProblem(wt.path, terminalAt);
  if (derivedWhy) return derivedWhy;
  let target: string | null;
  try {
    target = await rustTargetDir(wt.path);
  } catch (error) {
    return `its Rust cache key could not be determined, kept: ${error instanceof Error ? error.message : String(error)}`;
  }
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
  const gitDir = (
    await safeGitOrThrow(["rev-parse", "--absolute-git-dir"], { ...READ_ONLY_GIT, cwd: path })
  ).stdout.trim();
  const realIndex = join(gitDir, "index");
  const snapshot = await readFile(realIndex).then(sha1, () => "");
  const staged = await stageInTempIndex(path, repoRoot, false);
  let lock: string | null = null;
  let committed = false;
  try {
    if (staged.remaining.length > 0) {
      throw new Error(`changes would remain after the preserving commit: ${staged.remaining.slice(0, 3).join("; ")}`);
    }
    const base = { cwd: path, trust: "operator", env: { ...env, GIT_INDEX_FILE: staged.indexFile } } as const;
    const names = await safeGitOrThrow(["diff", "--cached", "--name-only"], { ...base, timeoutMs: 60_000 });
    if (!names.stdout.trim()) return null;
    // Hold index.lock from here to the end so no other git command can move the real index under us.
    lock = await takeIndexLock(gitDir);
    if ((await readFile(realIndex).then(sha1, () => "")) !== snapshot) {
      throw new Error("the index changed while the preserving commit was being prepared");
    }
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
    committed = true;
    await installIndexUnderLock(gitDir, lock, staged.indexFile);
    lock = null;
    const { stdout } = await safeGitOrThrow(["rev-parse", "HEAD"], { cwd: path, trust: "operator", timeoutMs: 30_000 });
    return stdout.trim();
  } catch (error) {
    // Before the commit the lock is ours to drop; after it, leave the marked lock so a stale
    // real index can never be used silently (it keeps the worktree until a human looks).
    if (lock && !committed) await unlink(lock).catch(() => {});
    throw error;
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

  const originalPath = (path: string): string => join(parent, `${prefix}${originalName(repo, path)}`);
  const referenced = await repo.durablyReferencedWorktreePaths([
    ...new Set([...registered.keys()].flatMap((p) => [p, originalPath(p)])),
  ]);
  const locked = await lockedWorktreePaths(repo);

  // A misconfigured trash root (inside the repo, a symlink, relative) is judged ONCE, before any candidate is
  // preserved or quarantined, so it cannot churn every candidate on every sweep.
  let trashRoot = "";
  let rootProblem: string | null = null;
  try {
    trashRoot = opts.trashRoot ?? defaultTrashRoot();
    rootProblem =
      (isAbsolute(trashRoot) ? null : `${trashRoot} is not an absolute path`) ??
      (await trashRootInsideProblem(trashRoot, [repo.root, ...registered.keys()])) ??
      (await trashRootProblem(trashRoot, { sameFilesystemAs: parent }));
  } catch (error) {
    rootProblem = error instanceof Error ? error.message.split("\n")[0] || String(error) : String(error);
  }

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
    if (referenced.has(wt.path) || referenced.has(originalPath(wt.path))) {
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
    const activity = await worktreeActivity(wt.path);
    if (activity.unreadable) {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: `unreadable directory under ${activity.unreadable}: cannot show the tree is idle`,
      });
      continue;
    }
    const ageMs = now - activity.at;
    if (ageMs < minAge) {
      report.kept.push({
        path: wt.path,
        branch: wt.branch,
        reason: `active ${Math.round(ageMs / 60_000)} min ago (< ${Math.round(minAge / 60_000)} min minimum age)`,
      });
      continue;
    }
    const reason = `owner ${owner.missionId ?? owner.taskId} finished`;
    let terminalAt: number | null = null;
    try {
      terminalAt = (await opts.ownerTerminalAt?.(owner)) ?? null;
    } catch {
      terminalAt = null;
    }

    try {
      const unowned = await worktreeGitDir(wt.path)
        .then((g) => ownerMarkerProblem(repo, g, wt.branch))
        .catch(
          (e: unknown) =>
            `could not read the ownership marker, kept: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        );
      if (unowned) {
        report.kept.push({ path: wt.path, branch: wt.branch, reason: unowned });
        continue;
      }
      await assertNamespacePath(repo, wt.path, wt.branch);
      const bytes = await directoryBytes(wt.path);
      const keep = await reasonToKeep(repo, wt, locked, terminalAt);
      if (keep) {
        report.kept.push({ path: wt.path, branch: wt.branch, reason: keep });
        continue;
      }
      if (rootProblem) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `could not move it into the trash (${rootProblem}), kept`,
        });
        continue;
      }
      if (opts.dryRun) {
        report.reclaimed.push({
          path: wt.path,
          branch: wt.branch,
          preservedCommit: null,
          reason,
          trashedTo: null,
          bytes,
        });
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
        (await reasonToKeep(repo, wt, await lockedWorktreePaths(repo), terminalAt)) ??
        ((await newestTreeMtime(wt.path)) > planSnapshot ? "files changed while it was being reclaimed" : null);
      if (late) {
        report.kept.push({
          path: wt.path,
          branch: wt.branch,
          reason: `${late}${preservedCommit ? `; uncommitted work was preserved as ${preservedCommit}` : ""}`,
        });
        continue;
      }
      // Quarantine: `git worktree move` (bookkeeping-aware, reversible) takes the checkout out from
      // under any writer that only knows its original path, then everything is re-checked there.
      const quarantined = join(parent, `${prefix}reclaim-${Date.now().toString(36)}-${originalName(repo, wt.path)}`);
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
        (await reasonToKeep(repo, moved, await lockedWorktreePaths(repo), terminalAt).catch(
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
      // Move (never delete) the quarantined checkout into the trash. A rename cannot cross filesystems:
      // that is reported and the checkout goes back. The provisioned node_modules link travels with it, unfollowed.
      let trashedTo: string;
      try {
        trashedTo = await moveToTrash(trashRoot, "worktree", quarantined, basename(wt.path), wt.branch);
      } catch (error) {
        const cross = (error as NodeJS.ErrnoException).code === "EXDEV";
        await restore(
          `could not move it into the trash (${cross ? "state dir on different filesystem: set PI_TRASH_DIR next to the repos" : error instanceof Error ? error.message.split("\n")[0] : String(error)}), kept`,
        );
        continue;
      }
      // The registration now points at a missing directory; move only our own admin dir into the trash entry (never `git worktree prune`).
      const pruneNote = await moveOwnAdminDir(repo, quarantined, trashedTo, wt.path);
      report.reclaimed.push({
        path: wt.path,
        branch: wt.branch,
        preservedCommit,
        reason: `${reason}; moved to ${trashedTo}${pruneNote}`,
        trashedTo,
        bytes,
      });
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

/**
 * MOVE (never delete) ONLY the admin dir (`<common-git-dir>/worktrees/<id>`) of the checkout that was just moved to the
 * trash into the same trash entry as `<entry>/.pi-eng-admin`, so the worktree can be restored. `git worktree prune` is
 * never used: it has no path argument and would also drop any other registration whose `.git` file is missing
 * (an unmounted disk whose mount point still exists). The admin dir is found by `GitRepo.adminMatches` (the path its
 * `gitdir` file names, relative pointers resolved), must match exactly one entry, and must not be locked; anything
 * ambiguous, or a move that fails (e.g. another filesystem), leaves the registration in place and names the exact
 * admin dir. Everything in it was already checked as a keep condition or preserved on the branch before the move.
 */
async function moveOwnAdminDir(
  repo: GitRepo,
  movedFrom: string,
  trashedTo: string,
  originalPath: string,
): Promise<string> {
  const entry = dirname(trashedTo);
  const left = (why: string, admin?: string): string => {
    const where = admin ? `its admin dir is ${admin}` : "its admin dir is under the repository's .git/worktrees";
    const next = `the registration points at the quarantine path ${movedFrom}; after verifying that, run a plain \`git worktree remove ${shellQuote(movedFrom)}\`, or \`git worktree prune\` only after checking \`git worktree list --porcelain\` for other prunable entries (or restore the checkout and run \`git worktree repair\`)`;
    return `; its git registration was left in place (${why}); ${where}; ${next}`;
  };
  let moved: string | null = null;
  try {
    const matches = await repo.adminMatches(movedFrom);
    if (matches.length !== 1) return left(`${matches.length} admin dirs match its path`);
    const admin = matches[0] as string;
    if (await existsStrict(join(admin, "locked"))) return left("it is locked", admin);
    const kept = join(entry, ".pi-eng-admin");
    try {
      await rename(admin, kept);
    } catch (error) {
      return left(
        `could not move it into the trash entry: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
        admin,
      );
    }
    moved = kept;
    const common = dirname(dirname(admin));
    await recordTrashAdmin(entry, { adminId: basename(admin), commonDir: common }).catch(() => {});
    const free = (p: string): string => `test ! -e ${shellQuote(p)} && test ! -L ${shellQuote(p)}`;
    if ((await existsStrict(admin)) || (await existsStrict(originalPath))) {
      return `; git registration moved to ${kept}. Restore: its admin id or original path is taken: follow the README manual recipe (new admin name + rewrite .git)`;
    }
    // Refuses (non-zero, nothing moved) instead of letting `mv` nest into, or `repair` rewrite, something that took the id or path.
    const restore =
      `${free(admin)} && ${free(originalPath)} && mkdir -p ${shellQuote(dirname(admin))} && ` +
      `mv ${shellQuote(kept)} ${shellQuote(admin)} && ` +
      `{ mv ${shellQuote(trashedTo)} ${shellQuote(originalPath)} || ` +
      `{ mv ${shellQuote(admin)} ${shellQuote(kept)}; echo 'restore failed, admin dir moved back'; false; }; } && ` +
      `git -C ${shellQuote(repo.root)} worktree repair ${shellQuote(originalPath)}`;
    return `; git registration moved to ${kept}. To restore: ${restore}`;
  } catch (error) {
    if (moved) {
      // The admin dir is already in the trash entry: do not claim the registration is still in place.
      return `; git registration moved to ${moved}, but the restore command could not be prepared (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}); to restore, follow the README manual recipe`;
    }
    return left(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
  }
}

export interface UnmarkedWorktreeRow {
  path: string;
  branch: string | null;
  /** Why the worktree has no valid marker. */
  markerProblem: string;
  ownerStatus: OwnerLiveness | "no owner";
  /** No modified or untracked files (ignored derived output does not count). Null when it could not be read. */
  clean: boolean | null;
  ignored: string[];
  lastActivity: string | null;
  /** The exact command an operator may run, or null when the worktree must be kept; `note` says why. */
  command: string | null;
  note: string;
}

/**
 * READ-ONLY listing of namespace worktrees that lack a valid ownership marker (the ones created before markers
 * existed) with what an operator needs to decide by hand. Nothing is written or adopted: the janitor never reclaims
 * these, and adopting them is a deliberate future step. `command` is a plain `git worktree remove <path>` (never
 * forced) and appears only for a worktree that every other keep check would let the janitor reclaim and that is clean.
 */
export async function previewUnmarkedWorktrees(
  opts: Pick<JanitorOptions, "repo" | "ownerLiveness" | "ownerTerminalAt">,
): Promise<UnmarkedWorktreeRow[]> {
  const { repo } = opts;
  const prefix = repo.worktreeNamespacePrefix();
  const parent = dirname(repo.root);
  const locked = await lockedWorktreePaths(repo);
  const rows: UnmarkedWorktreeRow[] = [];
  for (const wt of await repo.listLinkedWorktrees()) {
    if (dirname(wt.path) !== parent || !basename(wt.path).startsWith(prefix)) continue;
    if (basename(wt.path).startsWith(`${prefix}pi-eng-pw-`)) continue;
    const row: UnmarkedWorktreeRow = {
      path: wt.path,
      branch: wt.branch,
      markerProblem: "",
      ownerStatus: "no owner",
      clean: null,
      ignored: [],
      lastActivity: null,
      command: null,
      note: "",
    };
    try {
      const problem = ownerMarkerProblem(repo, await worktreeGitDir(wt.path), wt.branch);
      if (!problem) continue; // marked: the janitor's business, not an adoption candidate
      row.markerProblem = problem;
      const owner = parseWorktreeOwner(ownerName(repo, wt));
      if (isPiEngOwned(repo, wt) && (owner.missionId || owner.taskId) && opts.ownerLiveness) {
        row.ownerStatus = await Promise.resolve(opts.ownerLiveness(owner)).catch(() => "unknown" as const);
      }
      const lines = await statusLines(wt.path, repo.root);
      row.clean = !lines.some((l) => !l.startsWith("!! "));
      row.ignored = lines.filter((l) => l.startsWith("!! ")).map(entryPath);
      row.lastActivity = new Date((await worktreeActivity(wt.path)).at).toISOString();
      if (!isPiEngOwned(repo, wt)) {
        row.note = "keep: not a pi-eng-candidate/orch branch, never reclaimed";
      } else if (row.ownerStatus !== "terminal") {
        row.note = `keep: owner is ${row.ownerStatus}`;
      } else {
        const terminalAt = (await opts.ownerTerminalAt?.(owner)) ?? null;
        const keep = await reasonToKeep(repo, wt, locked, terminalAt, true);
        if (keep) row.note = `keep: ${keep}`;
        else if (!row.clean) row.note = "keep: has uncommitted changes; commit or discard them yourself first";
        else {
          row.command = `git -C ${shellQuote(repo.root)} worktree remove ${shellQuote(wt.path)}`;
          row.note =
            "eligible by every other check (clean, owner finished); review it first, then remove it yourself (plain remove, never --force)";
        }
      }
    } catch (error) {
      row.note = `keep: could not inspect (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`;
    }
    rows.push(row);
  }
  return rows;
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
