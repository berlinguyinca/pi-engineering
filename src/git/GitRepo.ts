import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Short, stable, filesystem-safe hash of a path for unique worktree dirs. */
function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

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
  private readonly repoRoot: string;

  private constructor(cwd: string, repoRoot: string) {
    this.cwd = cwd;
    this.repoRoot = repoRoot;
    this.gitArgs = ["-C", repoRoot];
  }

  /** Returns a GitRepo if `cwd` is inside a git work tree, else null. */
  static async open(cwd: string): Promise<GitRepo | null> {
    try {
      // Resolve the actual repository toplevel so a caller in a subdirectory
      // (e.g. <repo>/src) still treats the whole repo as its root.
      const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 120_000 });
      if (!stdout.trim()) return null;
      const repo = new GitRepo(cwd, stdout.trim());
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
        stderr: (e.stderr as string) ?? e.message ?? String(e),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  get root(): string {
    return this.repoRoot;
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

  /** Working-tree status inside a specific path (e.g. a candidate worktree). */
  async statusIn(path: string): Promise<string> {
    const r = await this.git(["-C", path, "status", "--short"]);
    return r.stdout;
  }

  /**
   * Create an isolated worktree on a new branch at the given base commit.
   * (INV-004 candidate isolation.)
   *
   * The worktree path is derived from the repo root so that multiple repos (or
   * parallel test fixtures) never collide. A stale leftover at the path is
   * removed first (crash recovery).
   */
  async createWorktree(baseCommit: string, branch: string): Promise<WorktreeInfo> {
    // Place the worktree as a SIBLING of the repo root (outside the working
    // tree). Deriving the path from `this.cwd` would, when the runtime is
    // opened from a subdirectory, drop the worktree INSIDE the repo (visible
    // as an untracked dir in the main tree). repoRoot is stable regardless of
    // where the runtime was opened.
    const parent = join(this.repoRoot, "..");
    const path = join(parent, `pi-eng-${shortHash(this.repoRoot)}-${branch}`);
    await mkdir(parent, { recursive: true }).catch(() => {});
    // Crash recovery: clear any stale worktree or leftover directory at the path.
    await this.git(["worktree", "remove", "--force", path]).catch(() => {});
    await this.git(["branch", "-D", branch]).catch(() => {});
    await this.forgetWorktreeAdmin(path);
    await rm(path, { recursive: true, force: true }).catch(() => {});
    const add = await this.git(["worktree", "add", path, "-b", branch, baseCommit]);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    return { path, branch };
  }

  /**
   * Drop the administrative directory for ONE worktree path, if it is stale.
   *
   * This replaces `git worktree prune`, which is global: it removes the
   * administrative directory of every worktree whose working directory is
   * currently missing, including ones created moments ago — the
   * `gc.worktreePruneExpire` default does not protect them (checked against the
   * installed git). Since candidate isolation creates worktrees in parallel,
   * and `git worktree add` has a window where the administrative directory
   * exists before the working directory does, a prune issued by one creation
   * could delete a sibling's and leave it unusable
   * ("fatal: not a git repository: .../worktrees/<name>").
   *
   * Locking around the prune fixed that and cost the parallelism it was
   * protecting — candidates stopped overlapping at all. Removing only this
   * path's entry needs no lock, because every caller owns a distinct path.
   */
  private async forgetWorktreeAdmin(path: string): Promise<void> {
    const common = await this.git(["rev-parse", "--git-common-dir"]);
    if (common.code !== 0) return;
    const gitDir = common.stdout.trim();
    if (!gitDir) return;
    const absolute = gitDir.startsWith("/") ? gitDir : join(this.repoRoot, gitDir);
    // `git worktree add` names the administrative directory after the leaf of
    // the worktree path.
    await rm(join(absolute, "worktrees", basename(path)), { recursive: true, force: true }).catch(() => {});
  }

  /** Remove a worktree (cleanup/recovery). Optionally keep the branch for lineage. */
  async removeWorktree(info: WorktreeInfo, opts: { keepBranch?: boolean } = {}): Promise<void> {
    await this.git(["worktree", "remove", "--force", info.path]);
    // Targeted, for the same reason creation is: a global prune here would be
    // able to delete a concurrently-created sibling's administrative directory.
    await this.forgetWorktreeAdmin(info.path);
    if (!opts.keepBranch) {
      await this.git(["branch", "-D", info.branch]).catch(() => {});
    }
  }

  /**
   * The most recent commits, newest first.
   *
   * Uses a unit-separator between fields rather than a printable delimiter,
   * because commit subjects routinely contain every punctuation character a
   * naive split would choke on.
   */
  async recentCommits(limit = 5): Promise<Array<{ sha: string; subject: string; relative: string }>> {
    const r = await this.git(["--no-pager", "log", `-n${Math.max(1, limit)}`, "--format=%h%x1f%s%x1f%cr"]);
    if (r.code !== 0) return [];
    const out: Array<{ sha: string; subject: string; relative: string }> = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, subject, relative] = line.split("\x1f");
      if (!sha || !subject) continue;
      out.push({ sha, subject, relative: relative ?? "" });
    }
    return out;
  }

  /**
   * The patch a commit introduced.
   *
   * `--format=` drops the header so the result is a PURE diff: the panel's
   * gutter numbers diff hunks and colours `+`/`-` lines, and a `commit …` /
   * `Author: …` preamble would be numbered as source line 1. The subject
   * belongs in the view's title, not in its body.
   *
   * `--first-parent` is what makes this work on a merge, which by default shows
   * no patch at all — an empty pane where the operator asked to see a change.
   */
  async commitDiff(sha: string): Promise<string> {
    const r = await this.git(["--no-pager", "show", "--format=", "--patch", "--first-parent", sha]);
    if (r.code !== 0) return "";
    return r.stdout;
  }

  /**
   * Per-file added/removed line counts for the working tree.
   *
   * `--numstat` rather than parsing a diff: it is one line per file, and it
   * reports `-` for binary files instead of a count, which is a distinction the
   * panel should show rather than render as zero.
   */
  async diffStats(): Promise<Map<string, { added: number; removed: number; binary: boolean }>> {
    const out = new Map<string, { added: number; removed: number; binary: boolean }>();
    const r = await this.git(["--no-pager", "diff", "--numstat", "HEAD"]);
    if (r.code !== 0) return out;
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      const binary = added === "-" || removed === "-";
      out.set(path, {
        added: binary ? 0 : Number.parseInt(added ?? "0", 10) || 0,
        removed: binary ? 0 : Number.parseInt(removed ?? "0", 10) || 0,
        binary,
      });
    }
    return out;
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
  async mergeBranch(branch: string): Promise<{ merged: boolean; conflict: boolean; reason: string | null }> {
    const r = await this.git(["--no-pager", "merge", "--no-ff", "-m", `promote ${branch}`, branch]);
    if (r.code === 0) return { merged: true, conflict: false, reason: null };
    const conflicted = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    const reason = (r.stderr || r.stdout || "merge failed").split("\n")[0]?.slice(0, 200) ?? "merge failed";
    if (conflicted) {
      // Keep the incumbent immutable: abort the merge.
      await this.git(["merge", "--abort"]).catch(() => {});
    }
    return { merged: false, conflict: conflicted, reason };
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

  /**
   * Files under `paths` that changed since `commit` (committed AND uncommitted).
   * Used for impact-based roadmap-evidence invalidation (spec §10): conservative,
   * path-scoped, and model-free. `paths` may be git pathspecs (globs). An empty
   * `paths` matches everything.
   */
  async changedPathsSince(commit: string, paths: string[]): Promise<string[]> {
    // Fail-safe: an empty/placeholder/unknown commit is never "fresh". Evidence
    // MUST bind to a real commit SHA (roadmap spec §9); on any git error we treat
    // the scope as changed (stale) rather than silently fresh.
    if (!commit) return paths.length ? [...paths] : ["<unbound-evidence>"];
    const spec = paths.length ? ["--", ...paths] : [];
    const committed = await this.git(["diff", "--name-only", `${commit}..HEAD`, ...spec]);
    const uncommitted = await this.git(["status", "--porcelain", ...spec]);
    if (committed.code !== 0 || uncommitted.code !== 0) {
      return paths.length ? [...paths] : ["<git-error>"];
    }
    const set = new Set<string>();
    // git diff --name-only prints bare filenames.
    if (committed.stdout) {
      for (const line of committed.stdout.split("\n")) {
        const f = line.trim();
        if (f) set.add(f);
      }
    }
    // git status --porcelain prefixes each line with "XY " (2 status chars + space).
    if (uncommitted.stdout) {
      for (const line of uncommitted.stdout.split("\n")) {
        if (!line.trim()) continue;
        const file = line.slice(3).trim();
        if (file) set.add(file);
      }
    }
    return [...set];
  }
}
