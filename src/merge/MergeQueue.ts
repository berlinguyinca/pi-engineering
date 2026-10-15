/**
 * Integration & merge queue (spec §31, backlog B-112).
 *
 * Promotion through levels with integration rebase and conflict policy.
 *
 *   Levels (spec §31.1): CANDIDATE (isolated worktree) -> INTEGRATION (rebase
 *   onto latest main, run gate) -> MAIN (controlled merge).
 *
 * The queue serializes promotions so concurrent candidates integrate
 * sequentially (avoiding the index.lock race that M13's parallel DAG must
 * solve). Rebase is attempted before merge; on conflict the promotion is
 * rejected and reported so the candidate can be repaired.
 *
 * Deterministic and testable against real fixture repos via the injected git
 * primitives (which default to shelling out to `git`).
 *
 * SHA-fenced entries (autospec R-MERGEQ, issue #150): `enqueue` takes an entry
 * bound to the head SHA that was reviewed and the base SHA it was validated
 * against. Entries are serialized PER TARGET BRANCH (different targets proceed
 * concurrently; `promote` shares the main branch's chain, so there is never a
 * second queue for one branch). Immediately before merging the queue checks both
 * SHAs again: a head or target tip that moved means rebase, gate rerun and a
 * fresh baseline, never a merge of something other than what was reviewed.
 * Required checks block when failing or pending; "none" means no protection is
 * configured. Optional CI never blocks, because it is not a required check.
 */
import type { CanonicalLifecycleState } from "../orchestration/canonicalLifecycle.ts";
import type { VerifyOutcome } from "../verify/Verifier.ts";
import { type FailureBaseline, compareToBaseline } from "../verify/failureBaseline.ts";

export type PromotionLevel = "candidate" | "integration" | "main";

export interface RebaseResult {
  ok: boolean;
  conflict?: string;
}

export interface PromoteResult {
  level: PromotionLevel;
  ok: boolean;
  reason?: string;
  /** Final commit SHA after promotion. */
  commit?: string;
  /** What the required checks said, when they were consulted. */
  checks?: ChecksResult;
}

/** Canonical lifecycle names (src/orchestration/canonicalLifecycle.ts) a queue entry reports. */
export type QueueState = Extract<CanonicalLifecycleState, "MERGE_QUEUED" | "MERGING" | "MERGED">;

/** `none` means no protection is configured; `fail` and `pending` block the merge. */
export type ChecksResult = "pass" | "fail" | "pending" | "none";

/** One candidate bound to the exact commits it was reviewed and validated at. */
export interface QueueEntry {
  branch: string;
  /** Branch the candidate merges into; entries serialize per target. */
  target: string;
  /** Head SHA of `branch` that was reviewed. */
  reviewedHeadSha: string;
  /** Tip SHA of `target` the validation was bound to. */
  boundBaseSha: string;
}

export interface GitPrimitives {
  currentBranch(): Promise<string>;
  branchExists(name: string): Promise<boolean>;
  rebaseOnto(branch: string, onto: string): Promise<RebaseResult>;
  /** Merge `branch` into `target` (the current branch when omitted). */
  mergeBranch(branch: string, target?: string): Promise<{ merged: boolean; conflict: boolean; reason: string | null }>;
  /** The commit at `ref` (HEAD when omitted). */
  headCommit(ref?: string): Promise<string>;
  /** Run an integration gate (e.g. verify) before promoting to main. */
  runIntegrationGate?(branch: string, ctx?: { target: string; baseSha: string }): Promise<boolean>;
  /** SHA a ref currently points at. Required by `enqueue`: a fence needs real SHAs. */
  resolveRef?(ref: string): Promise<string>;
  /** Status of the target's required checks for exactly this SHA. */
  requiredChecks?(sha: string): Promise<ChecksResult>;
  /** Failures present at `baseSha` of `target`, captured fresh for a revalidation. */
  baselineAt?(target: string, baseSha: string): Promise<FailureBaseline>;
  /** Verification of `branch` (rebased onto `baseSha`); judged against {@link baselineAt}. */
  verifyBranch?(branch: string, baseSha: string): Promise<VerifyOutcome>;
}

export interface MergeQueueOptions {
  git: GitPrimitives;
  /** Branch that is the promotion target ("main" / "master"). */
  mainBranch?: string;
  /** Whether to require a passing integration gate before merging to main. */
  requireGate?: boolean;
  /** Number of times to retry a rebase before rejecting. */
  rebaseRetries?: number;
  /** Receives each entry's queue state as it changes. */
  onState?: (entry: QueueEntry, state: QueueState) => void;
  /** Revalidations one entry may need before it is rejected as a moving target. */
  maxRevalidations?: number;
}

export class MergeQueue {
  private readonly git: GitPrimitives;
  private readonly mainBranch: string;
  private readonly requireGate: boolean;
  private readonly rebaseRetries: number;
  private readonly onState: ((entry: QueueEntry, state: QueueState) => void) | undefined;
  private readonly maxRevalidations: number;
  /** One chain per target branch: promotions to one branch never race its index. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: MergeQueueOptions) {
    this.git = opts.git;
    this.mainBranch = opts.mainBranch ?? "main";
    this.requireGate = opts.requireGate ?? true;
    this.rebaseRetries = opts.rebaseRetries ?? 1;
    this.onState = opts.onState;
    this.maxRevalidations = opts.maxRevalidations ?? 3;
  }

  /** Append `task` to the target's chain; the chain survives a failing task. */
  private serialize<T>(target: string, task: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(target) ?? Promise.resolve()).then(task);
    this.chains.set(
      target,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Promote a candidate branch to main through the integration level. Serialized
   * so concurrent promotions queue rather than race.
   */
  promote(candidateBranch: string): Promise<PromoteResult> {
    return this.serialize(this.mainBranch, () => this.promoteUnsafe(candidateBranch));
  }

  /**
   * Queue a SHA-fenced entry. Serialized with every other entry for the same
   * target; entries for other targets run concurrently.
   */
  enqueue(entry: QueueEntry): Promise<PromoteResult> {
    if (!this.git.resolveRef) {
      return Promise.resolve({
        level: "candidate",
        ok: false,
        reason: "git primitives cannot resolve refs; SHA fencing is unavailable",
      });
    }
    this.onState?.(entry, "MERGE_QUEUED");
    return this.serialize(entry.target, () => this.enqueueUnsafe(entry));
  }

  private async enqueueUnsafe(entry: QueueEntry): Promise<PromoteResult> {
    const resolve = this.git.resolveRef!.bind(this.git);
    if (!(await this.git.branchExists(entry.branch))) {
      return { level: "candidate", ok: false, reason: `branch '${entry.branch}' does not exist` };
    }
    let head = entry.reviewedHeadSha;
    let base = entry.boundBaseSha;
    let checks: ChecksResult | undefined;
    for (let round = 0; ; round++) {
      const [currentHead, tip] = [await resolve(entry.branch), await resolve(entry.target)];
      if (currentHead !== head || tip !== base) {
        if (round >= this.maxRevalidations) {
          return {
            level: "integration",
            ok: false,
            reason: `'${entry.branch}' or '${entry.target}' kept moving; gave up after ${this.maxRevalidations} revalidations`,
          };
        }
        const revalidated = await this.revalidate(entry, tip);
        if (revalidated) return revalidated;
        head = await resolve(entry.branch);
        base = tip;
        continue;
      }
      checks = (await this.git.requiredChecks?.(head)) ?? "none";
      if (checks === "fail" || checks === "pending") {
        return {
          level: "integration",
          ok: false,
          reason: `required checks ${checks === "fail" ? "failed" : "pending"} for ${head}`,
          checks,
        };
      }
      // Checks are slow: confirm nothing moved while they were consulted.
      if ((await resolve(entry.branch)) !== head || (await resolve(entry.target)) !== base) continue;
      break;
    }
    this.onState?.(entry, "MERGING");
    const merge = await this.git.mergeBranch(entry.branch, entry.target);
    if (!merge.merged) {
      return {
        level: "main",
        ok: false,
        reason: merge.reason ?? (merge.conflict ? "merge conflict" : "merge failed"),
        checks,
      };
    }
    this.onState?.(entry, "MERGED");
    return { level: "main", ok: true, commit: await this.git.headCommit(entry.target), checks };
  }

  /**
   * The base or the head moved after review: rebase onto the current tip and
   * rerun the gate. With a baseline provider the gate is judged against a
   * baseline captured fresh at the new tip (introduced failures block,
   * pre-existing ones do not); otherwise the boolean integration gate runs.
   * Returns the rejection, or undefined when the entry is revalidated.
   */
  private async revalidate(entry: QueueEntry, tip: string): Promise<PromoteResult | undefined> {
    for (let attempt = 0; attempt <= this.rebaseRetries; attempt++) {
      const rebase = await this.git.rebaseOnto(entry.branch, entry.target);
      if (rebase.ok) break;
      if (attempt === this.rebaseRetries) {
        return {
          level: "integration",
          ok: false,
          reason: `rebase conflict on ${entry.target}: ${rebase.conflict ?? "unknown"}`,
        };
      }
    }
    if (!this.requireGate) return undefined;
    if (this.git.baselineAt && this.git.verifyBranch) {
      const baseline = await this.git.baselineAt(entry.target, tip);
      const outcome = await this.git.verifyBranch(entry.branch, tip);
      const verdict = compareToBaseline(baseline, outcome, tip);
      if (verdict.blocking) {
        return { level: "integration", ok: false, reason: `integration gate failed: ${verdict.reason}` };
      }
    } else if (this.git.runIntegrationGate) {
      if (!(await this.git.runIntegrationGate(entry.branch, { target: entry.target, baseSha: tip }))) {
        return { level: "integration", ok: false, reason: "integration gate failed" };
      }
    }
    return undefined;
  }

  private async promoteUnsafe(branch: string): Promise<PromoteResult> {
    // Level 1: candidate must exist and be rebasable onto main.
    if (!(await this.git.branchExists(branch))) {
      return { level: "candidate", ok: false, reason: `branch '${branch}' does not exist` };
    }
    // Rebase onto the latest main (spec §31.2).
    for (let attempt = 0; attempt <= this.rebaseRetries; attempt++) {
      const rebase = await this.git.rebaseOnto(branch, this.mainBranch);
      if (rebase.ok) break;
      if (attempt === this.rebaseRetries) {
        return { level: "integration", ok: false, reason: `rebase conflict on main: ${rebase.conflict ?? "unknown"}` };
      }
    }
    // Level 2: integration gate (deterministic verification) before merge.
    if (this.requireGate && this.git.runIntegrationGate) {
      const gate = await this.git.runIntegrationGate(branch);
      if (!gate) {
        return { level: "integration", ok: false, reason: "integration gate failed" };
      }
    }
    // Level 3: controlled merge into main (spec §31.3).
    const merge = await this.git.mergeBranch(branch);
    if (!merge.merged) {
      return { level: "main", ok: false, reason: merge.reason ?? (merge.conflict ? "merge conflict" : "merge failed") };
    }
    return { level: "main", ok: true, commit: await this.git.headCommit() };
  }
}
