/**
 * Pi's own look at a repository's git directories before any git process touches them (T16 round 4).
 *
 * The directories are shared with whoever works in a linked worktree. A symbolic link planted where git expects a
 * plain file or directory (`worktrees/<n>/index`, `packed-refs`, `FETCH_HEAD`, `shallow`, `HEAD`, `config`, anything
 * under `refs/` or `logs/`) makes git write outside the repository (an `index` link to `~/.ssh/authorized_keys` is
 * written with attacker-chosen path names) or read a file it should never read and quote its first line in an error.
 * Git does not defend against that. So: every entry that matters is looked at with `lstat` semantics first, and a
 * symbolic link, a socket, a FIFO or a device where a regular file or directory belongs refuses the call.
 *
 * Only `readdir` entry types are used (no per-file stat), so the cost is one directory read per directory.
 */
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Entries visited per call; a repository with more loose refs/log files than this is refused (fail closed). */
let treeScanLimit = 100_000;
export const TREE_SCAN_LIMIT = 100_000;
/** Test hook: a small limit exercises the fail-closed path without creating 100k files. */
export function setTreeScanLimitForTests(n: number): void {
  treeScanLimit = n;
}

function list(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

class Budget {
  left: number;
  constructor(left: number) {
    this.left = left;
  }
  /** Set when the entry budget ran out (as opposed to something being wrong with an entry). */
  limit = false;
}

const OUT_OF_BUDGET = "too many entries to verify";

/**
 * A regular file in the scan set must have exactly one name: a hard link is another name for a file somewhere else
 * (an `~/.ssh/authorized_keys` that git would append to, a log it would truncate), and unlike a symbolic link
 * nothing in the directory entry gives it away. `objects/` is exempt (a local clone legitimately hard-links objects).
 */
function linked(path: string): boolean {
  try {
    return lstatSync(path).nlink > 1;
  } catch {
    return false;
  }
}

function over(budget: Budget, where: string): string {
  budget.limit = true;
  return `${where || "the git directory"}: ${OUT_OF_BUDGET}`;
}

/** Everything below `dir` must be a regular file or a directory. Returns the first offender, or null. */
function walk(dir: string, rel: string, budget: Budget): string | null {
  const entries = list(dir);
  if (entries === null) return null;
  for (const e of entries) {
    if (--budget.left < 0) return over(budget, rel);
    if (e.isSymbolicLink()) return `${rel}/${e.name} is a symbolic link`;
    if (e.isDirectory()) {
      const r = walk(join(dir, e.name), `${rel}/${e.name}`, budget);
      if (r) return r;
    } else if (!e.isFile()) {
      return `${rel}/${e.name} is not a regular file`;
    } else if (linked(join(dir, e.name))) {
      return `${rel}/${e.name} has more than one hard link`;
    }
  }
  return null;
}

/** Top level of a git directory: no symbolic links or special files (`hooks` is replaced by an empty directory, so it is skipped). */
function topLevel(dir: string, rel: string, budget: Budget): string | null {
  const entries = list(dir);
  if (entries === null) return null;
  for (const e of entries) {
    if (--budget.left < 0) return over(budget, rel);
    if (e.name === "hooks") continue;
    if (e.isSymbolicLink()) return `${rel}${e.name} is a symbolic link`;
    if (!e.isFile() && !e.isDirectory()) return `${rel}${e.name} is not a regular file or directory`;
    if (e.isFile() && linked(join(dir, e.name))) return `${rel}${e.name} has more than one hard link`;
  }
  return null;
}

/**
 * Verify the git directories of one repository. Returns a human-readable reason to refuse, or null when every
 * entry is a regular file or directory.
 */
/** The entry budget `pack-refs` / `gc` get: the way out of a too-large tree must still look at every entry. */
export const UNBOUNDED_SCAN = 50_000_000;

export function scanRepoTree(layout: { gitDir: string; commonDir: string }): string | null {
  return scanRepoTreeDetailed(layout).reason;
}

/** Like `scanRepoTree`, and says whether the reason is only that there is too much to look at (recoverable by packing refs). */
export function scanRepoTreeDetailed(
  layout: { gitDir: string; commonDir: string },
  limit: number = treeScanLimit,
): {
  reason: string | null;
  overLimit: boolean;
} {
  const budget = new Budget(limit);
  const reason = scanInto(layout, budget);
  return { reason, overLimit: reason !== null && budget.limit };
}

function scanInto(layout: { gitDir: string; commonDir: string }, budget: Budget): string | null {
  const dirs = layout.gitDir === layout.commonDir ? [layout.commonDir] : [layout.commonDir, layout.gitDir];
  for (const dir of dirs) {
    const shown = dir === layout.commonDir ? "" : "worktree admin dir: ";
    const top = topLevel(dir, shown, budget);
    if (top) return top;
    // the trees git reads and writes through names it did not choose
    for (const sub of ["refs", "logs", "info"]) {
      const r = walk(join(dir, sub), `${shown}${sub}`, budget);
      if (r) return r;
    }
  }
  // objects: the top level (fan-out directories, info, pack) and the two small directories git consults by name
  for (const sub of ["objects", join("objects", "info"), join("objects", "pack")]) {
    const entries = list(join(layout.commonDir, sub));
    if (entries === null) continue;
    for (const e of entries) {
      if (--budget.left < 0) return over(budget, sub);
      if (e.isSymbolicLink()) return `${sub}/${e.name} is a symbolic link`;
      if (!e.isFile() && !e.isDirectory()) return `${sub}/${e.name} is not a regular file or directory`;
    }
  }
  // administrative directories of the other linked worktrees (their index, HEAD, gitdir ...)
  const worktrees = list(join(layout.commonDir, "worktrees"));
  for (const w of worktrees ?? []) {
    if (--budget.left < 0) return over(budget, "worktrees");
    if (w.isSymbolicLink()) return `worktrees/${w.name} is a symbolic link`;
    if (!w.isDirectory()) continue;
    const top = topLevel(join(layout.commonDir, "worktrees", w.name), `worktrees/${w.name}/`, budget);
    if (top) return top;
    const logs = walk(join(layout.commonDir, "worktrees", w.name, "logs"), `worktrees/${w.name}/logs`, budget);
    if (logs) return logs;
  }
  return null;
}
