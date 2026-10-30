/**
 * What would a plain `git worktree remove` destroy that git itself does not refuse?
 *
 * git refuses modified and untracked files but silently deletes IGNORED ones
 * (`.env`, local config, editor state). Cleanup must therefore check
 * `status --ignored` itself and keep + report a worktree that holds any
 * ignored file that is not well-known derived build output.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { safeGit } from "./safeGit.ts";

/** Rebuildable build output, disposable when ignored at the worktree ROOT. */
const ROOT_DERIVED_DIRS = new Set(["node_modules", "target", ".next", "dist", "coverage"]);
/** Well-known cache/build directories, disposable at ANY depth when ignored. */
const ANY_DEPTH_DERIVED_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  ".tox",
  ".venv",
  "build",
]);
/** Well-known derived files, disposable at any depth when ignored. */
const DERIVED_FILE = /(\.pyc|\.tsbuildinfo)$/;

const MAX_WALK_ENTRIES = 1_000_000;

/** True when a `.git` file or directory exists anywhere beneath `dir`, or it cannot be proven repo-free. */
async function containsGitEntry(dir: string): Promise<boolean> {
  let seen = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!entries) return true; // unreadable: cannot prove it repo-free
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (++seen > MAX_WALK_ENTRIES) return true;
      if (entry.isDirectory()) queue.push(join(current, entry.name));
    }
  }
  return false;
}

/**
 * git collapses a directory whose content is ALL ignored into one `!! dir/` entry, hiding what is
 * inside (a `pkg/` holding only `__pycache__/` and `node_modules/`, or a `.env`). Walk it: it is
 * disposable only when every file is derived output and no nested repository is beneath it.
 */
async function onlyDerivedBeneath(dir: string, budget: { left: number }): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  for (const entry of entries) {
    if (--budget.left < 0 || entry.name === ".git") return false;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ANY_DEPTH_DERIVED_DIRS.has(entry.name)) {
        if (await containsGitEntry(full)) return false;
      } else if (!(await onlyDerivedBeneath(full, budget))) return false;
    } else if (!DERIVED_FILE.test(entry.name)) return false;
  }
  return true;
}

async function isDisposableDerived(worktreePath: string, path: string): Promise<boolean> {
  const isDir = path.endsWith("/");
  const clean = path.replace(/\/+$/, "");
  const name = clean.split("/").pop() ?? clean;
  const atRoot = !clean.includes("/");
  if (isDir) {
    const ok = (atRoot && ROOT_DERIVED_DIRS.has(name)) || ANY_DEPTH_DERIVED_DIRS.has(name);
    // A nested git repository under derived output is somebody's work, not output.
    if (ok) return !(await containsGitEntry(join(worktreePath, clean)));
    return onlyDerivedBeneath(join(worktreePath, clean), { left: MAX_WALK_ENTRIES });
  }
  return DERIVED_FILE.test(name);
}

/**
 * Paths in the worktree that removal would lose: modified/untracked files and
 * ignored entries that are not derived build output. Directories are collapsed
 * (`--untracked-files=normal`), so a huge `target/` is one entry, not 250k.
 * `ownNodeModulesLink` excludes the root `node_modules` symlink that
 * `GitRepo.linkSharedNodeModules` created. Returns null when the worktree cannot
 * be inspected (treat as unsafe).
 */
export async function removalBlockers(
  worktreePath: string,
  opts: { ownNodeModulesLink?: boolean } = {},
): Promise<string[] | null> {
  const r = await safeGit(["status", "--porcelain", "-z", "--ignored", "--untracked-files=normal"], {
    cwd: worktreePath,
    trust: "operator",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.code !== 0 || r.truncated) return null;
  const blockers: string[] = [];
  const tokens = r.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as string;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (/[RC]/.test(status)) i++; // a rename/copy record is followed by its origin path
    if (opts.ownNodeModulesLink && path.replace(/\/+$/, "") === "node_modules") continue;
    if (status === "!!" && (await isDisposableDerived(worktreePath, path))) continue;
    blockers.push(`${status} ${path}`);
  }
  return blockers;
}
