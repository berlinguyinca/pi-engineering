/**
 * Effective workspace detection for parent-directory launches (spec §2/§3).
 *
 * `cd ~/IdeaProjects && pi` and then working on `~/IdeaProjects/inferweave`
 * must bind Pi Engineering to inferweave — not to whatever directory Pi was
 * started from. Activity (file paths the session touches) beneath the launch
 * directory reveals the worktree being worked on; the session then rebinds to
 * it, and tool/command resolution for the launch directory follows the binding.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { type WorktreeIdentity, isWithin, resolveWorktreeIdentity } from "./WorktreeIdentity.ts";

function canonicalSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/** Nearest existing directory at or above `path` (a file may not exist yet). */
function nearestDirectory(path: string): string | null {
  let current = path;
  for (;;) {
    try {
      const stat = statSync(current);
      return stat.isDirectory() ? current : dirname(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * The directory runtime resolution should use for a launch cwd: the bound
 * worktree when it lies beneath the launch directory (a parent launch that has
 * since rebound), otherwise the cwd itself.
 */
export function effectiveWorkspace(cwd: string, boundWorktreePath: string | null | undefined): string {
  if (!boundWorktreePath) return cwd;
  const launch = canonicalSync(cwd);
  if (boundWorktreePath !== launch && isWithin(launch, boundWorktreePath)) return boundWorktreePath;
  return cwd;
}

/**
 * The git worktree a touched path belongs to, when that path lies beneath the
 * launch directory and inside a git worktree other than `currentWorktree`.
 * Null means "no rebinding signal".
 */
export async function workspaceForPath(
  launchCwd: string,
  path: string,
  currentWorktree: string | null,
): Promise<WorktreeIdentity | null> {
  if (!path.trim()) return null;
  const expanded = expandHome(path.trim());
  const absolute = isAbsolute(expanded) ? expanded : resolve(launchCwd, expanded);
  const directory = nearestDirectory(absolute);
  if (!directory) return null;
  const launch = canonicalSync(launchCwd);
  const canonicalDirectory = canonicalSync(directory);
  if (!isWithin(launch, canonicalDirectory)) return null;
  const identity = await resolveWorktreeIdentity(canonicalDirectory);
  if (identity.kind !== "git") return null;
  if (identity.worktreeRoot === currentWorktree) return null;
  return identity;
}
