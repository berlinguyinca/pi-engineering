/**
 * Stable worktree identity.
 *
 * Ownership is never inferred from the process cwd or the repository NAME (two
 * repositories may share a name; several worktrees share one repository). A
 * worktree is identified by the canonical git common directory plus the
 * canonical worktree root:
 *
 *   worktree_id = sha256(realpath(git_common_dir) + "\0" + realpath(worktree_root))
 *   repo_id     = sha256(realpath(git_common_dir))
 *
 * A directory that is not inside a git worktree still gets a stable identity
 * from its canonical path, so non-git launches keep durable history.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeIdentity {
  kind: "git" | "directory";
  /** 24 hex chars of sha256; stable across processes and reboots. */
  worktreeId: string;
  /** Identifies the repository shared by all of its worktrees. */
  repoId: string;
  /** Canonical worktree root (git toplevel) or canonical directory. */
  worktreeRoot: string;
  /** Canonical git common dir; null for non-git directories. */
  gitCommonDir: string | null;
  /** Canonical per-worktree git dir; null for non-git directories. */
  gitDir: string | null;
  /** Human-readable repository name (display only, never identity). */
  repoName: string;
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function gitLines(cwd: string): Promise<[string, string, string] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"], {
      cwd,
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const [top, common, dir] = stdout.split("\n").map((line) => line.trim());
    if (!top || !common || !dir) return null;
    return [top, common, dir];
  } catch {
    return null;
  }
}

/** Resolve the worktree that contains `dir`. Never throws. */
export async function resolveWorktreeIdentity(dir: string): Promise<WorktreeIdentity> {
  const start = await canonical(dir);
  const git = await gitLines(start);
  if (git) {
    const [top, common, gitDir] = git;
    const worktreeRoot = await canonical(top);
    const gitCommonDir = await canonical(isAbsolute(common) ? common : resolve(start, common));
    const canonicalGitDir = await canonical(isAbsolute(gitDir) ? gitDir : resolve(start, gitDir));
    const commonBase =
      basename(gitCommonDir) === ".git" ? basename(resolve(gitCommonDir, "..")) : basename(gitCommonDir);
    return {
      kind: "git",
      worktreeId: digest(gitCommonDir, worktreeRoot),
      repoId: digest(gitCommonDir),
      worktreeRoot,
      gitCommonDir,
      gitDir: canonicalGitDir,
      repoName: commonBase.replace(/\.git$/, "") || basename(worktreeRoot),
    };
  }
  return {
    kind: "directory",
    worktreeId: digest("directory", start),
    repoId: digest("directory", start),
    worktreeRoot: start,
    gitCommonDir: null,
    gitDir: null,
    repoName: basename(start),
  };
}

/** True when `child` is `parent` or lies beneath it (both canonical). */
export function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
}
