import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

export interface GitMutationGuard {
  assertAuthoritative(): void;
}

export interface PromotionResult {
  promoted: boolean;
  alreadyPromoted?: boolean;
  reason: string | null;
  candidateSha: string | null;
}

export interface CandidateLifecycle {
  missionId: string;
  repoId: string;
  generation: number;
  attempt: string;
  branch: string;
  path: string;
  baseSha: string;
  candidateSha: string;
  state: "integrating" | "preserved" | "promotion_intent" | "promoted";
  updatedAt: string;
}

interface PromotionLifecycle {
  missionId: string;
  repoId: string;
  generation: number;
  candidateSha: string;
  baseSha: string;
  state: "intent" | "completed";
  updatedAt: string;
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

  private async git(args: string[], opts: { timeout?: number; preserveStdout?: boolean } = {}): Promise<GitResult> {
    const timeoutMs = opts.timeout ?? 120_000;
    try {
      const { stdout, stderr } = await exec("git", [...this.gitArgs, ...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: opts.preserveStdout ? stdout : stdout.trim(), stderr: stderr.trim(), code: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
      return {
        stdout: opts.preserveStdout ? ((e.stdout as string) ?? "") : ((e.stdout as string) ?? "").trim(),
        stderr: (e.stderr as string) ?? e.message ?? String(e),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  get root(): string {
    return this.repoRoot;
  }

  /** Canonical shared object/admin directory, equal across linked worktrees. */
  async commonDir(): Promise<string> {
    const r = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (r.code !== 0) throw new Error(`git common directory lookup failed: ${r.stderr}`);
    return r.stdout;
  }

  private async candidateStateDir(): Promise<string> {
    const dir = join(await this.commonDir(), "pi-engineering-candidates");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async assertPromotionUnlocked(): Promise<void> {
    const lock = join(await this.commonDir(), "pi-engineering-promotion.lock");
    try {
      await access(lock);
      throw new Error("repository promotion critical section is held");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private candidateStateName(missionId: string, repoId: string, generation: number, attempt: string): string {
    return `${[missionId, repoId, String(generation), attempt]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".")}.json`;
  }

  private promotionStateName(
    record: Pick<PromotionLifecycle, "missionId" | "repoId" | "generation" | "candidateSha">,
  ): string {
    return `promotion.${[record.missionId, record.repoId, String(record.generation), record.candidateSha]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".")}.json`;
  }

  private async persistPromotionLifecycle(record: PromotionLifecycle, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(dir, this.promotionStateName(record));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
  }

  async persistCandidateLifecycle(record: CandidateLifecycle, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(
      dir,
      this.candidateStateName(record.missionId, record.repoId, record.generation, record.attempt),
    );
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
  }

  async loadCandidateLifecycles(missionId: string, repoId: string): Promise<CandidateLifecycle[]> {
    const dir = await this.candidateStateDir();
    const records: CandidateLifecycle[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as CandidateLifecycle;
        if (
          parsed.missionId === missionId &&
          parsed.repoId === repoId &&
          typeof parsed.attempt === "string" &&
          typeof parsed.branch === "string" &&
          typeof parsed.path === "string" &&
          typeof parsed.candidateSha === "string"
        ) {
          records.push(parsed);
        }
      } catch {
        // Malformed lifecycle records are ignored here and fail closed when no
        // usable candidate can be reconciled by the broker.
      }
    }
    return records.sort((a, b) => a.generation - b.generation || a.updatedAt.localeCompare(b.updatedAt));
  }

  async createCandidateWorktree(
    baseSha: string,
    identity: { missionId: string; repoId: string; generation: number; attempt: string },
    guard?: GitMutationGuard,
  ): Promise<CandidateLifecycle> {
    const existing = (await this.loadCandidateLifecycles(identity.missionId, identity.repoId)).find(
      (record) => record.generation === identity.generation && record.attempt === identity.attempt,
    );
    if (existing) {
      if (existing.state !== "integrating" && existing.state !== "promotion_intent") {
        throw new Error(`${existing.state} candidate attempt already exists at ${existing.branch}`);
      }
      const reconciled = await this.reconcileCandidateWorktree(existing, guard);
      if (reconciled) return existing;
      throw new Error(`candidate attempt already exists but cannot be reconciled: ${existing.branch}`);
    }
    const suffix = [identity.missionId, identity.repoId, identity.generation, identity.attempt]
      .join("-")
      .replace(/[^a-zA-Z0-9._-]/g, "-");
    const worktree = await this.createWorktree(baseSha, `pi-eng-candidate-${suffix}`, guard);
    const record: CandidateLifecycle = {
      ...identity,
      ...worktree,
      baseSha,
      candidateSha: await this.headCommitIn(worktree.path),
      state: "integrating",
      updatedAt: new Date().toISOString(),
    };
    await this.persistCandidateLifecycle(record, guard);
    return record;
  }

  /** Re-open the exact persisted candidate, mounting its worktree if a crash removed only the checkout. */
  async reconcileCandidateWorktree(record: CandidateLifecycle, guard?: GitMutationGuard): Promise<WorktreeInfo | null> {
    const ref = await this.resolveCommit(record.branch);
    if (ref !== record.candidateSha) return null;
    const mountedHead = await this.headCommitIn(record.path).catch(() => null);
    if (mountedHead === record.candidateSha) return { path: record.path, branch: record.branch };
    if (mountedHead !== null) return null;
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    const add = await this.git(["worktree", "add", record.path, record.branch]);
    if (add.code !== 0) return null;
    guard?.assertAuthoritative();
    return (await this.headCommitIn(record.path)) === record.candidateSha
      ? { path: record.path, branch: record.branch }
      : null;
  }

  async headCommit(): Promise<string> {
    const r = await this.git(["rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`);
    return r.stdout;
  }

  /** Resolve a ref only when this repository owns the referenced commit. */
  async resolveCommit(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", `${ref}^{commit}`]);
    return r.code === 0 && r.stdout ? r.stdout : null;
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
  async createWorktree(baseCommit: string, branch: string, guard?: GitMutationGuard): Promise<WorktreeInfo> {
    await this.assertPromotionUnlocked();
    // Place the worktree as a SIBLING of the repo root (outside the working
    // tree). Deriving the path from `this.cwd` would, when the runtime is
    // opened from a subdirectory, drop the worktree INSIDE the repo (visible
    // as an untracked dir in the main tree). repoRoot is stable regardless of
    // where the runtime was opened.
    const parent = join(this.repoRoot, "..");
    const path = join(parent, `pi-eng-${shortHash(this.repoRoot)}-${branch}`);
    await mkdir(parent, { recursive: true }).catch(() => {});
    // Crash recovery: clear any stale worktree or leftover directory at the path.
    guard?.assertAuthoritative();
    await this.git(["worktree", "remove", "--force", path]).catch(() => {});
    guard?.assertAuthoritative();
    await this.git(["branch", "-D", branch]).catch(() => {});
    guard?.assertAuthoritative();
    await this.forgetWorktreeAdmin(path);
    guard?.assertAuthoritative();
    await rm(path, { recursive: true, force: true }).catch(() => {});
    guard?.assertAuthoritative();
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
  async removeWorktree(
    info: WorktreeInfo,
    opts: { keepBranch?: boolean } = {},
    guard?: GitMutationGuard,
  ): Promise<void> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    await this.git(["worktree", "remove", "--force", info.path]);
    // Targeted, for the same reason creation is: a global prune here would be
    // able to delete a concurrently-created sibling's administrative directory.
    guard?.assertAuthoritative();
    await this.forgetWorktreeAdmin(info.path);
    if (!opts.keepBranch) {
      guard?.assertAuthoritative();
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

  async deleteBranch(branch: string, guard?: GitMutationGuard): Promise<void> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    await this.git(["branch", "-D", branch]).catch(() => {});
  }

  /**
   * Controlled promotion: merge a verified candidate branch into the incumbent
   * (current) branch and update the working tree. The worker never writes to the
   * incumbent directly (INV-003); this is the runtime's evidence-gated merge.
   * Returns false (without mutating state) if the merge would conflict.
   */
  async mergeBranch(
    branch: string,
    guard?: GitMutationGuard,
  ): Promise<{ merged: boolean; conflict: boolean; reason: string | null }> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    const r = await this.git(["--no-pager", "merge", "--no-ff", "-m", `promote ${branch}`, branch]);
    if (r.code === 0) return { merged: true, conflict: false, reason: null };
    const conflicted = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    const reason = (r.stderr || r.stdout || "merge failed").split("\n")[0]?.slice(0, 200) ?? "merge failed";
    if (conflicted) {
      // Keep the incumbent immutable: abort the merge.
      guard?.assertAuthoritative();
      await this.git(["merge", "--abort"]).catch(() => {});
    }
    return { merged: false, conflict: conflicted, reason };
  }

  /** Merge one handoff into an isolated integration candidate, never the incumbent checkout. */
  async mergeRefInWorktree(
    candidate: WorktreeInfo,
    ref: string,
    guard?: GitMutationGuard,
  ): Promise<{ merged: boolean; conflict: boolean; reason: string | null }> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    const r = await this.git(["-C", candidate.path, "--no-pager", "merge", "--no-ff", "-m", `integrate ${ref}`, ref]);
    if (r.code === 0) return { merged: true, conflict: false, reason: null };
    const conflicted = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    const reason = (r.stderr || r.stdout || "merge failed").split("\n")[0]?.slice(0, 200) ?? "merge failed";
    if (conflicted) {
      guard?.assertAuthoritative();
      await this.git(["-C", candidate.path, "merge", "--abort"]);
    }
    return { merged: false, conflict: conflicted, reason };
  }

  /**
   * Promote a fully gated candidate into the local incumbent checkout.
   * The bound base is checked immediately before the single reset mutation;
   * divergence leaves HEAD, index, and tree unchanged.
   */
  async promoteCandidate(
    candidate: WorktreeInfo,
    boundBase: string,
    guard?: GitMutationGuard,
    lifecycle?: CandidateLifecycle,
  ): Promise<PromotionResult> {
    const lockPath = join(await this.commonDir(), "pi-engineering-promotion.lock");
    guard?.assertAuthoritative();
    try {
      await mkdir(lockPath);
    } catch {
      let ownerPid: number | undefined;
      try {
        ownerPid = (JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid?: number }).pid;
      } catch {
        ownerPid = undefined;
      }
      let live = false;
      if (ownerPid) {
        try {
          process.kill(ownerPid, 0);
          live = true;
        } catch {
          live = false;
        }
      }
      if (live) {
        return { promoted: false, reason: "repository promotion critical section is already held", candidateSha: null };
      }
      await rm(lockPath, { recursive: true, force: true });
      guard?.assertAuthoritative();
      await mkdir(lockPath);
    }
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() }),
    );
    try {
      const candidateSha = await this.resolveCommit(candidate.branch);
      if (!candidateSha) return { promoted: false, reason: "candidate ref is unavailable", candidateSha: null };
      if ((await this.statusIn(candidate.path)) !== "") {
        return { promoted: false, reason: "candidate worktree is not clean", candidateSha };
      }
      const incumbent = await this.headCommit();
      if (incumbent === candidateSha) {
        const reconciled = await this.git(["reset", "--hard", candidateSha]);
        if (reconciled.code !== 0) {
          return { promoted: false, reason: reconciled.stderr || "promotion reconciliation failed", candidateSha };
        }
        if (lifecycle) {
          await this.persistPromotionLifecycle({
            missionId: lifecycle.missionId,
            repoId: lifecycle.repoId,
            generation: lifecycle.generation,
            candidateSha,
            baseSha: boundBase,
            state: "completed",
            updatedAt: new Date().toISOString(),
          });
          await this.persistCandidateLifecycle({
            ...lifecycle,
            candidateSha,
            state: "promoted",
            updatedAt: new Date().toISOString(),
          });
        }
        return { promoted: true, alreadyPromoted: true, reason: null, candidateSha };
      }
      if (incumbent !== boundBase) {
        return { promoted: false, reason: `incumbent diverged from bound base ${boundBase}`, candidateSha };
      }
      const candidateRuntimePaths = (await this.changedFiles(boundBase, candidateSha)).filter(
        (path) => path === ".pi-eng" || path.startsWith(".pi-eng/"),
      );
      if (candidateRuntimePaths.length > 0) {
        return {
          promoted: false,
          reason: `candidate collides with runtime-owned state: ${candidateRuntimePaths.join(", ")}`,
          candidateSha,
        };
      }
      const incumbentStatus = await this.git(["status", "--porcelain", "--untracked-files=all"]);
      const incumbentDirt = incumbentStatus.stdout
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("?? .pi-eng/"))
        .join("\n");
      if (incumbentStatus.code !== 0 || incumbentDirt.length > 0) {
        return {
          promoted: false,
          reason: `incumbent index or working tree is not clean: ${incumbentDirt || incumbentStatus.stderr}`,
          candidateSha,
        };
      }
      guard?.assertAuthoritative();
      if (lifecycle) {
        await this.persistPromotionLifecycle(
          {
            missionId: lifecycle.missionId,
            repoId: lifecycle.repoId,
            generation: lifecycle.generation,
            candidateSha,
            baseSha: boundBase,
            state: "intent",
            updatedAt: new Date().toISOString(),
          },
          guard,
        );
        await this.persistCandidateLifecycle(
          { ...lifecycle, candidateSha, state: "promotion_intent", updatedAt: new Date().toISOString() },
          guard,
        );
      }
      // Repository authority serializes local promotion. Recheck at the mutation
      // boundary so a stale or diverged incumbent is rejected without a write.
      if ((await this.headCommit()) !== boundBase) {
        return { promoted: false, reason: `incumbent diverged from bound base ${boundBase}`, candidateSha };
      }
      guard?.assertAuthoritative();
      const advanced = await this.git(["update-ref", "HEAD", candidateSha, boundBase]);
      if (advanced.code !== 0) {
        return {
          promoted: false,
          reason: advanced.stderr || advanced.stdout || "promotion compare-and-swap failed",
          candidateSha,
        };
      }
      // From this point promotion is committed. Complete checkout reconciliation
      // even if the lease expires during the subprocess; restart follows the same
      // HEAD==candidate path above.
      const promoted = await this.git(["reset", "--hard", candidateSha]);
      if (promoted.code !== 0) {
        return {
          promoted: false,
          reason: `promotion committed; checkout reconciliation failed: ${promoted.stderr}`,
          candidateSha,
        };
      }
      if (lifecycle) {
        // Once HEAD moved, authority loss is reconciled as a committed promotion,
        // never reported as an ordinary rejection that callers might retry.
        await this.persistCandidateLifecycle({
          ...lifecycle,
          candidateSha,
          state: "promoted",
          updatedAt: new Date().toISOString(),
        });
        await this.persistPromotionLifecycle({
          missionId: lifecycle.missionId,
          repoId: lifecycle.repoId,
          generation: lifecycle.generation,
          candidateSha,
          baseSha: boundBase,
          state: "completed",
          updatedAt: new Date().toISOString(),
        });
      }
      return { promoted: true, reason: null, candidateSha };
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async commitAll(path: string, message: string, guard?: GitMutationGuard): Promise<void> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    await this.git(["-C", path, "add", "-A"]);
    guard?.assertAuthoritative();
    const r = await this.git(["-C", path, "commit", "-m", message]);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  }

  /**
   * Number of commits in `range` (e.g. "HEAD..branch") — i.e. committed work
   * on the branch that the incumbent has not yet received. null when git
   * cannot answer (bad ref, git failure): "unknown" is not "no commits", and
   * the caller decides how to surface it.
   */
  async revListCount(range: string): Promise<number | null> {
    const r = await this.git(["--no-pager", "rev-list", "--count", range]);
    if (r.code !== 0) return null;
    const n = Number.parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  /** Unified diff between two commits (or base and worktree HEAD). */
  async captureDiff(baseCommit: string, headCommit: string): Promise<string> {
    const r = await this.git(["diff", baseCommit, headCommit, "--", ":!package-lock.json"]);
    return r.stdout;
  }

  async changedFiles(baseCommit: string, headCommit: string): Promise<string[]> {
    const r = await this.git(["diff", "--no-renames", "--name-only", "-z", baseCommit, headCommit], {
      preserveStdout: true,
    });
    return r.stdout ? r.stdout.split("\0").filter(Boolean) : [];
  }

  /** NUL-safe working-tree paths, including both endpoints of renames/copies. */
  async statusPathsIn(path: string): Promise<string[]> {
    const r = await this.git(["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      preserveStdout: true,
    });
    if (r.code !== 0 || !r.stdout) return [];
    const records = r.stdout.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const status = record.slice(0, 2);
      const destination = record.slice(3);
      if (destination) paths.push(destination);
      if (status.includes("R") || status.includes("C")) {
        const source = records[++i];
        if (source) paths.push(source);
      }
    }
    return paths;
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

  /**
   * True when `branch` carries commits since `baseCommit` (i.e. its tip is not
   * the base commit). This is how a worker's OWN commits are recognized: an
   * implementer that commits directly onto its worker branch leaves a clean
   * working tree, but the branch has advanced past base — the work HAS landed
   * there. Returns false when the branch cannot be resolved or has no commits
   * beyond base.
   */
  async branchAheadOf(baseCommit: string, branch: string): Promise<boolean> {
    const r = await this.git(["rev-list", "--count", `${baseCommit}..${branch}`]);
    if (r.code !== 0) return false;
    const n = Number.parseInt(r.stdout, 10);
    return Number.isFinite(n) && n > 0;
  }

  /**
   * True when `commit` is an ancestor of `ancestorOf` (reachable from it).
   *
   * Used to decide whether a worker branch's work is already contained in the
   * integrated checkout before a cleanup is allowed to force-delete the branch.
   * A branch whose tip is NOT an ancestor of HEAD still carries unmerged work
   * and must be preserved; returning false on any git error makes cleanup err on
   * the safe side (preserve rather than destroy).
   */
  async isAncestor(commit: string, ancestorOf: string): Promise<boolean> {
    const r = await this.git(["merge-base", "--is-ancestor", commit, ancestorOf]);
    return r.code === 0;
  }
}
