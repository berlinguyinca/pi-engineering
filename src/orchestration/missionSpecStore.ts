/**
 * Durable SpecStore adapter over MissionStore.
 *
 * Materialization is idempotent: matching approved tasks are reused, missing
 * tasks are created with stable IDs, and a mismatched task under an approved ID
 * stops materialization. Every materialized task carries approval lineage via a
 * durable `spec.materialized` record so replay can reconstruct the approved set.
 */

import { stableTaskId, type MissionSpecRevision, type SpecApproval } from "./specApproval.ts";
import type {
  SpecMaterializeResult,
  SpecReviewEvidence,
  SpecStageAttempt,
  SpecStore,
  SpecWorkflowState,
} from "./specApproval.ts";
import type { MissionStore } from "./missionStore.ts";
import type { OrchestrationTask } from "./types.ts";

export class MissionSpecStore implements SpecStore {
  private readonly store: MissionStore;

  constructor(store: MissionStore) {
    this.store = store;
  }

  getWorkflowState(missionId: string): SpecWorkflowState | null {
    const approval = this.store.getSpecApproval(missionId);
    const revision = this.store.getSpecRevision(missionId);
    const invalidation = this.store.getSpecInvalidation(missionId);
    const stages = this.store.listSpecStages(missionId);
    const latestStage = stages.at(-1) ?? null;
    if (!latestStage && !revision && !approval) return null;
    return {
      missionId,
      phase: approval ? "materialize" : latestStage ? (latestStage.stage as SpecWorkflowState["phase"]) : "idle",
      revisionNumber: revision?.revisionNumber ?? 0,
      semanticSpecHash: revision?.semanticSpecHash ?? null,
      planHash: revision?.planHash ?? null,
      semanticRoundsUsed: 0,
      semanticRoundsLimit: 2,
      activeStage: latestStage,
      overallDeadlineAt: latestStage?.deadlineAt ?? null,
      approval,
      invalidatedApprovalId: invalidation?.approvalId ?? null,
      warning: null,
      nextAction: approval ? "materialize" : latestStage?.stage ?? "idle",
      nextActionAt: latestStage?.deadlineAt ?? null,
      stopReason: null,
      resumeCondition: null,
    };
  }

  getCurrentRevision(missionId: string): MissionSpecRevision | null {
    return this.store.getSpecRevision(missionId);
  }

  getLatestReview(missionId: string): SpecReviewEvidence | null {
    return this.store.getSpecReview(missionId);
  }

  getApproval(missionId: string): SpecApproval | null {
    return this.store.getSpecApproval(missionId);
  }

  async appendStage(stage: SpecStageAttempt): Promise<void> {
    this.store.appendSpecStage(stage);
  }

  async appendRevision(revision: MissionSpecRevision): Promise<void> {
    this.store.appendSpecRevision(revision);
  }

  async appendReview(review: SpecReviewEvidence): Promise<void> {
    this.store.appendSpecReview(review);
  }

  async appendApproval(approval: SpecApproval): Promise<void> {
    this.store.appendSpecApproval(approval);
  }

  async invalidateApproval(missionId: string, approvalId: string, reason: string, fencingToken: number): Promise<void> {
    this.store.invalidateSpecApproval(missionId, approvalId, reason, fencingToken);
  }

  async materializeTasks(
    missionId: string,
    revision: MissionSpecRevision,
    approval: SpecApproval,
  ): Promise<SpecMaterializeResult> {
    const result: SpecMaterializeResult = { created: [], reused: [], mismatched: [], ready: false };
    const existing = new Map(this.store.listTasks(missionId).map((task) => [task.task_id, task]));
    const priorMaterialization = this.store
      .listSpecMaterializations(missionId)
      .find((entry) => entry.approvalId === approval.approvalId);

    let mismatched = false;
    const created: string[] = [];
    const reused: string[] = [];
    for (let index = 0; index < revision.plan.length; index += 1) {
      const planned = revision.plan[index]!;
      const taskId =
        planned.task_id || stableTaskId(missionId, revision.semanticSpecHash, planned.repo_id, index);
      const existingTask = existing.get(taskId);
      if (existingTask) {
        if (priorMaterialization?.created.includes(taskId) || priorMaterialization?.reused.includes(taskId)) {
          reused.push(taskId);
        } else if (existingTask.repo_id === planned.repo_id) {
          reused.push(taskId);
        } else {
          result.mismatched.push(taskId);
          mismatched = true;
        }
        continue;
      }
      this.store.createTask({
        mission_id: missionId,
        task_id: taskId,
        kind: planned.kind as OrchestrationTask["kind"],
        role: planned.role,
        objective: planned.objective,
        depends_on: planned.depends_on,
        mutates_repo: planned.mutates_repo,
        write_domains: planned.write_domains,
        acceptance_ids: planned.acceptance_ids,
        deliverables: planned.deliverables,
        execution_budget_ms: planned.execution_budget_ms,
        isolation: planned.isolation,
        repo_id: planned.repo_id,
      });
      created.push(taskId);
    }

    if (!mismatched) {
      this.store.appendSpecMaterialization(missionId, approval.approvalId, approval.semanticSpecHash, created, reused);
      result.ready = true;
    }
    result.created = created;
    result.reused = reused;
    return result;
  }

  listTasks(missionId: string): Array<{ task_id: string; approval_id: string; semantic_spec_hash: string }> {
    const approval = this.store.getSpecApproval(missionId);
    if (!approval) return [];
    return this.store
      .listTasks(missionId)
      .filter((task) => task.repo_id !== undefined || true)
      .map((task) => ({
        task_id: task.task_id,
        approval_id: approval.approvalId,
        semantic_spec_hash: approval.semanticSpecHash,
      }));
  }
}
