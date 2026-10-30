/**
 * What would a plain `git worktree remove` destroy that git itself does not refuse?
 *
 * git refuses modified and untracked files but silently deletes IGNORED ones
 * (`.env`, local config, editor state). Cleanup must therefore check
 * `status --ignored` itself and keep + report a worktree that holds any.
 */
import { safeGit } from "./safeGit.ts";

/** Rebuildable build output, ignored at the worktree ROOT only. */
const DERIVED_ROOT_DIRS = new Set(["node_modules", "target", ".next", "dist", "coverage"]);

/**
 * Paths in the worktree that removal would lose: modified/untracked files and
 * ignored files other than derived root dirs. `ownNodeModulesLink` excludes the
 * root `node_modules` symlink that `GitRepo.linkSharedNodeModules` created.
 * Returns null when the worktree cannot be inspected (treat as unsafe).
 */
export async function removalBlockers(
  worktreePath: string,
  opts: { ownNodeModulesLink?: boolean } = {},
): Promise<string[] | null> {
  const r = await safeGit(["status", "--porcelain", "-z", "--ignored", "--untracked-files=all"], {
    cwd: worktreePath,
    trust: "operator",
  });
  if (r.code !== 0) return null;
  const blockers: string[] = [];
  for (const entry of r.stdout.split("\0")) {
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const root = path.split("/")[0] ?? path;
    if (status === "!!" && DERIVED_ROOT_DIRS.has(root)) continue;
    if (opts.ownNodeModulesLink && root === "node_modules") continue;
    blockers.push(`${status} ${path}`);
  }
  return blockers;
}
