/**
 * MissionStore layer: Missions, tasks, executions, gate evidence and late-execution handling.
 * Moved verbatim out of missionStore.ts; composed by inheritance (state lives in
 * MissionStoreBase, `private` members became `protected` so layers can share them).
 */

import { id } from "../core/ids.ts";
import type { StoredEvent } from "../platform/eventstore/backend.ts";
import { LIFECYCLE_SCHEMA_VERSION, toCanonical } from "./canonicalLifecycle.ts";
import { hashCandidateEvidenceIdentity, validateAcceptanceResults } from "./evidence.ts";
import { MissionStoreBase } from "./missionStoreBase.ts";
import {
  candidateKey,
  copyCandidateRevision,
  copyEvidenceInvalidation,
  copyExecution,
  copyMission,
  copyReviewEvidence,
  copyTask,
  copyValidationEvidence,
  validateMissionTransitionOptions,
  validateMissionUpdatePatch,
  validateTaskTransitionMetadata,
} from "./missionStoreCopy.ts";
import {
  type GateEvidencePublication,
  LEGACY_AUTHORITY_LOSS,
  type LateExecutionEvidence,
  type MissionCompletionOptions,
  type MissionCreateInput,
  type MissionTransitionOptions,
  type MissionUpdatePatch,
  type OrchestrationEvent,
  type RepositoryWait,
  TERMINAL_TASK_STATUSES,
  type TaskCreateInput,
} from "./missionStoreTypes.ts";
import { assertMissionTransition, assertTaskTransition } from "./state.ts";
import type {
  CandidateRevision,
  EvidenceInvalidation,
  Execution,
  ExecutionStatus,
  Mission,
  MissionLease,
  MissionStatus,
  OrchestrationTask,
  RecoveryDecision,
  ReviewEvidence,
  TaskStatus,
  TaskTransitionMetadata,
  ValidationEvidence,
} from "./types.ts";

export abstract class MissionStoreEntities extends MissionStoreBase {
  // ── Missions ────────────────────────────────────────────────────────────

  createMission(input: MissionCreateInput): Mission {
    const now = new Date().toISOString();
    const mission: Mission = {
      mission_id: input.mission_id ?? id("MSN"),
      revision: 0,
      title: input.title,
      goal: input.goal,
      user_request: input.user_request,
      repository: input.repository,
      base_ref: input.base_ref,
      constraints: input.constraints ?? [],
      acceptance_criteria: [],
      risk_profile: input.risk_profile,
      workflow_class: input.workflow_class,
      status: "NEW",
      created_at: now,
      updated_at: now,
      parent_session_id: input.parent_session_id ?? null,
      task_ids: [],
      artifact_refs: [],
      decision_refs: [],
      required_gates: [],
      failure_reason: null,
      completed_at: null,
    };
    this.missions.set(mission.mission_id, mission);
    this.emit("mission.created", mission.mission_id, {
      actor: "system",
      mission,
    });
    return copyMission(mission);
  }

  getMission(missionId: string): Mission | undefined {
    const m = this.missions.get(missionId);
    return m ? copyMission(m) : undefined;
  }

  listMissions(projectFilter?: (m: Mission) => boolean): Mission[] {
    const all = [...this.missions.values()];
    return (projectFilter ? all.filter(projectFilter) : all).map(copyMission);
  }

  transitionMission(
    missionId: string,
    to: MissionStatus,
    actorOrOptions: string | MissionTransitionOptions = "system",
    explicitOptions: MissionTransitionOptions = {},
  ): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const actor = typeof actorOrOptions === "string" ? actorOrOptions : "system";
    const options = validateMissionTransitionOptions(
      typeof actorOrOptions === "string" ? explicitOptions : actorOrOptions,
    );
    const repairRecoveryId = options.recoveryDecisionId;
    // Re-entering the current state is an idempotent no-op. Throwing here
    // ("illegal mission transition BLOCKED -> BLOCKED") turned an already
    // recorded outcome into an exception that lost the mission id for the
    // caller; writing it would open a spurious new blocked episode. Options
    // were validated above; a self-transition carrying a recovery decision
    // still goes through the full transition checks below. Like every other
    // read, the no-op hands out a copy, never the internal record.
    if (m.status === to && !repairRecoveryId) return copyMission(m);
    let repairDecision: RecoveryDecision | undefined;
    if (m.status === "BLOCKED" && to === "REPAIRING") {
      repairDecision = repairRecoveryId ? this.recoveryDecisions.get(repairRecoveryId) : undefined;
      if (!repairDecision) {
        throw new Error("BLOCKED -> REPAIRING requires a durable repair recovery decision ID");
      }
      // A probe normally only waits, but re-running a gate that died on a
      // provider failure is active work on the existing candidate.
      const probedTaskId = this.getFailureClassification(repairDecision.classificationId)?.taskId;
      const probesGate = ["validation", "review", "integration"].includes(this.getTask(probedTaskId ?? "")?.kind ?? "");
      if (
        repairDecision.missionId !== missionId ||
        ["STOP", "WAIT_FOR_REQUIREMENT", "PAUSE_FOR_PERSISTENCE"].includes(repairDecision.action) ||
        (repairDecision.action === "PROBE_AND_BACKOFF" && !probesGate)
      ) {
        throw new Error(`recovery ${repairRecoveryId} cannot enter active repair for mission ${missionId}`);
      }
      if (repairDecision.status !== "planned") {
        throw new Error(`repair recovery ${repairRecoveryId} must be planned, not ${repairDecision.status}`);
      }
      if (!m.blocked_episode_id || repairDecision.blockedEpisodeId !== m.blocked_episode_id) {
        throw new Error(`repair recovery ${repairRecoveryId} does not belong to the current blocked episode`);
      }
    }
    assertMissionTransition(m.status, to);
    const now = new Date().toISOString();
    const patch: Partial<Mission> = {
      status: to,
      updated_at: now,
      ...(to === "BLOCKED" ? { blocked_at: now, blocked_episode_id: id("BLK") } : {}),
    };
    // The canonical image rides on the transition event beside the actor and
    // timestamp; the persisted MissionStatus is unchanged.
    const lifecycle = { canonicalState: toCanonical(to), lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION };
    this.missions.set(missionId, { ...m, ...patch });
    this.canonicalRecords.set(missionId, { status: to, ...lifecycle });
    if (repairDecision) {
      const started: RecoveryDecision = {
        ...repairDecision,
        status: "started",
      };
      this.recoveryDecisions.set(started.recoveryId, started);
      this.emit(
        "recovery.started",
        missionId,
        {
          actor,
          decision: started,
          mission_id: missionId,
          mission_patch: patch,
          ...lifecycle,
        },
        now,
      );
    } else {
      this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch, ...lifecycle }, now);
    }
    if (to === "BLOCKED" && this.missions.get(missionId)?.blocked_episode_id) {
      const blockerEpisodeId = this.missions.get(missionId)!.blocked_episode_id!;
      for (const classification of [...this.failureClassifications.values()].filter(
        (entry) => entry.missionId === missionId && !entry.blockerEpisodeId,
      )) {
        const associated = { ...classification, blockerEpisodeId };
        this.failureClassifications.set(associated.classificationId, associated);
        this.emit("failure.classified", missionId, { actor: "system", classification: associated }, now);
      }
    }
    return this.getMission(missionId)!;
  }

  updateMission(missionId: string, patch: MissionUpdatePatch, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    if (Object.hasOwn(patch, "status")) {
      throw new Error("mission status must be changed through transitionMission");
    }
    const safePatch = validateMissionUpdatePatch(patch);
    const now = new Date().toISOString();
    const next = { ...m, ...safePatch, updated_at: now };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, { actor, mission_id: missionId, patch: safePatch }, now);
    return this.getMission(missionId)!;
  }

  /**
   * Record an operator interrupt (pause) on the mission, synchronously and
   * durably. Idempotent; a terminal mission is left alone.
   */
  markOperatorPause(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission || mission.operator_paused_at || ["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) return;
    this.updateMission(missionId, { operator_paused_at: new Date().toISOString() }, "operator");
  }

  /** The operator resumed the mission: automatic recovery may act on it again. */
  clearOperatorPause(missionId: string): void {
    if (!this.missions.get(missionId)?.operator_paused_at) return;
    this.updateMission(missionId, { operator_paused_at: null }, "operator");
  }

  completeMission(missionId: string, options: MissionCompletionOptions, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const currentResumptionGeneration = this.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    if (options.expectedResumptionGeneration !== currentResumptionGeneration) {
      throw new Error(
        `stale mission resumption at completion: expected ${options.expectedResumptionGeneration}, current ${currentResumptionGeneration}`,
      );
    }
    assertMissionTransition(m.status, "COMPLETE");
    this.missions.set(missionId, {
      ...m,
      status: "COMPLETE",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.emit("mission.completed", missionId, { actor, mission_id: missionId });
    return this.getMission(missionId)!;
  }

  failMission(missionId: string, reason: string, actor = "system"): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    this.missions.set(missionId, {
      ...m,
      status: "FAILED",
      failure_reason: reason,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.emit("mission.failed", missionId, {
      actor,
      mission_id: missionId,
      failure_reason: reason,
    });
    return this.getMission(missionId)!;
  }

  addAcceptanceCriterion(missionId: string, criterion: string, evidence?: string, acceptanceId?: string): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const criterionId = acceptanceId ?? id("AC");
    if (m.acceptance_criteria.some((entry) => entry.acceptance_id === criterionId)) {
      throw new Error(`duplicate acceptance criterion ID ${criterionId}`);
    }
    const criteria = [
      ...m.acceptance_criteria,
      {
        acceptance_id: criterionId,
        criterion,
        status: "pending" as const,
        ...(evidence ? { evidence } : {}),
      },
    ];
    const next = {
      ...m,
      acceptance_criteria: criteria,
      updated_at: new Date().toISOString(),
    };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, {
      actor: "system",
      mission_id: missionId,
      patch: { acceptance_criteria: criteria },
    });
    return this.getMission(missionId)!;
  }

  setCriterionStatus(missionId: string, index: number, status: "passed" | "failed", evidence?: string): Mission {
    const m = this.missions.get(missionId);
    if (!m) throw new Error(`unknown mission ${missionId}`);
    const criteria = m.acceptance_criteria.map((c, i) =>
      i === index ? { ...c, status, ...(evidence ? { evidence } : {}) } : c,
    );
    const next = {
      ...m,
      acceptance_criteria: criteria,
      updated_at: new Date().toISOString(),
    };
    this.missions.set(missionId, next);
    this.emit("mission.updated", missionId, {
      actor: "system",
      mission_id: missionId,
      patch: { acceptance_criteria: criteria },
    });
    return this.getMission(missionId)!;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  createTask(input: TaskCreateInput): OrchestrationTask {
    const now = new Date().toISOString();
    const authority = this.missionLeases.get(input.mission_id);
    const task: OrchestrationTask = {
      task_id: input.task_id ?? id("TSK"),
      mission_id: input.mission_id,
      kind: input.kind,
      role: input.role,
      objective: input.objective,
      depends_on: input.depends_on ?? [],
      status: "PENDING",
      priority: input.priority ?? 0,
      mutates_repo: input.mutates_repo ?? false,
      write_domains: input.write_domains ?? [],
      isolation: input.isolation ?? (input.mutates_repo ? "worktree" : "none"),
      execution_requirements: input.execution_requirements ?? {},
      assigned_execution_id: null,
      artifacts: [],
      attempt: 0,
      max_attempts: input.max_attempts ?? 3,
      failure_policy: input.failure_policy ?? "retry",
      created_at: now,
      started_at: null,
      completed_at: null,
      steer_requests: [],
      repo_id: input.repo_id,
      acceptance_ids: input.acceptance_ids ? [...input.acceptance_ids] : [],
      deliverables: input.deliverables ? [...input.deliverables] : [],
      execution_budget_ms: input.execution_budget_ms,
      checkpoint_policy: input.checkpoint_policy ? { ...input.checkpoint_policy } : undefined,
      required_output_artifacts: input.required_output_artifacts ? [...input.required_output_artifacts] : [],
      candidate_generation: input.candidate_generation ?? 0,
      mission_generation: input.mission_generation ?? authority?.generation ?? 0,
      resumption_generation:
        input.resumption_generation ??
        authority?.resumptionGeneration ??
        this.listMissionResumptions(input.mission_id).at(-1)?.generation ??
        0,
      fencing_token: input.fencing_token ?? authority?.fencingToken ?? 0,
      recovery_authority: input.recovery_authority ? { ...input.recovery_authority } : undefined,
      repair_base_candidate_sha: input.repair_base_candidate_sha,
      replacement_spec_fingerprint: input.replacement_spec_fingerprint,
    };
    this.tasks.set(task.task_id, task);
    const mission = this.missions.get(input.mission_id);
    if (mission) {
      this.missions.set(mission.mission_id, {
        ...mission,
        task_ids: [...mission.task_ids, task.task_id],
        updated_at: now,
      });
    }
    this.emit("task.created", input.mission_id, { actor: "system", task });
    return copyTask(task);
  }

  getTask(taskId: string): OrchestrationTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? copyTask(t) : undefined;
  }

  assignTaskAuthority(taskId: string, lease: MissionLease): OrchestrationTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.mission_id !== lease.missionId) throw new Error(`lease mission does not match task ${taskId}`);
    task.mission_generation = lease.generation;
    task.resumption_generation = lease.resumptionGeneration ?? 0;
    task.fencing_token = lease.fencingToken;
    this.emit("task.authority_assigned", task.mission_id, {
      actor: "system",
      task_id: taskId,
      mission_generation: lease.generation,
      resumption_generation: lease.resumptionGeneration ?? 0,
      fencing_token: lease.fencingToken,
    });
    return copyTask(task);
  }

  assignTaskExecution(taskId: string, executionId: string): OrchestrationTask {
    const task = this.tasks.get(taskId);
    const execution = this.executions.get(executionId);
    if (!task || !execution || execution.task_id !== taskId || execution.mission_id !== task.mission_id)
      throw new Error(`execution ${executionId} does not belong to task ${taskId}`);
    if (task.assigned_execution_id && task.assigned_execution_id !== executionId) {
      const assigned = this.executions.get(task.assigned_execution_id);
      if (assigned && !["SUCCEEDED", "FAILED", "CANCELED"].includes(assigned.status))
        throw new Error(`task ${taskId} already has an active assigned execution`);
    }
    task.assigned_execution_id = executionId;
    this.emit("task.authority_assigned", task.mission_id, {
      actor: "system",
      task_id: taskId,
      mission_generation: task.mission_generation,
      resumption_generation: task.resumption_generation,
      fencing_token: task.fencing_token,
      assigned_execution_id: executionId,
    });
    return copyTask(task);
  }

  listTasks(missionId?: string): OrchestrationTask[] {
    return [...this.tasks.values()].filter((t) => (missionId ? t.mission_id === missionId : true)).map(copyTask);
  }

  transitionTask(
    taskId: string,
    to: TaskStatus,
    actor = "system",
    metadata: TaskTransitionMetadata = {},
  ): OrchestrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (Object.hasOwn(metadata, "status")) {
      throw new Error("task status must be changed through transitionTask");
    }
    const extra = validateTaskTransitionMetadata(metadata);
    assertTaskTransition(t.status, to);
    const type =
      to === "READY"
        ? "task.ready"
        : to === "RUNNING"
          ? "task.started"
          : to === "SUCCEEDED"
            ? "task.completed"
            : to === "FAILED"
              ? "task.failed"
              : to === "RETRYING"
                ? "task.retried"
                : "task.canceled";
    const event = this.emit(type, t.mission_id, {
      actor,
      task_id: taskId,
      status: to,
      ...extra,
    });
    const now = event.timestamp;
    const next: OrchestrationTask = {
      ...t,
      status: to,
      ...(to === "RUNNING" ? { started_at: now } : {}),
      ...(to === "SUCCEEDED" || to === "FAILED" || to === "CANCELED" ? { completed_at: now } : {}),
      ...extra,
    };
    this.tasks.set(taskId, next);
    return this.getTask(taskId)!;
  }

  steerTask(taskId: string, request: string, actor = "system"): OrchestrationTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (TERMINAL_TASK_STATUSES.has(t.status)) {
      throw new Error(`terminal task ${taskId} is immutable`);
    }
    const next = { ...t, steer_requests: [...t.steer_requests, request] };
    this.tasks.set(taskId, next);
    this.emit("task.steered", t.mission_id, {
      actor,
      task_id: taskId,
      request,
    });
    return this.getTask(taskId)!;
  }

  // ── Executions ──────────────────────────────────────────────────────────

  createExecution(input: {
    task_id: string;
    backend: Execution["backend"];
    mission_id: string;
    session_id?: string | null;
    pid?: number | null;
    worktree?: string | null;
    model?: string | null;
    thinking_level?: string | null;
    mission_generation?: number;
    resumption_generation?: number;
    fencing_token?: number;
    checkpoint_id?: string;
    repo_id?: string;
    base_sha?: string;
    candidate_generation?: number;
  }): Execution {
    const task = this.tasks.get(input.task_id);
    const ex: Execution = {
      execution_id: id("EXC"),
      task_id: input.task_id,
      mission_id: input.mission_id,
      backend: input.backend,
      session_id: input.session_id ?? null,
      pid: input.pid ?? null,
      worktree: input.worktree ?? null,
      model: input.model ?? null,
      thinking_level: input.thinking_level ?? null,
      started_at: null,
      ended_at: null,
      exit_status: null,
      usage: {},
      logs: [],
      artifact_refs: [],
      status: "PENDING",
      mission_generation: input.mission_generation ?? task?.mission_generation ?? 0,
      resumption_generation: input.resumption_generation ?? task?.resumption_generation ?? 0,
      fencing_token: input.fencing_token ?? task?.fencing_token ?? 0,
      checkpoint_id: input.checkpoint_id,
      repo_id: input.repo_id,
      base_sha: input.base_sha,
      candidate_generation: input.candidate_generation ?? task?.candidate_generation ?? 0,
    };
    this.executions.set(ex.execution_id, ex);
    this.emit("execution.created", input.mission_id, {
      actor: "system",
      execution: ex,
    });
    // No parent attempt is recorded on an execution, so no spawn edge (nothing is guessed).
    if (this.lineageAgentExecution(ex)) {
      this.lineageDo((l) => {
        // The logical agent is the task; its label (the task's role) and running state are set once.
        // A later attempt only revives it if it had ended.
        const known = this.lineageAgents.get(ex.task_id);
        l.workerSpawned({
          agent: ex.task_id,
          attempt: ex.execution_id,
          session: ex.session_id,
          missionId: ex.mission_id,
          taskId: ex.task_id,
          role: task?.role ?? null,
          model: ex.model,
          upsertAgent: known === undefined,
          transition: `created:${ex.execution_id}`,
        });
        if (known === "ended") {
          l.agentState(
            { agent: ex.task_id, missionId: ex.mission_id, taskId: ex.task_id },
            "running",
            `resume:${ex.execution_id}`,
          );
        }
        this.lineageAgents.set(ex.task_id, "live");
      });
    }
    return copyExecution(ex);
  }

  setExecutionStatus(executionId: string, status: ExecutionStatus, extra: Partial<Execution> = {}): Execution {
    const ex = this.executions.get(executionId);
    if (!ex) throw new Error(`unknown execution ${executionId}`);
    const now = new Date().toISOString();
    const next: Execution = {
      ...ex,
      ...extra,
      status,
      ...(status === "RUNNING" ? { started_at: now } : {}),
      ...(status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED" ? { ended_at: now } : {}),
    };
    this.executions.set(executionId, next);
    if (status === "RUNNING") this.recordAuthoritativeExecutionStart(next);
    const type =
      status === "RUNNING"
        ? "execution.started"
        : status === "SUCCEEDED"
          ? "execution.completed"
          : status === "FAILED"
            ? "execution.failed"
            : "execution.canceled";
    this.emit(type, ex.mission_id, { actor: "system", execution: next });
    if (this.lineageAgentExecution(next)) {
      this.lineageSessionChange(next, ex.session_id, next.session_id, now);
      this.acknowledgeObservedHandoffs(next, ex.session_id, next.session_id);
      if (status === "RUNNING") {
        this.lineageDo((l) =>
          l.attemptState(
            { attempt: next.execution_id, agent: next.task_id, missionId: next.mission_id, taskId: next.task_id },
            "running",
            "start",
            undefined,
            now,
          ),
        );
      } else if (status === "SUCCEEDED") this.lineageAttemptEnded(next, "done");
      else if (status === "FAILED") this.lineageAttemptEnded(next, "failed");
      else if (status === "CANCELED") this.lineageAttemptEnded(next, "cancelled");
    }
    return this.getExecution(executionId)!;
  }

  /** Atomically settle one current execution and publish its candidate-bound gate evidence. */
  publishGateEvidenceIfAuthoritative(input: GateEvidencePublication): Promise<Execution> {
    const publish = this.emitChain.then(async () => {
      await this.drainPending();
      this.assertExecutionAuthoritative(input.executionId);
      const current = this.executions.get(input.executionId)!;
      const task = this.tasks.get(current.task_id)!;
      const now = new Date().toISOString();
      const identity = this.assertCandidateIdentity(
        current.mission_id,
        input.identity,
        hashCandidateEvidenceIdentity(input.identity),
      );
      const identityHash = hashCandidateEvidenceIdentity(identity);
      const execution: Execution = {
        ...current,
        status: "SUCCEEDED",
        ended_at: now,
        exit_status: input.exitStatus,
        artifact_refs: [...input.artifactRefs],
        usage: structuredClone(input.usage),
        // P4 provenance: settle the record to the model that actually served
        // (the requested model seeded at creation is the fallback when absent).
        ...(input.model ? { model: input.model } : {}),
        ...(input.recoveredMerged?.length ? { recovered_merged: [...input.recoveredMerged] } : {}),
        ...(input.reviewedRecovered?.length ? { reviewed_recovered: [...input.reviewedRecovered] } : {}),
      };
      // A gate publication over the SAME content keeps a reconstruction origin
      // (#360): the marker records where the candidate content came from, and
      // re-affirming evidence does not change that origin. The marker rides on
      // the publication payload, so replay reproduces the same state.
      const originPrior = this.candidates.get(candidateKey(current.mission_id, identity.repoId));
      const carriedOrigin =
        originPrior && originPrior.identityHash === identityHash ? originPrior.reconstructedFrom : undefined;
      const candidate: CandidateRevision = {
        missionId: current.mission_id,
        taskId: task.task_id,
        executionId: current.execution_id,
        identity,
        identityHash,
        reason: input.reason.trim() || "candidate changed",
        recordedAt: now,
        ...(carriedOrigin ? { reconstructedFrom: carriedOrigin } : {}),
      };
      const evidenceRecordedAt = this.freshEvidenceTimestamp({
        missionId: current.mission_id,
        identityHash,
        recordedAt: now,
      });
      const validationEvidence = input.validationEvidence
        ? copyValidationEvidence({
            ...input.validationEvidence,
            identity,
            identityHash,
            recordedAt: evidenceRecordedAt,
          })
        : undefined;
      const reviewEvidence = input.reviewEvidence
        ? copyReviewEvidence({
            ...input.reviewEvidence,
            identity,
            identityHash,
            recordedAt: evidenceRecordedAt,
          })
        : undefined;
      const prior = this.candidates.get(candidateKey(current.mission_id, identity.repoId));
      const invalidation =
        prior && prior.identityHash !== identityHash
          ? {
              invalidationId: id("EI"),
              missionId: current.mission_id,
              identity: prior.identity,
              reason: input.reason.trim() || "candidate changed",
              invalidatedAt: now,
              scope: "all" as const,
            }
          : undefined;
      const payload = structuredClone({
        actor: "system",
        execution,
        candidate,
        ...(validationEvidence ? { validationEvidence } : {}),
        ...(reviewEvidence ? { reviewEvidence } : {}),
        ...(invalidation ? { invalidation } : {}),
      });
      this.assertGateEvidencePublication(payload);
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: current.mission_id,
        timestamp: now,
        type: "execution.gate_evidence_published",
        actor: "system",
        payload,
      };
      let authorityError: unknown;
      let appended: StoredEvent | undefined;
      try {
        appended = await this.backend.appendConditionally(
          {
            event_id: event.event_id,
            timestamp: event.timestamp,
            type: event.type,
            project_id: null,
            run_id: event.mission_id,
            worker_id: null,
            payload,
          },
          () => {
            try {
              this.assertExecutionAuthoritative(input.executionId);
              return true;
            } catch (error) {
              authorityError = error;
              return false;
            }
          },
          () => this.apply(event),
        );
      } catch (error) {
        if (!authorityError) this.recordPersistenceFailure(event, error);
        throw error;
      }
      if (!appended) throw authorityError ?? new Error("gate evidence authority changed before publication");
      this.clearPersistenceFailure(event.event_id);
      this.lineageAttemptEnded(execution, "done");
      return this.getExecution(input.executionId)!;
    });
    this.emitChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
  }

  protected assertGateEvidencePublication(payload: Record<string, unknown>): void {
    const execution = payload.execution as Execution;
    const candidate = payload.candidate as CandidateRevision;
    const validationEvidence = payload.validationEvidence as ValidationEvidence | undefined;
    const reviewEvidence = payload.reviewEvidence as ReviewEvidence | undefined;
    const current = this.executions.get(execution.execution_id);
    const task = current ? this.tasks.get(current.task_id) : undefined;
    if (!current || !task || current.status !== "RUNNING") {
      throw new Error("gate evidence execution is not currently authoritative");
    }
    this.assertExecutionAuthoritative(current.execution_id);
    const immutableMismatches = [
      current.task_id !== execution.task_id ? "task" : null,
      current.mission_id !== execution.mission_id ? "mission" : null,
      current.backend !== execution.backend ? "backend" : null,
      current.mission_generation !== execution.mission_generation ? "mission generation" : null,
      current.resumption_generation !== execution.resumption_generation ? "resumption generation" : null,
      current.candidate_generation !== execution.candidate_generation ? "candidate generation" : null,
      current.fencing_token !== execution.fencing_token ? "fencing token" : null,
    ].filter((value): value is string => value !== null);
    if (immutableMismatches.length > 0) {
      throw new Error(`gate evidence execution identity mismatch: ${immutableMismatches.join(", ")}`);
    }
    const identity = this.assertCandidateIdentity(candidate.missionId, candidate.identity, candidate.identityHash);
    this.assertSettledExecutionIdentity(task, execution, identity);
    if (
      candidate.missionId !== execution.mission_id ||
      candidate.taskId !== task.task_id ||
      candidate.executionId !== execution.execution_id ||
      task.repo_id !== identity.repoId ||
      execution.repo_id !== identity.repoId ||
      execution.base_sha !== identity.baseSha
    ) {
      throw new Error("gate evidence candidate provenance mismatch");
    }
    this.assertUnusedCandidateExecution(execution.execution_id);
    if (validationEvidence) {
      if (execution.backend !== "validation") throw new Error("validation evidence backend mismatch");
      this.assertGateEvidenceRecord(validationEvidence, candidate, execution, task);
      if (
        !validationEvidence.command.trim() ||
        !validationEvidence.profile.trim() ||
        !Number.isInteger(validationEvidence.exitCode)
      )
        throw new Error("malformed validation evidence");
      validateAcceptanceResults(validationEvidence.acceptanceResults, identity.acceptanceIds);
      this.assertUnusedEvidenceExecution(execution.execution_id, this.validationEvidence.values());
    }
    if (reviewEvidence) {
      if (execution.backend !== "review") throw new Error("review evidence backend mismatch");
      this.assertGateEvidenceRecord(reviewEvidence, candidate, execution, task);
      if (!reviewEvidence.reviewerSessionId.trim() || !reviewEvidence.model.trim() || !reviewEvidence.provider.trim())
        throw new Error("malformed review evidence identity");
      if (
        !Array.isArray(reviewEvidence.findings) ||
        reviewEvidence.findings.some((finding) => !finding.summary?.trim())
      )
        throw new Error("malformed review findings");
      validateAcceptanceResults(reviewEvidence.acceptanceResults, identity.acceptanceIds);
      this.assertUnusedEvidenceExecution(execution.execution_id, this.reviewEvidence.values());
    }
  }

  protected assertGateEvidenceRecord(
    evidence: ValidationEvidence | ReviewEvidence,
    candidate: CandidateRevision,
    execution: Execution,
    task: OrchestrationTask,
  ): void {
    if (
      evidence.missionId !== candidate.missionId ||
      evidence.taskId !== task.task_id ||
      evidence.executionId !== execution.execution_id ||
      evidence.identityHash !== candidate.identityHash ||
      hashCandidateEvidenceIdentity(evidence.identity) !== candidate.identityHash
    ) {
      throw new Error("gate evidence provenance mismatch");
    }
  }

  protected applyGateEvidencePublication(payload: Record<string, unknown>): void {
    try {
      this.assertGateEvidencePublication(payload);
      const execution = payload.execution as Execution;
      const candidate = payload.candidate as CandidateRevision;
      const invalidation = payload.invalidation as EvidenceInvalidation | undefined;
      const validationEvidence = payload.validationEvidence as ValidationEvidence | undefined;
      const reviewEvidence = payload.reviewEvidence as ReviewEvidence | undefined;
      this.executions.set(execution.execution_id, copyExecution(execution));
      if (invalidation)
        this.evidenceInvalidations.set(invalidation.invalidationId, copyEvidenceInvalidation(invalidation));
      this.candidates.set(
        candidateKey(candidate.missionId, candidate.identity.repoId),
        copyCandidateRevision(candidate),
      );
      this.candidateExecutionIds.add(candidate.executionId);
      if (validationEvidence)
        this.validationEvidence.set(validationEvidence.evidenceId, copyValidationEvidence(validationEvidence));
      if (reviewEvidence) this.reviewEvidence.set(reviewEvidence.evidenceId, copyReviewEvidence(reviewEvidence));
    } catch (error) {
      const execution = payload.execution as Execution | undefined;
      this.quarantineEvidence(execution?.mission_id ?? "unknown", error);
    }
  }

  getExecution(executionId: string): Execution | undefined {
    const ex = this.executions.get(executionId);
    return ex ? copyExecution(ex) : undefined;
  }

  listExecutions(missionId?: string, taskId?: string): Execution[] {
    return [...this.executions.values()]
      .filter((e) => (missionId ? e.mission_id === missionId : true))
      .filter((e) => (taskId ? e.task_id === taskId : true))
      .map(copyExecution);
  }

  executionAuthoritativeStartOrder(executionId: string): number | undefined {
    return this.authoritativeExecutionStartOrder.get(executionId);
  }

  protected recordAuthoritativeExecutionStart(execution: Execution): void {
    if (this.authoritativeExecutionStartOrder.has(execution.execution_id)) return;
    const task = this.tasks.get(execution.task_id);
    if (
      !task ||
      task.mission_id !== execution.mission_id ||
      task.assigned_execution_id !== execution.execution_id ||
      task.mission_generation !== execution.mission_generation ||
      task.resumption_generation !== execution.resumption_generation ||
      task.candidate_generation !== execution.candidate_generation ||
      task.fencing_token !== execution.fencing_token
    )
      return;
    this.authoritativeExecutionStartOrder.set(execution.execution_id, ++this.executionStartSequence);
  }

  /**
   * Assert that an execution still owns its result/mutation epoch.
   *
   * Execution status is the broker-local revocation fence: once timeout or
   * cancellation settles it, continuations from the backend may be observed
   * as evidence but can no longer publish artifacts, findings, checkpoints,
   * candidate state, or handoffs. Generation fields additionally prevent an
   * older execution from writing through a reassigned task.
   */
  assertExecutionAuthoritative(executionId: string): Execution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`unknown execution ${executionId}`);
    if (execution.status !== "RUNNING") {
      throw new Error(`execution ${executionId} is no longer authoritative (${execution.status})`);
    }
    const task = this.tasks.get(execution.task_id);
    if (!task) throw new Error(`unknown task ${execution.task_id}`);
    const mismatches = [
      task.mission_generation !== execution.mission_generation ? "mission generation" : null,
      task.resumption_generation !== execution.resumption_generation ? "resumption generation" : null,
      execution.resumption_generation !== (this.listMissionResumptions(execution.mission_id).at(-1)?.generation ?? 0)
        ? "current resumption generation"
        : null,
      task.candidate_generation !== execution.candidate_generation ? "candidate generation" : null,
      task.fencing_token !== execution.fencing_token ? "fencing token" : null,
      task.assigned_execution_id && task.assigned_execution_id !== executionId ? "assigned execution" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) {
      throw new Error(`stale execution identity for ${executionId}: ${mismatches.join(", ")}`);
    }
    return copyExecution(execution);
  }

  rejectLateExecution(executionId: string, reason: string, evidence?: Record<string, unknown>): Execution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`unknown execution ${executionId}`);
    // A late observation is append-only evidence. Never rewrite an already
    // terminal timeout/cancellation outcome with whatever the stale backend
    // happened to return later.
    const rejected: Execution =
      execution.status === "RUNNING"
        ? {
            ...execution,
            status: "CANCELED",
            exit_status: `late_result_rejected:${reason}`,
            ended_at: new Date().toISOString(),
          }
        : execution;
    if (execution.status === "RUNNING") this.executions.set(executionId, rejected);
    if (LEGACY_AUTHORITY_LOSS.test(reason)) this.executionRejectionReasons.set(executionId, reason);
    this.emit("execution.late_result_rejected", execution.mission_id, {
      actor: "system",
      execution: rejected,
      reason,
      ...(evidence ? { evidence } : {}),
    });
    return copyExecution(rejected);
  }

  /**
   * Fence executions that survived their controller episode before recovery
   * can dispatch replacement work. The orphan marker is durable first; replay
   * then observes either the still-live orphan or its terminal reconciliation.
   */
  reconcileOrphanedExecutions(missionId: string): Execution[] {
    const reconciled: Execution[] = [];
    for (const execution of this.listExecutions(missionId).filter((entry) => entry.status === "RUNNING")) {
      this.emit("execution.orphaned", missionId, {
        actor: "system",
        execution,
        reason: "blocked mission recovery fenced prior controller execution",
      });
      const terminal: Execution = {
        ...execution,
        status: "CANCELED",
        exit_status: "orphaned_execution_reconciled",
        ended_at: new Date().toISOString(),
      };
      this.executions.set(execution.execution_id, terminal);
      this.emit("execution.reconciled", missionId, {
        actor: "system",
        execution: terminal,
        reason: "prior execution fenced before replacement dispatch",
      });
      this.lineageAttemptEnded(terminal, "cancelled", "orphaned execution reconciled");
      const task = this.tasks.get(execution.task_id);
      if (task?.status === "RUNNING" && task.assigned_execution_id === execution.execution_id) {
        this.transitionTask(task.task_id, "RETRYING", "system", {
          failure_reason: "orphaned execution fenced during mission recovery",
        });
        this.transitionTask(task.task_id, "READY");
      }
      reconciled.push(copyExecution(terminal));
    }
    return reconciled;
  }

  /**
   * Re-queue tasks left in RETRYING back to READY so mission recovery re-runs
   * the SAME task instead of advancing the phase. This is the companion to a
   * resumable controller-disconnect cancel, which leaves the task RETRYING (not
   * terminally CANCELED). Idempotent: tasks not in RETRYING are untouched, and a
   * terminally CANCELED task is never resurrected.
   * @returns the number of tasks re-queued.
   */
  requeueResumableTasks(missionId: string): number {
    let requeued = 0;
    for (const task of this.listTasks(missionId)) {
      if (task.status === "RETRYING") {
        this.transitionTask(task.task_id, "READY", "system", {
          failure_reason: "resumable task re-queued after controller-disconnect recovery",
        });
        requeued += 1;
      }
    }
    return requeued;
  }

  /** Legacy canceled implementations need positive, execution-bound ownership-loss evidence. */
  legacyCanceledRecovery(missionId: string): { recoverableTaskIds: string[]; ambiguousTaskIds: string[] } {
    const mission = this.getMission(missionId);
    const result = { recoverableTaskIds: [] as string[], ambiguousTaskIds: [] as string[] };
    if (
      !mission ||
      mission.operator_paused_at ||
      ["COMPLETE", "FAILED", "CANCELED", "CANCELING", "WAITING_FOR_USER"].includes(mission.status)
    )
      return result;
    const generation = this.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    if (
      this.listRecoveryDecisions(missionId).some(
        (decision) =>
          decision.action === "WAIT_FOR_REQUIREMENT" &&
          (decision.resumptionGeneration ?? 0) === generation &&
          ["planned", "started"].includes(decision.status),
      )
    )
      return result;
    for (const task of this.listTasks(missionId)) {
      if (
        task.status !== "CANCELED" ||
        task.kind !== "agent" ||
        task.role !== "implementer" ||
        this.listTaskSupersessions(missionId).some((lineage) => lineage.failedTaskId === task.task_id)
      )
        continue;
      const proven = this.legacyTaskCancellationWasAuthorityLoss(task.task_id);
      (proven ? result.recoverableTaskIds : result.ambiguousTaskIds).push(task.task_id);
    }
    return result;
  }

  /** Read-only origin proof retained after supersession; never grants permission to revive a task. */
  legacyTaskCancellationWasAuthorityLoss(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.status !== "CANCELED" || task.kind !== "agent" || task.role !== "implementer") return false;
    const execution = task.assigned_execution_id ? this.getExecution(task.assigned_execution_id) : undefined;
    const reason = execution
      ? (this.executionRejectionReasons.get(execution.execution_id) ??
        this.listFailureClassifications(task.mission_id).find(
          (classification) =>
            classification.category === "ORPHANED_EXECUTION" &&
            classification.executionId === execution.execution_id &&
            classification.taskId === task.task_id &&
            LEGACY_AUTHORITY_LOSS.test(classification.summary),
        )?.summary ??
        execution.exit_status ??
        "")
      : "";
    const ownershipLoss = LEGACY_AUTHORITY_LOSS.test(reason);
    return (
      this.listMissionStops(task.mission_id).length > 0 &&
      execution?.status === "CANCELED" &&
      execution.task_id === task.task_id &&
      execution.mission_id === task.mission_id &&
      ownershipLoss &&
      task.steer_requests.length === 0 &&
      !/operator|user|constraint|canceled by caller/i.test(task.failure_reason ?? "")
    );
  }

  /** Append inert late evidence and keep append failures visible in persistenceDiagnostics(). */
  async recordLateExecution(executionId: string, reason: string, evidence: LateExecutionEvidence): Promise<boolean> {
    this.rejectLateExecution(executionId, reason, evidence);
    try {
      await this.flush();
      return true;
    } catch {
      // drainPending records the exact failed event for operator diagnostics.
      return false;
    }
  }

  // ── Findings ────────────────────────────────────────────────────────────

  /**
   * Record a lane coordination event on the mission stream (actor=system).
   * All lane events are mission-scoped; lane.stale_taken uses the dead
   * holder's missionId from the claim. Informational — no in-memory state is
   * rebuilt on replay.
   */
  recordLaneEvent(
    type: "lane.acquired" | "lane.released" | "lane.wait" | "lane.stale_taken" | "lane.index_corrupt",
    missionId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emit(type, missionId, { actor: "system", ...payload });
  }

  /** Durably record that a task waits for a repository lease held by another mission. */
  setRepositoryWait(taskId: string, wait: Omit<RepositoryWait, "missionId">): void {
    const mission = this.tasks.get(taskId)?.mission_id;
    if (!mission) return;
    const current = this.repositoryWaits.get(taskId);
    if (current && current.holderMissionId === wait.holderMissionId && current.repoId === wait.repoId) return;
    this.apply(
      this.emit("repository.wait", mission, { actor: "system", task_id: taskId, ...wait, mission_id: mission }),
    );
  }

  clearRepositoryWait(taskId: string): void {
    const current = this.repositoryWaits.get(taskId);
    if (!current) return;
    this.apply(this.emit("repository.wait_cleared", current.missionId, { actor: "system", task_id: taskId }));
  }

  listRepositoryWaits(missionId: string): Array<RepositoryWait & { taskId: string }> {
    return [...this.repositoryWaits.entries()]
      .filter(([, wait]) => wait.missionId === missionId)
      .map(([taskId, wait]) => ({ taskId, ...wait }));
  }

  getRepositoryWait(taskId: string): RepositoryWait | undefined {
    return this.repositoryWaits.get(taskId);
  }
}
