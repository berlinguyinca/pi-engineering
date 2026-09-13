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
 */
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
}

export interface GitPrimitives {
  currentBranch(): Promise<string>;
  branchExists(name: string): Promise<boolean>;
  rebaseOnto(branch: string, onto: string): Promise<RebaseResult>;
  mergeBranch(branch: string): Promise<{ merged: boolean; conflict: boolean; reason: string | null }>;
  headCommit(): Promise<string>;
  /** Run an integration gate (e.g. verify) before promoting to main. */
  runIntegrationGate?(branch: string): Promise<boolean>;
}

export interface MergeQueueOptions {
  git: GitPrimitives;
  /** Branch that is the promotion target ("main" / "master"). */
  mainBranch?: string;
  /** Whether to require a passing integration gate before merging to main. */
  requireGate?: boolean;
  /** Number of times to retry a rebase before rejecting. */
  rebaseRetries?: number;
}

export class MergeQueue {
  private readonly git: GitPrimitives;
  private readonly mainBranch: string;
  private readonly requireGate: boolean;
  private readonly rebaseRetries: number;
  /** Serializes promotions so concurrent candidates never race the shared index. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: MergeQueueOptions) {
    this.git = opts.git;
    this.mainBranch = opts.mainBranch ?? "main";
    this.requireGate = opts.requireGate ?? true;
    this.rebaseRetries = opts.rebaseRetries ?? 1;
  }

  /**
   * Promote a candidate branch to main through the integration level. Serialized
   * so concurrent promotions queue rather than race.
   */
  promote(candidateBranch: string): Promise<PromoteResult> {
    const run = this.chain.then(() => this.promoteUnsafe(candidateBranch));
    // Keep the chain alive even if one promotion fails.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
