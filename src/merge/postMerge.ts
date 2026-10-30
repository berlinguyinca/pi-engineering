/**
 * Post-merge smoke verification and policy revert (autospec R-MERGEQ, issue #151).
 *
 * After the {@link MergeQueue} merges an entry, a smoke command runs at the
 * merged SHA. A failure is ATTRIBUTABLE to the merge only when the same smoke
 * passed at the pre-merge target SHA: a failure that was already there before
 * the merge is somebody else's, and reverting for it would be wrong. The
 * `revertPolicy` then decides what happens to an attributable regression:
 *
 *   off      record only, create nothing
 *   propose  (default) prepare a revert commit on a NEW local branch
 *   auto     as propose, then enqueue the revert through the merge queue
 *
 * Nothing here rewrites history: no force-push, no reset, no write to the
 * target branch. A revert is a new commit on a new branch built in a temporary
 * worktree, so the target tip is exactly what it was. Landing the revert is the
 * queue's job (it is SHA-fenced like any other entry). Remote PR creation is out
 * of scope.
 */
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGitOrThrow } from "../git/safeGit.ts";
import type { PromoteResult, QueueEntry } from "./MergeQueue.ts";

export type RevertPolicy = "off" | "propose" | "auto";
export const DEFAULT_REVERT_POLICY: RevertPolicy = "propose";

/** Runs the smoke command with the repository at `sha`; true when it passes. */
export type SmokeRunner = (sha: string) => Promise<boolean>;

export type RevertBranchResult = { ok: true; sha: string; created: boolean } | { ok: false; reason: string };

/** The git operations the check needs; {@link gitPostMerge} is the real implementation. */
export interface PostMergeGit {
  /**
   * Create `branch` at `base` holding one commit that reverts `mergedSha`.
   * Idempotent: an existing `branch` is returned with `created: false`.
   * Refuses (never forces) when the revert does not apply cleanly.
   */
  createRevertBranch(args: { branch: string; mergedSha: string; base: string }): Promise<RevertBranchResult>;
  resolveRef(ref: string): Promise<string>;
}

/** Where the revert goes for `policy: auto`; a {@link MergeQueue} satisfies it. */
export interface RevertQueue {
  enqueue(entry: QueueEntry): Promise<PromoteResult>;
}

export interface PostMergeResult {
  /** The smoke passed at the merged SHA. */
  smokePassed: boolean;
  /** The smoke failed at the merged SHA and passed at the pre-merge SHA. */
  attributable: boolean;
  policy: RevertPolicy;
  /** Local branch holding the revert commit (propose and auto). */
  revertBranch?: string;
  /** Head of {@link revertBranch}. */
  revertSha?: string;
  /** The revert was accepted by the merge queue (auto only). */
  enqueued: boolean;
  /** Why no revert was prepared or enqueued, or what the queue said. */
  reason?: string;
}

/** Revert branch for a merge: stable, so a repeated check finds the same one. */
export function revertBranchName(entry: QueueEntry, mergedSha: string): string {
  const slug = entry.branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "branch";
  return `revert/${slug}-${mergedSha.slice(0, 12)}`;
}

/**
 * Smoke at the merged SHA; if it fails, at the pre-merge SHA to attribute it;
 * then apply the policy.
 */
export async function postMergeCheck(
  entry: QueueEntry,
  mergedSha: string,
  preMergeSha: string,
  smoke: SmokeRunner,
  policy: RevertPolicy | undefined,
  git: PostMergeGit,
  queue?: RevertQueue,
): Promise<PostMergeResult> {
  const effective = policy ?? DEFAULT_REVERT_POLICY;
  if (mergedSha === preMergeSha) throw new Error("merged SHA equals the pre-merge SHA; nothing was merged");
  if (await smoke(mergedSha)) return { smokePassed: true, attributable: false, policy: effective, enqueued: false };
  if (!(await smoke(preMergeSha))) {
    return {
      smokePassed: false,
      attributable: false,
      policy: effective,
      enqueued: false,
      reason: `smoke also fails at pre-merge ${preMergeSha}; the failure is not attributable to this merge`,
    };
  }
  const attributed = { smokePassed: false, attributable: true, policy: effective };
  if (effective === "off") {
    return { ...attributed, enqueued: false, reason: "revertPolicy is off; regression recorded only" };
  }
  const base = await git.resolveRef(entry.target);
  const revert = await git.createRevertBranch({ branch: revertBranchName(entry, mergedSha), mergedSha, base });
  if (!revert.ok) return { ...attributed, enqueued: false, reason: `revert not prepared: ${revert.reason}` };
  const prepared = { ...attributed, revertBranch: revertBranchName(entry, mergedSha), revertSha: revert.sha };
  if (effective === "propose") return { ...prepared, enqueued: false };
  if (!queue)
    return { ...prepared, enqueued: false, reason: "revertPolicy auto needs a merge queue; revert left proposed" };
  const queued = await queue.enqueue({
    branch: prepared.revertBranch,
    target: entry.target,
    reviewedHeadSha: revert.sha,
    boundBaseSha: base,
  });
  return queued.ok
    ? { ...prepared, enqueued: true }
    : { ...prepared, enqueued: false, reason: `merge queue refused the revert: ${queued.reason ?? "unknown"}` };
}

/** Real git over the repository at `repoDir`. */
export function gitPostMerge(repoDir: string): PostMergeGit {
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await safeGitOrThrow(args, { cwd, trust: "operator", maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  return {
    resolveRef: (ref) => git(repoDir, "rev-parse", "--verify", `${ref}^{commit}`),
    async createRevertBranch({ branch, mergedSha, base }) {
      const baseSha = await git(repoDir, "rev-parse", "--verify", `${base}^{commit}`);
      let existing = await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => "");
      if (existing === baseSha) {
        // An empty branch at the base is a failed earlier attempt, not a finished revert: drop it
        // (compare-and-swap, nothing on it) and build the revert again.
        await git(repoDir, "update-ref", "-d", `refs/heads/${branch}`, baseSha).catch(() => {});
        existing = await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => "");
      }
      if (existing) return { ok: true, sha: existing, created: false };
      const parents = (await git(repoDir, "rev-list", "--parents", "-n", "1", mergedSha)).split(" ").length - 1;
      const dir = await mkdtemp(join(tmpdir(), "pi-postmerge-"));
      // Never --force and never `branch -D`: plain remove (git refuses a dirty tree) and a
      // compare-and-swap delete that only succeeds while the branch still sits at the base.
      const dropEmptyBranch = (): Promise<unknown> =>
        git(repoDir, "update-ref", "-d", `refs/heads/${branch}`, baseSha).catch(() => {});
      try {
        await git(repoDir, "worktree", "add", "-q", "-b", branch, dir, base);
        const hasIdentity = await git(dir, "config", "user.email").then(
          (v) => v.length > 0,
          () => false,
        );
        const identity = hasIdentity
          ? []
          : ["-c", "user.name=pi-engineering", "-c", "user.email=pi-engineering@localhost"];
        try {
          await git(dir, ...identity, "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), mergedSha);
        } catch (error) {
          await git(dir, "revert", "--abort").catch(() => {});
          await git(repoDir, "worktree", "remove", dir).catch(() => {});
          await dropEmptyBranch();
          return {
            ok: false,
            reason: error instanceof Error ? (error.message.split("\n")[0] ?? "revert failed") : "revert failed",
          };
        }
        const sha = await git(dir, "rev-parse", "HEAD");
        await git(repoDir, "worktree", "remove", dir);
        return { ok: true, sha, created: true };
      } catch (error) {
        await git(repoDir, "worktree", "remove", dir).catch(() => {});
        await dropEmptyBranch();
        return {
          ok: false,
          reason: error instanceof Error ? (error.message.split("\n")[0] ?? "git failed") : "git failed",
        };
      } finally {
        // Empty after a successful `worktree remove`; a refused removal leaves its content in place.
        await rmdir(dir).catch(() => {});
      }
    },
  };
}
