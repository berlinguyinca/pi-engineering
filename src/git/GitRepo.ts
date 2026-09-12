import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Minimal Git repository provider (spec §7 `git/`, §13.3 worktree isolation).
 *
 * The core runtime talks to git through this small surface. It does not replace
 * git; it wraps the commands the vertical slice needs: repo detection, worktree
 * creation, diff capture, commit, and status.
 */
export class GitRepo {
  private readonly cwd: string;
  private readonly gitArgs: string[];

  private constructor(cwd: string) {
    this.cwd = cwd;
    this.gitArgs = ["-C", cwd];
  }

  /** Returns a GitRepo if `cwd` is inside a git work tree, else null. */
  static async open(cwd: string): Promise<GitRepo | null> {
    const repo = new GitRepo(cwd);
    try {
      await repo.git(["rev-parse", "--is-inside-work-tree"]);
      return repo;
    } catch {
      return null;
    }
  }

  private async git(args: string[], opts: { timeout?: number } = {}): Promise<GitResult> {
    const timeoutMs = opts.timeout ?? 120_000;
    try {
      const { stdout, stderr } = await exec("git", [...this.gitArgs, ...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
      return {
        stdout: (e.stdout as string) ?? "",
        stderr: (e.stderr as string) ?? (e.message ?? String(e)),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  get root(): string {
    return this.cwd;
  }

  async headCommit(): Promise<string> {
    const r = await this.git(["rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`);
    return r.stdout;
  }

  /** Resolve HEAD commit inside a specific worktree path. */
  async headCommitIn(path: string): Promise<string> {
    const r = await this.git(["-C", path, "rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error(`git rev-parse HEAD in ${path} failed: ${r.stderr}`);
    return r.stdout;
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.git(["branch", "--show-current"]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  async isClean(): Promise<boolean> {
    const r = await this.git(["status", "--porcelain"]);
    return r.code === 0 && r.stdout.length === 0;
  }

  async status(): Promise<string> {
    const r = await this.git(["status", "--short"]);
    return r.stdout;
  }

  /**
   * Create an isolated worktree on a new branch at the given base commit.
   * (INV-004 candidate isolation.)
   */
  async createWorktree(baseCommit: string, branch: string): Promise<WorktreeInfo> {
    const path = join(this.cwd, "..", `pi-eng-${branch}`);
    await mkdir(join(this.cwd, ".."), { recursive: true }).catch(() => {});
    // Clean up a stale worktree/branch if present (crash recovery).
    const add = await this.git(["worktree", "add", path, "-b", branch, baseCommit]);
    if (add.code !== 0) {
      // Retry after removing the stale branch.
      await this.git(["branch", "-D", branch]).catch(() => {});
      await this.git(["worktree", "prune"]);
      const add2 = await this.git(["worktree", "add", path, "-b", branch, baseCommit]);
      if (add2.code !== 0) throw new Error(`git worktree add failed: ${add2.stderr}`);
    }
    return { path, branch };
  }

  /** Remove a worktree (cleanup/recovery). Optionally keep the branch for lineage. */
  async removeWorktree(info: WorktreeInfo, opts: { keepBranch?: boolean } = {}): Promise<void> {
    await this.git(["worktree", "remove", "--force", info.path]);
    await this.git(["worktree", "prune"]);
    if (!opts.keepBranch) {
      await this.git(["branch", "-D", info.branch]).catch(() => {});
    }
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.git(["branch", "-D", branch]).catch(() => {});
  }

  /**
   * Controlled promotion: merge a verified candidate branch into the incumbent
   * (current) branch and update the working tree. The worker never writes to the
   * incumbent directly (INV-003); this is the runtime's evidence-gated merge.
   * Returns false (without mutating state) if the merge would conflict.
   */
  async mergeBranch(branch: string): Promise<{ merged: boolean; conflict: boolean }> {
    const r = await this.git(["--no-pager", "merge", "--no-ff", "-m", `promote ${branch}`, branch]);
    if (r.code === 0) return { merged: true, conflict: false };
    const conflicted = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    if (conflicted) {
      // Keep the incumbent immutable: abort the merge.
      await this.git(["merge", "--abort"]).catch(() => {});
    }
    return { merged: false, conflict: conflicted };
  }

  async commitAll(path: string, message: string): Promise<void> {
    await this.git(["-C", path, "add", "-A"]);
    const r = await this.git(["-C", path, "commit", "-m", message]);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  }

  /** Unified diff between two commits (or base and worktree HEAD). */
  async captureDiff(baseCommit: string, headCommit: string): Promise<string> {
    const r = await this.git(["diff", baseCommit, headCommit, "--", ":!package-lock.json"]);
    return r.stdout;
  }

  async changedFiles(baseCommit: string, headCommit: string): Promise<string[]> {
    const r = await this.git(["diff", "--name-only", baseCommit, headCommit]);
    return r.stdout ? r.stdout.split("\n").filter(Boolean) : [];
  }
}
