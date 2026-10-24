/**
 * Git operations for alternative-implementation forks (T13), deliberately separate from `GitRepo`.
 *
 * `GitRepo.createWorktree` is built for crash recovery of the runtime's OWN candidate worktrees: it force-removes
 * whatever sits at the path and runs `git branch -D <branch>` first. A fork must never do that, so this class has
 * no delete, no prune, no reset, no force: every method either reads or refuses. Every call is argv-only (no shell),
 * with prompts disabled, and every ref or object name is validated before it reaches git.
 */
import { lstatSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { safeGit, tidyStderr } from "./safeGit.ts";

export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Branches this module creates: `pi-fork/fk-<16 hex>`. Nothing else is ever created, pushed or inspected. */
export const FORK_BRANCH = /^pi-fork\/fk-[0-9a-f]{16}$/;

export interface ForkDiffStat {
  files: number;
  insertions: number;
  deletions: number;
  paths: string[];
}

/** Everything the fork logic needs from Git. Injected, so tests can use a real throwaway repo or a double. */
export interface ForkGit {
  readonly repoRoot: string;
  commitExists(sha: string): Promise<boolean>;
  /** The commit is reachable from a branch, remote-tracking branch or tag: a dangling object is not a valid base. */
  commitReachable(sha: string): Promise<boolean>;
  /** What origin fetches from and pushes to after Git's own rewriting, plus URL-redirecting config. Read-only. */
  remoteConfig(): Promise<RemoteConfig>;
  /** The commit is reachable from a branch, remote-tracking branch or tag: a dangling object is not a valid base. */
  commitReachable(sha: string): Promise<boolean>;
  /**
   * What `origin` fetches from and pushes to after Git's own rewriting, plus every repository-local setting that
   * could redirect a URL (`url.*.insteadOf`, `pushInsteadOf`, `include`). Read-only.
   */
  remoteConfig(): Promise<RemoteConfig>;
  /** Create `branch` at `base` in a NEW worktree at `path`; throws (and changes nothing) if either already exists. */
  addWorktree(path: string, branch: string, base: string): Promise<void>;
  head(worktree: string): Promise<string>;
  isClean(worktree: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  diffStat(base: string, head: string): Promise<ForkDiffStat>;
  /** Head of `refs/heads/<branch>` at the explicit `url`, or null when it does not exist there. Throws when unreachable. */
  remoteBranchHead(url: string, branch: string): Promise<string | null>;
  /** Push exactly `sha` to `refs/heads/<branch>` at the explicit `url`. Never forced, never runs hooks. */
  push(url: string, branch: string, sha: string): Promise<{ ok: boolean; reason: string | null }>;
  freeDiskMb(path: string): number;
}

export interface RemoteConfig {
  fetch: string | null;
  push: string | null;
  /** Config keys that can rewrite a URL or pull in other config; any entry means the destination cannot be trusted. */
  rewrites: string[];
}

/** Matches a config key (lower-cased by git) that rewrites URLs. */
const REWRITE_KEY = /^url\..*\.(?:insteadof|pushinsteadof)$/;
const SAFE_URL = /^[A-Za-z0-9@:/._~%+-]{1,300}$/;

const MAX_PATHS = 100;

export class CliForkGit implements ForkGit {
  readonly repoRoot: string;
  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private run(args: readonly string[], cwd = this.repoRoot, timeoutMs = 60_000) {
    return safeGit(args, { cwd, timeoutMs });
  }

  async commitExists(sha: string): Promise<boolean> {
    if (!FULL_SHA.test(sha)) return false;
    const r = await this.run(["cat-file", "-e", `${sha}^{commit}`]);
    return r.code === 0;
  }

  async commitReachable(sha: string): Promise<boolean> {
    if (!(await this.commitExists(sha))) return false;
    const r = await this.run([
      "for-each-ref",
      "--count=1",
      "--contains",
      sha,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    return r.code === 0 && r.stdout.trim() !== "";
  }

  async remoteConfig(): Promise<RemoteConfig> {
    const url = async (push: boolean): Promise<string | null> => {
      const r = await this.run(["remote", "get-url", ...(push ? ["--push"] : []), "origin"], this.repoRoot, 15_000);
      const v = r.stdout.trim();
      return r.code === 0 && v ? v : null;
    };
    const rewrites: string[] = [];
    const eff = await this.run(["config", "--list", "--name-only"], this.repoRoot, 15_000);
    if (eff.code !== 0) rewrites.push("(config unreadable)");
    for (const key of eff.stdout.split("\n")) if (REWRITE_KEY.test(key.trim().toLowerCase())) rewrites.push(key.trim());
    const inc = await this.run(["config", "--no-includes", "--list", "--name-only"], this.repoRoot, 15_000);
    for (const key of inc.stdout.split("\n"))
      if (/^include(?:if\..*)?\.path$/.test(key.trim().toLowerCase())) rewrites.push(key.trim());
    return { fetch: await url(false), push: await url(true), rewrites: [...new Set(rewrites)] };
  }

  async addWorktree(path: string, branch: string, base: string): Promise<void> {
    if (!FORK_BRANCH.test(branch)) throw new Error("refusing a branch name this module did not derive");
    if (!FULL_SHA.test(base)) throw new Error("base must be a full commit id");
    // lstat, not exists: a dangling symlink at the path must be refused too, never followed.
    let present = true;
    try {
      lstatSync(path);
    } catch {
      present = false;
    }
    if (present) throw new Error("the worktree path already exists; nothing was changed");
    const ref = await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (ref.code === 0) throw new Error("the fork branch already exists; nothing was changed");
    if (!(await this.commitExists(base))) throw new Error("the base commit is not in this repository");
    const add = await this.run(["worktree", "add", "-b", branch, path, base]);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${tidyStderr(add.stderr)}`);
  }

  async head(worktree: string): Promise<string> {
    const r = await this.run(["rev-parse", "HEAD"], worktree);
    const sha = r.stdout.trim();
    if (r.code !== 0 || !FULL_SHA.test(sha)) throw new Error("cannot read the worktree head");
    return sha;
  }

  async isClean(worktree: string): Promise<boolean> {
    const r = await this.run(["status", "--porcelain", "--untracked-files=all"], worktree);
    if (r.code !== 0) throw new Error("cannot read the worktree status");
    return r.stdout.trim() === "";
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (!FULL_SHA.test(ancestor) || !FULL_SHA.test(descendant)) return false;
    return (await this.run(["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
  }

  async diffStat(base: string, head: string): Promise<ForkDiffStat> {
    if (!FULL_SHA.test(base) || !FULL_SHA.test(head)) throw new Error("full commit ids required");
    const r = await this.run([
      "diff",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-z",
      base,
      head,
      "--",
    ]);
    if (r.code !== 0) throw new Error("git diff failed");
    let insertions = 0;
    let deletions = 0;
    const paths: string[] = [];
    let files = 0;
    for (const rec of r.stdout.split("\0")) {
      if (!rec) continue;
      const [a, d, ...rest] = rec.split("\t");
      files++;
      insertions += /^\d+$/.test(a ?? "") ? Number(a) : 0;
      deletions += /^\d+$/.test(d ?? "") ? Number(d) : 0;
      if (paths.length < MAX_PATHS) paths.push(rest.join("\t").slice(0, 200));
    }
    return { files, insertions, deletions, paths };
  }

  async remoteBranchHead(url: string, branch: string): Promise<string | null> {
    if (!FORK_BRANCH.test(branch)) throw new Error("refusing a branch name this module did not derive");
    if (!SAFE_URL.test(url) || url.startsWith("-")) throw new Error("refusing an unsafe remote url");
    const r = await this.run(["ls-remote", "--heads", "--", url, `refs/heads/${branch}`], this.repoRoot, 30_000);
    if (r.code !== 0) throw new Error("the remote is unreachable");
    const line = r.stdout.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
    const sha = line?.split("\t")[0]?.trim() ?? "";
    return FULL_SHA.test(sha) ? sha : null;
  }

  async push(url: string, branch: string, sha: string): Promise<{ ok: boolean; reason: string | null }> {
    if (!FORK_BRANCH.test(branch) || !FULL_SHA.test(sha)) return { ok: false, reason: "invalid branch or commit" };
    if (!SAFE_URL.test(url) || url.startsWith("-")) return { ok: false, reason: "unsafe remote url" };
    // No --force, no --force-with-lease, no hooks: a remote branch that moved is refused, never overwritten.
    const r = await this.run(["push", "--no-verify", "--", url, `${sha}:refs/heads/${branch}`], this.repoRoot, 120_000);
    if (r.code === 0) return { ok: true, reason: null };
    return { ok: false, reason: tidyStderr(r.stderr || r.stdout || "push rejected") };
  }
  freeDiskMb(path: string): number {
    try {
      const s = statfsSync(
        (() => {
          try {
            lstatSync(path);
            return true;
          } catch {
            return false;
          }
        })()
          ? path
          : dirname(path),
      );
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    } catch {
      return 0; // unknown space is treated as none: fail closed
    }
  }
}
