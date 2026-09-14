/**
 * Git execution-context provider for the status bar.
 *
 * Resolves the current repository root, canonical repository identity, current
 * worktree, and branch/ref — using Git itself (never guessing from the
 * directory name). All subprocess results are cached and only re-resolved on
 * explicit invalidation (cwd/branch change, TTL expiry) — never during a footer
 * render. Git lookup failures degrade gracefully to `insideGit: false`.
 */

import { execFile } from "node:child_process";
import { basename, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitContext {
  insideGit: boolean;
  repositoryRoot?: string;
  repository?: string;
  worktree?: string;
  branch?: string;
  detachedHead?: string;
}

export type GitExecFn = (cwd: string, args: string[]) => Promise<string | null>;

export const DEFAULT_GIT_EXEC: GitExecFn = async (cwd, args) => {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/**
 * Parse a git remote origin URL into `owner/repo` (host-agnostic). Supports:
 *
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   ssh://git@host/owner/repo.git
 *   git://host/owner/repo.git
 *   user@host:owner/repo        (scp-style, no scheme)
 *
 * Strips a trailing `.git`. Returns null when the origin is absent or
 * unparseable. For paths with extra segments we use the last two as owner/repo.
 */
export function parseRemoteOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!u) return null;

  let path: string | null = null;
  if (u.includes("://")) {
    // scheme://[user@]host[:port]/owner/repo(.git)
    const m = u.match(/^[a-zA-Z][a-zA-Z+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/);
    path = m ? (m[1] ?? null) : null;
  } else if (u.includes(":")) {
    // scp-style: [user@]host:owner/repo(.git)
    const idx = u.indexOf(":");
    path = u.slice(idx + 1);
  } else {
    return null;
  }
  if (path == null) return null;

  // Strip trailing `.git` and slashes.
  path = path.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

export interface GitContextProviderOptions {
  now?: () => number;
  ttlMs?: number;
  /** Injectable git runner (defaults to real `git`). Used by tests. */
  exec?: GitExecFn;
}

export class GitContextProvider {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly run: GitExecFn;

  private cache: { cwd: string; context: GitContext; at: number } | null = null;

  constructor(opts: GitContextProviderOptions = {}) {
    this.clock = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.run = opts.exec ?? DEFAULT_GIT_EXEC;
  }

  /** Resolve git context for `cwd`, using the cache when fresh. */
  async resolve(cwd: string): Promise<GitContext> {
    const now = this.clock();
    if (this.cache && this.cache.cwd === cwd && now - this.cache.at < this.ttlMs) {
      return this.cache.context;
    }
    const context = await this.load(cwd);
    this.cache = { cwd, context, at: now };
    return context;
  }

  /** Drop the cache so the next resolve re-runs git (branch/cwd change, teardown). */
  invalidate(): void {
    this.cache = null;
  }

  private async load(cwd: string): Promise<GitContext> {
    try {
      const root = await this.run(cwd, ["rev-parse", "--show-toplevel"]);
      if (!root) return { insideGit: false };

      const gitDir = (await this.run(cwd, ["rev-parse", "--absolute-git-dir"])) ?? "";
      const origin = await this.run(cwd, ["config", "--get", "remote.origin.url"]);

      const branchRaw = await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      let branch: string | undefined;
      let detachedHead: string | undefined;
      if (branchRaw && branchRaw !== "HEAD") {
        branch = branchRaw;
      } else {
        detachedHead = (await this.run(cwd, ["rev-parse", "--short", "HEAD"])) ?? undefined;
      }

      // Linked worktree detection: a linked worktree's git dir lives under
      // <repo>/.git/worktrees/<name>. The primary worktree's git dir is the repo
      // root itself (or a plain `.git` dir), which we do not label with `wt:`.
      let worktree: string | undefined;
      const m = gitDir.match(/[\\/]worktrees[\\/]([^\\/]+?)[\\/]?$/);
      if (m) worktree = `wt:${m[1]}`;

      let repository: string | undefined;
      if (origin) {
        repository = parseRemoteOrigin(origin) ?? basename(root);
      } else {
        repository = basename(root);
      }

      return {
        insideGit: true,
        repositoryRoot: root,
        repository,
        worktree,
        branch,
        detachedHead,
      };
    } catch {
      return { insideGit: false };
    }
  }
}

/** Short human-readable label for the current directory. */
export function leafLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}
