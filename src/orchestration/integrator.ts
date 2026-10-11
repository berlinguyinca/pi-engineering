/**
 * Integration runner (spec 05 §integration role, spec 05 worktree lifecycle).
 *
 * Workers implement in isolated worktrees; an explicit integrator gathers
 * worker handoffs, inspects overlapping edits, combines changes, and produces
 * one integrated candidate for review. Reuses `GitRepo` worktree + merge.
 */

import type { GitRepo, WorktreeInfo } from "../git/GitRepo.ts";
import type { ExecutionOutcome } from "./broker.ts";

export interface IntegratorInput {
  objective: string;
  baseCommit: string;
  /** Worktrees that produced changes to integrate. */
  handoffs: Array<{ worktree: WorktreeInfo; summary: string; artifacts: string[] }>;
  /** A runner to execute deterministic integration checks. */
  runChecks?: (cwd: string) => Promise<{ passed: boolean; summary: string }>;
  signal?: AbortSignal;
}

export class Integrator {
  private readonly git: GitRepo;
  private readonly log?: (message: string) => void | Promise<void>;

  constructor(git: GitRepo, opts: { log?: (message: string) => void | Promise<void> } = {}) {
    this.git = git;
    this.log = opts.log;
  }

  /**
   * Merge each handoff branch onto the CURRENT head (spec 4.4 / R7), run
   * integration checks, and push the merged result back with one retry.
   *
   * Stale-base handling: when the checkout has a shared origin and the remote
   * head has advanced past our local base, the origin head is merged in first
   * so handoffs land on the latest target. On push rejection (a concurrent
   * advance between merge and push) the integrator refetches, re-merges, and
   * retries once; a further conflict routes to the existing MERGE_CONFLICT
   * repair path. Repos without an origin keep the legacy single-host behavior
   * (merge locally, no publish).
   */
  async integrate(input: IntegratorInput): Promise<ExecutionOutcome> {
    if (input.signal?.aborted) throw new Error("integration canceled");
    const merged: string[] = [];
    const conflicts: string[] = [];
    const branch = (await this.git.currentBranch()) ?? "master";
    const hasOrigin = await this.git.hasRemoteOrigin();

    // Resolve against current head when a shared origin exists.
    let remoteHead: string | null = null;
    if (hasOrigin) {
      remoteHead = await this.git.remoteBranchHead(branch);
      if (remoteHead && remoteHead !== (await this.git.headCommit())) {
        await this.log?.(`merge-origin-head ${branch}`);
        const r = await this.git.mergeOriginBranch(branch);
        if (!r.merged) {
          conflicts.push(`origin/${branch}: ${r.reason ?? "conflict"}`);
        }
      }
    }

    if (conflicts.length === 0) {
      for (const h of input.handoffs) {
        if (input.signal?.aborted) throw new Error("integration canceled");
        await this.log?.(`merge-handoff ${h.worktree.branch}`);
        const r = await this.git.mergeBranch(h.worktree.branch);
        if (r.merged) {
          merged.push(h.worktree.branch);
        } else {
          conflicts.push(`${h.worktree.branch}: ${r.reason ?? "conflict"}`);
        }
      }
    }

    if (conflicts.length === 0) {
      let checkSummary = "no checks runner";
      let passed = true;
      if (input.runChecks) {
        const r = await input.runChecks(this.git.root);
        checkSummary = r.summary;
        passed = r.passed;
      }
      if (!passed) {
        return {
          executionId: "integration",
          exitStatus: "failed",
          summary: `integrated ${merged.join(", ") || "nothing"}; checks: ${checkSummary}`,
          artifactRefs: [],
          usage: { mergedBranches: merged.length, conflicts: conflicts.length },
        };
      }

      // Publish with one retry when a shared origin exists.
      if (hasOrigin && remoteHead) {
        await this.log?.(`push ${branch}`);
        let pushed = await this.git.pushBranch(branch, remoteHead);
        if (!pushed.ok) {
          await this.log?.(`push-retry ${branch}`);
          await this.log?.(`merge-origin-head ${branch}`);
          const refetched = await this.git.mergeOriginBranch(branch);
          if (refetched.merged) {
            pushed = await this.git.pushBranch(branch, null);
          } else {
            conflicts.push(`origin/${branch}: ${refetched.reason ?? "conflict"}`);
          }
        }
        if (!pushed.ok) {
          conflicts.push(`push rejected: ${pushed.reason ?? "remote advanced"}`);
        }
      }
    }

    if (conflicts.length > 0) {
      return {
        executionId: "integration",
        exitStatus: "conflict",
        summary: `integration conflicts: ${conflicts.join("; ")}`,
        artifactRefs: [],
        usage: { mergedBranches: merged.length, conflicts: conflicts.length },
      };
    }
    return {
      executionId: "integration",
      exitStatus: "succeeded",
      summary: `integrated ${merged.join(", ") || "nothing"}; checks: no checks runner`,
      artifactRefs: [],
      usage: { mergedBranches: merged.length, conflicts: conflicts.length },
    };
  }
}
