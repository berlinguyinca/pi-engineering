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

  constructor(git: GitRepo) {
    this.git = git;
  }

  /**
   * Merge each handoff branch into the base (sequentially, detecting
   * conflicts), run integration checks, and return the merged result.
   */
  async integrate(input: IntegratorInput): Promise<ExecutionOutcome> {
    if (input.signal?.aborted) throw new Error("integration canceled");
    const merged: string[] = [];
    const conflicts: string[] = [];
    for (const h of input.handoffs) {
      const r = await this.git.mergeBranch(h.worktree.branch);
      if (r.merged) {
        merged.push(h.worktree.branch);
      } else {
        conflicts.push(`${h.worktree.branch}: ${r.reason ?? "conflict"}`);
      }
    }
    if (conflicts.length > 0) {
      return {
        executionId: "integration",
        exitStatus: "conflict",
        summary: `integration conflicts: ${conflicts.join("; ")}`,
        artifactRefs: [],
        usage: {},
      };
    }
    let checkSummary = "no checks runner";
    let passed = true;
    if (input.runChecks) {
      const r = await input.runChecks(this.git.root);
      checkSummary = r.summary;
      passed = r.passed;
    }
    return {
      executionId: "integration",
      exitStatus: passed ? "succeeded" : "failed",
      summary: `integrated ${merged.join(", ") || "nothing"}; checks: ${checkSummary}`,
      artifactRefs: [],
      usage: { mergedBranches: merged.length, conflicts: conflicts.length },
    };
  }
}
