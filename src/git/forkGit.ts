/**
 * Git operations for alternative-implementation forks (T13), deliberately separate from `GitRepo`.
 *
 * `GitRepo.createWorktree` is built for crash recovery of the runtime's OWN candidate worktrees: it force-removes
 * whatever sits at the path and runs `git branch -D <branch>` first. A fork must never do that, so this class has
 * no delete, no prune, no reset, no force: every method either reads or refuses. Every call is argv-only (no shell),
 * with prompts disabled, and every ref or object name is validated before it reaches git.
 */
import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

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
  /** Create `branch` at `base` in a NEW worktree at `path`; throws (and changes nothing) if either already exists. */
  addWorktree(path: string, branch: string, base: string): Promise<void>;
  head(worktree: string): Promise<string>;
  isClean(worktree: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  diffStat(base: string, head: string): Promise<ForkDiffStat>;
  /** Head of `refs/heads/<branch>` on origin, or null when it does not exist there. Throws when unreachable. */
  remoteBranchHead(branch: string): Promise<string | null>;
  /** Push exactly `sha` to `refs/heads/<branch>` on origin. Never forced: a non-fast-forward is refused. */
  push(branch: string, sha: string): Promise<{ ok: boolean; reason: string | null }>;
  freeDiskMb(path: string): number;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_PATHS = 100;

export class CliForkGit implements ForkGit {
  readonly repoRoot: string;
  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private run(args: readonly string[], cwd = this.repoRoot, timeoutMs = 60_000): Promise<Run> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C" },
        },
        (error, stdout, stderr) => {
          const code = error
            ? typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1
            : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  async commitExists(sha: string): Promise<boolean> {
    if (!FULL_SHA.test(sha)) return false;
    const r = await this.run(["cat-file", "-e", `${sha}^{commit}`]);
    return r.code === 0;
  }

  async addWorktree(path: string, branch: string, base: string): Promise<void> {
    if (!FORK_BRANCH.test(branch)) throw new Error("refusing a branch name this module did not derive");
    if (!FULL_SHA.test(base)) throw new Error("base must be a full commit id");
    if (existsSync(path)) throw new Error("the worktree path already exists; nothing was changed");
    const ref = await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (ref.code === 0) throw new Error("the fork branch already exists; nothing was changed");
    if (!(await this.commitExists(base))) throw new Error("the base commit is not in this repository");
    const add = await this.run(["worktree", "add", "-b", branch, path, base]);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.split("\n")[0]?.slice(0, 160) ?? ""}`);
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
    const r = await this.run(["diff", "--numstat", "--no-renames", "-z", base, head, "--"]);
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

  async remoteBranchHead(branch: string): Promise<string | null> {
    if (!FORK_BRANCH.test(branch)) throw new Error("refusing a branch name this module did not derive");
    const r = await this.run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], this.repoRoot, 30_000);
    if (r.code !== 0) throw new Error("origin is unreachable");
    const line = r.stdout.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
    const sha = line?.split("\t")[0]?.trim() ?? "";
    return FULL_SHA.test(sha) ? sha : null;
  }

  async push(branch: string, sha: string): Promise<{ ok: boolean; reason: string | null }> {
    if (!FORK_BRANCH.test(branch) || !FULL_SHA.test(sha)) return { ok: false, reason: "invalid branch or commit" };
    // No --force, no --force-with-lease: a remote branch that moved is refused, never overwritten.
    const r = await this.run(["push", "origin", `${sha}:refs/heads/${branch}`], this.repoRoot, 120_000);
    if (r.code === 0) return { ok: true, reason: null };
    return {
      ok: false,
      reason: (r.stderr || r.stdout || "push rejected").split("\n")[0]?.slice(0, 200) ?? "push rejected",
    };
  }

  freeDiskMb(path: string): number {
    try {
      const s = statfsSync(existsSync(path) ? path : dirname(path));
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    } catch {
      return 0; // unknown space is treated as none: fail closed
    }
  }
}
