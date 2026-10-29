/**
 * MissionStore layer: Findings, handoff records, workspace/checkpoints, failure/recovery, supersession.
 * Moved verbatim out of missionStore.ts; composed by inheritance (state lives in
 * MissionStoreBase, `private` members became `protected` so layers can share them).
 */

import { id } from "../core/ids.ts";
import type { StoredEvent } from "../platform/eventstore/backend.ts";
import {
  type CheckpointRefsInput,
  attachCheckpointRefs,
  buildCheckpointRefs,
} from "../runtime/host/handoffCheckpointRefs.ts";
import {
  type HandoffEndpoint,
  type HandoffRecord,
  type HandoffState,
  nextStates,
  validateHandoffRecord,
} from "../runtime/host/handoffKinds.ts";
import { taskCoverageFingerprint } from "./evidence.ts";
import {
  copyFailureClassification,
  copyRecoveryDecision,
  copyTask,
  copyTaskCheckpoint,
  copyTaskSupersession,
  copyWorkspaceManifest,
} from "./missionStoreCopy.ts";
import { MissionStoreEntities } from "./missionStoreEntities.ts";
import {
  DISK_SUSPENDED_EXCUSABLE,
  HandoffRecordError,
  type OrchestrationEvent,
  type OrchestrationEventType,
  RECOVERY_TRANSITIONS,
  persistenceErrorMessage,
} from "./missionStoreTypes.ts";
import { failureFingerprint } from "./recovery.ts";
import type {
  DiskSuspendEpisode,
  FailureClassification,
  OrchestrationTask,
  RecoveryDecision,
  RecoveryStatus,
  ReviewFinding,
  TaskCheckpoint,
  TaskSupersession,
  WorkspaceManifest,
} from "./types.ts";

export abstract class MissionStoreRecords extends MissionStoreEntities {
  addFinding(finding: Omit<ReviewFinding, "finding_id" | "status" | "created_at">): ReviewFinding {
    const f: ReviewFinding = {
      ...finding,
      finding_id: id("F"),
      status: "open",
      created_at: new Date().toISOString(),
    };
    this.findings.set(f.finding_id, f);
    this.emit("finding.created", finding.mission_id, {
      actor: "agent",
      finding: f,
    });
    return { ...f };
  }

  resolveFinding(findingId: string): void {
    const f = this.findings.get(findingId);
    if (!f) return;
    f.status = "resolved";
    this.emit("finding.resolved", f.mission_id, {
      actor: "system",
      finding_id: findingId,
    });
  }

  listFindings(missionId?: string): ReviewFinding[] {
    return [...this.findings.values()]
      .filter((f) => (missionId ? f.mission_id === missionId : true))
      .map((f) => ({ ...f }));
  }

  /**
   * Persist a typed, validated handoff record. The input is validated with
   * `validateHandoffRecord`; invalid input throws a `HandoffRecordError` carrying
   * the field-level errors. Records are stored by their stable id and are the
   * durable substrate for phase-boundary handoffs and resume (spec: typed
   * handoffs).
   */
  addHandoffRecord(record: unknown): HandoffRecord {
    const result = validateHandoffRecord(record);
    if (!result.ok) {
      throw new HandoffRecordError(result.errors);
    }
    this.handoffRecords.set(result.record.id, { ...result.record });
    this.emit("handoff.created", result.record.missionId, {
      actor: "system",
      handoff: { ...result.record },
    });
    this.lineageHandoff(result.record);
    return { ...result.record };
  }

  /**
   * Create and persist a HandoffRecord carrying an immutable checkpoint reference
   * set. Builds the refs from the raw inputs (full 40-hex checkpoint + source
   * SHAs and artifact ref/hash pairs) via `buildCheckpointRefs`, attaches them to
   * the record (setting `checkpointSha`) via `attachCheckpointRefs`, and stores
   * it. Throws a `HandoffRecordError` when either the refs or the base record are
   * invalid. This is the foundation for phase-boundary handoffs that resume from
   * a checkpoint (spec: handoff checkpoints).
   */
  addHandoffRecordWithCheckpointRefs(record: unknown, refsInput: CheckpointRefsInput): HandoffRecord {
    const refsResult = buildCheckpointRefs(refsInput);
    if (!refsResult.ok) {
      throw new HandoffRecordError(refsResult.errors);
    }
    const base = validateHandoffRecord(record);
    if (!base.ok) {
      throw new HandoffRecordError(base.errors);
    }
    const withRefs = attachCheckpointRefs(base.record, refsResult.refs);
    return this.addHandoffRecord(withRefs);
  }

  getHandoffRecord(id: string): HandoffRecord | undefined {
    const record = this.handoffRecords.get(id);
    return record ? { ...record } : undefined;
  }

  listHandoffRecords(missionId?: string): HandoffRecord[] {
    return [...this.handoffRecords.values()]
      .filter((r) => (missionId ? r.missionId === missionId : true))
      .map((r) => ({ ...r }));
  }

  /**
   * Advance a stored handoff record through the lifecycle state machine
   * (spec Unit B1). The target state must be allowed by `nextStates` for the
   * current state; `acknowledged`/`committed` additionally require the
   * successor endpoint (the fresh session taking over) and stamp `ackAt`.
   * Returns the updated record; throws a `HandoffRecordError` for an unknown
   * id, an illegal transition, or a missing successor.
   */
  transitionHandoffRecord(id: string, to: HandoffState, successor?: HandoffEndpoint, ackAt?: string): HandoffRecord {
    const current = this.handoffRecords.get(id);
    if (!current) {
      throw new HandoffRecordError([`unknown handoff record ${id}`]);
    }
    if (!nextStates(current.state).includes(to)) {
      throw new HandoffRecordError([`illegal handoff transition ${current.state} -> ${to}`]);
    }
    const next: HandoffRecord = { ...current, state: to };
    if (to === "acknowledged" || to === "committed") {
      // A committed record inherits the successor + ackAt stamped at
      // acknowledgement; only a missing one is an error.
      const effectiveSuccessor = successor ?? current.successor;
      if (!effectiveSuccessor) {
        throw new HandoffRecordError([`successor is required for state ${to}`]);
      }
      next.successor = { ...effectiveSuccessor };
      next.ackAt = ackAt ?? current.ackAt ?? new Date().toISOString();
    }
    this.handoffRecords.set(id, { ...next });
    // Persist the transition: a restart restores the state lineage reported, not `prepared`.
    this.emit("handoff.transitioned", next.missionId, { actor: "system", handoff: { ...next } });
    this.lineageHandoff(next);
    return { ...next };
  }

  protected lineageHandoff(record: HandoffRecord): void {
    this.lineageDo((l) =>
      l.handoff({
        id: record.id,
        kind: record.kind,
        missionId: record.missionId,
        fromSession: record.predecessor.sessionId,
        toSession: record.successor?.sessionId,
        state: record.state,
        checkpointSha: record.checkpointSha,
        fromGeneration: record.predecessor.generation,
        toGeneration: record.successor?.generation,
        at:
          record.ackAt && (record.state === "acknowledged" || record.state === "committed")
            ? record.ackAt
            : record.createdAt,
      }),
    );
  }

  /** Preserve a settled outcome while making failed lease cleanup durable and visible. */
  async recordOwnershipReleaseFailure(input: {
    missionId: string;
    taskId?: string;
    repoId?: string;
    generation: number;
    fencingToken: number;
    ownerId: string;
    renewBy: string;
    error: unknown;
  }): Promise<ReviewFinding> {
    const scope = input.repoId ? "repository" : "mission";
    const message = persistenceErrorMessage(input.error);
    const finding = this.addFinding({
      mission_id: input.missionId,
      task_id: input.taskId ?? null,
      severity: "major",
      category: "ownership_release",
      file: null,
      line: null,
      summary: `${scope} ownership release failed after outcome settlement`,
      evidence: JSON.stringify({
        scope,
        missionId: input.missionId,
        taskId: input.taskId ?? null,
        repoId: input.repoId ?? null,
        generation: input.generation,
        fencingToken: input.fencingToken,
        ownerId: input.ownerId,
        renewBy: input.renewBy,
        error: message,
      }),
      recommended_action: "Inspect writer health and reconcile the durable lease before the next mutation.",
    });
    // A failed flush remains queued and is also exposed through
    // persistenceDiagnostics(); never rewrite the already-settled outcome.
    await this.flush().catch(() => undefined);
    return finding;
  }

  // ── Durable reliability authority ──────────────────────────────────────

  bindWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
    if (!this.missions.has(manifest.missionId)) throw new Error(`unknown mission ${manifest.missionId}`);
    const copy = copyWorkspaceManifest(manifest);
    const prior = this.workspaceManifests.get(manifest.missionId);
    const type = prior ? "workspace.rebound" : "workspace.authorized";
    if (prior) this.invalidateCurrentCandidate(manifest.missionId, "workspace manifest rebound");
    this.workspaceManifests.set(manifest.missionId, copy);
    this.emit(type, manifest.missionId, { actor: "system", manifest: copy });
    return copyWorkspaceManifest(copy);
  }

  /** Publish a manifest only after its event is durably appended. */
  bindWorkspaceManifestDurably(
    manifest: WorkspaceManifest,
    expectedPredecessor: { generation: number; hash: string } | null,
  ): Promise<WorkspaceManifest> {
    const publish = this.emitChain.then(async () => {
      await this.drainPending();
      if (!this.missions.has(manifest.missionId)) throw new Error(`unknown mission ${manifest.missionId}`);
      const copy = copyWorkspaceManifest(manifest);
      const prior = this.workspaceManifests.get(manifest.missionId);
      const expectedGeneration = expectedPredecessor?.generation ?? 0;
      if (manifest.generation !== expectedGeneration + 1) {
        throw new Error(
          `workspace manifest generation must advance exactly once (${expectedGeneration} -> ${manifest.generation})`,
        );
      }
      const type = prior ? "workspace.rebound" : "workspace.authorized";
      const payload = structuredClone({ actor: "system", manifest: copy });
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: manifest.missionId,
        timestamp: new Date().toISOString(),
        type,
        actor: "system",
        payload,
      };
      const stored: StoredEvent = {
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.type,
        project_id: null,
        run_id: manifest.missionId,
        worker_id: null,
        payload,
      };
      let appended: StoredEvent | undefined;
      try {
        appended = await this.backend.appendConditionally(
          stored,
          () => {
            const durablePrior = this.backend
              .all()
              .filter(
                (candidate) =>
                  candidate.run_id === manifest.missionId &&
                  (candidate.type === "workspace.authorized" || candidate.type === "workspace.rebound"),
              )
              .at(-1)?.payload.manifest as WorkspaceManifest | undefined;
            if (expectedPredecessor === null) return durablePrior === undefined && manifest.generation === 1;
            return (
              durablePrior?.generation === expectedPredecessor.generation &&
              durablePrior.hash === expectedPredecessor.hash &&
              manifest.generation === expectedPredecessor.generation + 1
            );
          },
          () => this.apply(event),
        );
      } catch (error) {
        this.recordPersistenceFailure(event, error);
        throw error;
      }
      if (!appended) throw new Error("workspace manifest durable compare-and-swap was rejected");
      this.clearPersistenceFailure(event.event_id);
      if (prior) this.invalidateCurrentCandidate(manifest.missionId, "workspace manifest rebound");
      return copyWorkspaceManifest(copy);
    });
    this.emitChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
  }

  getWorkspaceManifest(missionId: string): WorkspaceManifest | undefined {
    const manifest = this.workspaceManifests.get(missionId);
    return manifest ? copyWorkspaceManifest(manifest) : undefined;
  }

  getTaskCheckpoint(checkpointId: string): TaskCheckpoint | undefined {
    const checkpoint = this.taskCheckpoints.get(checkpointId);
    return checkpoint ? copyTaskCheckpoint(checkpoint) : undefined;
  }

  checkpointTask(checkpoint: TaskCheckpoint): TaskCheckpoint {
    const task = this.tasks.get(checkpoint.taskId);
    if (!task || task.mission_id !== checkpoint.missionId) throw new Error(`unknown task ${checkpoint.taskId}`);
    const copy = copyTaskCheckpoint(checkpoint);
    this.recordTaskCheckpoint(copy);
    this.emit("task.checkpointed", checkpoint.missionId, {
      actor: "system",
      checkpoint: copy,
    });
    return copyTaskCheckpoint(copy);
  }

  /**
   * Serialize the authority check with durable checkpoint publication.
   * Unlike checkpointTask(), this does not expose the checkpoint in memory or
   * enqueue its event before the expected execution identity is current.
   */
  publishCheckpointIfAuthoritative(checkpoint: TaskCheckpoint): Promise<TaskCheckpoint> {
    const publish = this.emitChain.then(async () => {
      await this.drainPending();
      this.assertCheckpointAuthoritative(checkpoint);

      const copy = copyTaskCheckpoint(checkpoint);
      const priorSession = this.priorCheckpointSession(checkpoint);
      const payload = structuredClone({ actor: "system", checkpoint: copy });
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: checkpoint.missionId,
        timestamp: new Date().toISOString(),
        type: "task.checkpointed",
        actor: "system",
        payload,
      };
      const stored: StoredEvent = {
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.type,
        project_id: null,
        run_id: checkpoint.missionId,
        worker_id: null,
        payload,
      };
      let authorityError: unknown;
      try {
        const appended = await this.backend.appendConditionally(
          stored,
          () => {
            try {
              this.assertCheckpointAuthoritative(checkpoint);
              return true;
            } catch (error) {
              authorityError = error;
              return false;
            }
          },
          () => this.apply(event),
        );
        if (!appended) throw authorityError ?? new Error("checkpoint origin mismatch");
      } catch (error) {
        if (!authorityError) this.recordPersistenceFailure(event, error);
        throw error;
      }
      this.clearPersistenceFailure(event.event_id);
      this.lineageCheckpointVerified(copy, priorSession);
      return copyTaskCheckpoint(copy);
    });
    this.emitChain = publish.then(
      () => undefined,
      () => undefined,
    );
    return publish;
  }

  /** Session of the latest earlier checkpoint of the same execution, if any. */
  protected priorCheckpointSession(checkpoint: TaskCheckpoint): string | null {
    const earlier = this.listTaskCheckpoints(checkpoint.missionId, checkpoint.taskId).filter(
      (candidate) => candidate.executionId === checkpoint.executionId && candidate.sessionId,
    );
    // No earlier checkpoint: the session the execution itself recorded is the one being replaced.
    return earlier.at(-1)?.sessionId ?? this.executions.get(checkpoint.executionId)?.session_id ?? null;
  }

  /** Verified checkpoint: artifact produced by the attempt; a changed session id is a rollover of the same attempt. */
  protected lineageCheckpointVerified(checkpoint: TaskCheckpoint, priorSession: string | null): void {
    const execution = this.executions.get(checkpoint.executionId);
    if (!execution || !this.lineageAgentExecution(execution)) return;
    this.lineageSessionChange(execution, priorSession, checkpoint.sessionId ?? null, checkpoint.createdAt);
    this.acknowledgeObservedHandoffs(execution, priorSession, checkpoint.sessionId ?? null);
    this.lineageDo((l) =>
      l.checkpointVerified({
        checkpointId: checkpoint.checkpointId,
        attempt: checkpoint.executionId,
        missionId: checkpoint.missionId,
        taskId: checkpoint.taskId,
        sequence: checkpoint.sequence,
        commit: checkpoint.candidateSha,
        at: checkpoint.createdAt,
      }),
    );
  }

  protected assertCheckpointAuthoritative(checkpoint: TaskCheckpoint): void {
    this.assertExecutionAuthoritative(checkpoint.executionId);
    const task = this.tasks.get(checkpoint.taskId);
    const repository = this.workspaceManifests
      .get(checkpoint.missionId)
      ?.repositories.find((candidate) => candidate.repoId === checkpoint.repoId);
    const mismatches = [
      !task || task.mission_id !== checkpoint.missionId ? "task" : null,
      task?.assigned_execution_id && task.assigned_execution_id !== checkpoint.executionId
        ? "execution assignment"
        : null,
      task?.repo_id !== checkpoint.repoId ? "repository" : null,
      !repository || repository.baseSha !== checkpoint.baseSha ? "base" : null,
      (task?.mission_generation ?? 0) !== checkpoint.missionGeneration ? "mission generation" : null,
      (task?.candidate_generation ?? 0) !== checkpoint.candidateGeneration ? "candidate generation" : null,
      (task?.fencing_token ?? 0) !== checkpoint.fencingToken ? "fencing token" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) throw new Error(`checkpoint origin mismatch: ${mismatches.join(", ")}`);
  }

  listTaskCheckpoints(missionId?: string, taskId?: string): TaskCheckpoint[] {
    return [...this.taskCheckpoints.values()]
      .filter((checkpoint) => (missionId ? checkpoint.missionId === missionId : true))
      .filter((checkpoint) => (taskId ? checkpoint.taskId === taskId : true))
      .sort(
        (left, right) =>
          (this.taskCheckpointLastEventOrdinals.get(left.checkpointId) ?? 0) -
          (this.taskCheckpointLastEventOrdinals.get(right.checkpointId) ?? 0),
      )
      .map(copyTaskCheckpoint);
  }

  protected recordTaskCheckpoint(checkpoint: TaskCheckpoint): void {
    const copy = copyTaskCheckpoint(checkpoint);
    this.taskCheckpoints.set(copy.checkpointId, copy);
    this.taskCheckpointLastEventOrdinals.set(copy.checkpointId, ++this.taskCheckpointEventOrdinal);
  }

  /**
   * (#416) Record that a disk-pressure suspend interrupted `taskIds`. One
   * open episode per mission: a fresh-incident re-suspend (the controller's
   * re-suspension path) merges additional RUNNING tasks into the open episode
   * instead of stacking a second one. Deterministic: replay reproduces the
   * same episode from the durable event.
   */
  markDiskSuspendEpisode(
    missionId: string,
    input: { episodeId?: string; taskIds: readonly string[]; incidentPath?: string; markedAt?: string },
  ): DiskSuspendEpisode {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const open = this.diskSuspendEpisodes.find((e) => e.missionId === missionId && e.resolvedAt === null);
    if (open) {
      const added = input.taskIds.filter((taskId) => !open.taskIds.includes(taskId));
      if (added.length > 0) {
        open.taskIds.push(...added);
        if (input.incidentPath && !open.incidentPath) open.incidentPath = input.incidentPath;
        this.emit("mission.disk_suspend_marked", missionId, {
          actor: "system",
          episode: structuredClone(open),
        });
      }
      return structuredClone(open);
    }
    const episode: DiskSuspendEpisode = {
      episodeId: input.episodeId ?? id("DSE"),
      missionId,
      ...(input.incidentPath ? { incidentPath: input.incidentPath } : {}),
      taskIds: [...new Set(input.taskIds)],
      markedAt: input.markedAt ?? new Date().toISOString(),
      resolvedAt: null,
    };
    this.diskSuspendEpisodes.push(episode);
    this.emit("mission.disk_suspend_marked", missionId, { actor: "system", episode: structuredClone(episode) });
    return structuredClone(episode);
  }

  /** (#416) Close the open disk-suspend episode for the mission (incident recovered). */
  resolveDiskSuspendEpisode(missionId: string, resolvedAt?: string): DiskSuspendEpisode | undefined {
    const episode = [...this.diskSuspendEpisodes]
      .reverse()
      .find((entry) => entry.missionId === missionId && entry.resolvedAt === null);
    if (!episode) return undefined;
    episode.resolvedAt = resolvedAt ?? new Date().toISOString();
    this.emit("mission.disk_suspend_resolved", missionId, {
      actor: "system",
      episodeId: episode.episodeId,
      resolvedAt: episode.resolvedAt,
    });
    return structuredClone(episode);
  }

  /** (#416) The open disk-suspend episode for the mission, if any. */
  getOpenDiskSuspendEpisode(missionId: string): DiskSuspendEpisode | undefined {
    const episode = [...this.diskSuspendEpisodes]
      .reverse()
      .find((entry) => entry.missionId === missionId && entry.resolvedAt === null);
    return episode ? structuredClone(episode) : undefined;
  }

  /** (#416) All disk-suspend episodes for the mission, oldest first (audit). */
  listDiskSuspendEpisodes(missionId?: string): DiskSuspendEpisode[] {
    return this.diskSuspendEpisodes
      .filter((episode) => (missionId ? episode.missionId === missionId : true))
      .map((episode) => structuredClone(episode));
  }

  classifyFailure(classification: FailureClassification): FailureClassification {
    if (!this.missions.has(classification.missionId)) throw new Error(`unknown mission ${classification.missionId}`);
    const copy = copyFailureClassification(classification);
    this.applyDiskSuspendOverride(copy);
    this.failureClassifications.set(copy.classificationId, copy);
    this.emit("failure.classified", classification.missionId, {
      actor: "system",
      classification: copy,
    });
    return copyFailureClassification(copy);
  }

  /**
   * (#416) A task that was RUNNING when a disk-pressure suspend fired and then
   * fails with a transient/interruption signature is diagnosed
   * `DISK_SUSPENDED`: recovery resumes it from its last checkpoint (the fence/
   * reconcile action) and the outage is waited out — never terminal by count.
   * Genuine defects (validation, review, merge, authorization, scope,
   * requirement, deadlock) are never excused by a concurrent disk outage, and
   * failures of tasks that were NOT running at suspend are untouched. The
   * classificationId stays the caller's: only the diagnosis and the budget
   * fingerprint change, so caller identity checks keep working.
   */
  protected applyDiskSuspendOverride(copy: FailureClassification): void {
    if (copy.category === "DISK_SUSPENDED" || !copy.taskId) return;
    if (!DISK_SUSPENDED_EXCUSABLE.has(copy.category)) return;
    const episode = [...this.diskSuspendEpisodes]
      .reverse()
      .find((entry) => entry.missionId === copy.missionId && entry.resolvedAt === null);
    if (!episode || !episode.taskIds.includes(copy.taskId)) return;
    copy.category = "DISK_SUSPENDED";
    copy.summary = `${copy.summary} [interrupted by disk suspend ${episode.episodeId}${
      episode.incidentPath ? ` on ${episode.incidentPath}` : ""
    }]`;
    copy.fingerprint = failureFingerprint({
      missionId: copy.missionId,
      taskId: copy.taskId,
      executionId: copy.executionId,
      summary: copy.summary,
      evidenceRefs: copy.evidenceRefs,
      category: "DISK_SUSPENDED",
    });
  }

  listFailureClassifications(missionId?: string): FailureClassification[] {
    return [...this.failureClassifications.values()]
      .filter((classification) => (missionId ? classification.missionId === missionId : true))
      .map(copyFailureClassification);
  }

  getFailureClassification(classificationId: string): FailureClassification | undefined {
    const classification = this.failureClassifications.get(classificationId);
    return classification ? copyFailureClassification(classification) : undefined;
  }

  planRecovery(decision: RecoveryDecision): RecoveryDecision {
    if (!this.missions.has(decision.missionId)) throw new Error(`unknown mission ${decision.missionId}`);
    const classification = this.failureClassifications.get(decision.classificationId);
    if (!classification || classification.missionId !== decision.missionId) {
      throw new Error(`unknown failure classification ${decision.classificationId}`);
    }
    if (this.recoveryDecisions.has(decision.recoveryId)) {
      throw new Error(`duplicate recovery ID ${decision.recoveryId}`);
    }
    const mission = this.missions.get(decision.missionId)!;
    if (decision.action === "REPAIR_BLOCKED_MISSION" && (mission.status !== "BLOCKED" || !mission.blocked_episode_id)) {
      throw new Error("blocked-mission repair must be planned during a durable BLOCKED episode");
    }
    const copy: RecoveryDecision = {
      ...decision,
      ...(decision.startingCandidateContent
        ? { startingCandidateContent: { ...decision.startingCandidateContent } }
        : {}),
      status: "planned",
      resumptionGeneration: this.listMissionResumptions(decision.missionId).at(-1)?.generation ?? 0,
      ...(mission.status === "BLOCKED" && decision.action !== "STOP"
        ? { blockedEpisodeId: mission.blocked_episode_id }
        : {}),
    };
    this.recoveryDecisions.set(copy.recoveryId, copy);
    this.emit("recovery.planned", decision.missionId, {
      actor: "system",
      decision: copy,
    });
    return copyRecoveryDecision(copy);
  }

  transitionRecovery(recoveryId: string, status: Exclude<RecoveryStatus, "planned">): RecoveryDecision {
    const decision = this.recoveryDecisions.get(recoveryId);
    if (!decision) throw new Error(`unknown recovery ${recoveryId}`);
    // The scheduler and orchestrator may observe the same terminal outcome.
    // A replay may acknowledge it, but must never change that outcome.
    if (decision.status === status && (status === "succeeded" || status === "failed" || status === "exhausted")) {
      return copyRecoveryDecision(decision);
    }
    if (!RECOVERY_TRANSITIONS[decision.status].includes(status)) {
      throw new Error(`illegal recovery transition ${decision.status} -> ${status}`);
    }
    if (status === "started" && decision.action === "REPAIR_BLOCKED_MISSION") {
      throw new Error("blocked-mission repair must start atomically through transitionMission");
    }
    const next = { ...decision, status };
    this.recoveryDecisions.set(recoveryId, next);
    this.emit(`recovery.${status}` as OrchestrationEventType, decision.missionId, {
      actor: "system",
      decision: next,
    });
    return copyRecoveryDecision(next);
  }

  listRecoveryDecisions(missionId?: string): RecoveryDecision[] {
    return [...this.recoveryDecisions.values()]
      .filter((decision) => (missionId ? decision.missionId === missionId : true))
      .map(copyRecoveryDecision);
  }

  getRecoveryDecision(recoveryId: string): RecoveryDecision | undefined {
    const decision = this.recoveryDecisions.get(recoveryId);
    return decision ? copyRecoveryDecision(decision) : undefined;
  }

  supersedeTask(supersession: TaskSupersession): TaskSupersession {
    const failed = this.tasks.get(supersession.failedTaskId);
    const legacyRecovery =
      failed?.status === "CANCELED" &&
      supersession.recoveryDecisionId &&
      this.getRecoveryDecision(supersession.recoveryDecisionId)?.action === "FENCE_RECONCILE_AND_RESUME" &&
      (this.getRecoveryDecision(supersession.recoveryDecisionId)?.resumptionGeneration ?? 0) ===
        (this.listMissionResumptions(supersession.missionId).at(-1)?.generation ?? 0) &&
      this.legacyCanceledRecovery(supersession.missionId).recoverableTaskIds.includes(failed.task_id);
    if (!failed || failed.mission_id !== supersession.missionId || (failed.status !== "FAILED" && !legacyRecovery)) {
      throw new Error(`supersession requires a failed task ${supersession.failedTaskId}`);
    }
    if (supersession.replacementTaskIds.length === 0) throw new Error("supersession requires replacement task IDs");
    if (this.taskSupersessions.has(supersession.supersessionId)) {
      throw new Error(`duplicate supersession ID ${supersession.supersessionId}`);
    }
    if (new Set(supersession.replacementTaskIds).size !== supersession.replacementTaskIds.length) {
      throw new Error("supersession requires unique replacement task IDs");
    }
    if (supersession.replacementTaskIds.includes(failed.task_id)) {
      throw new Error(`failed task ${failed.task_id} cannot replace itself`);
    }
    if (this.listTaskSupersessions(supersession.missionId).some((entry) => entry.failedTaskId === failed.task_id)) {
      throw new Error(`task ${failed.task_id} is already superseded`);
    }
    const failedAcceptance = new Set(failed.acceptance_ids ?? []);
    const declaredAcceptance = new Set(supersession.acceptanceIds);
    if (failed.repo_id !== supersession.repoId || [...failedAcceptance].some((id) => !declaredAcceptance.has(id))) {
      throw new Error("supersession does not match failed task repository coverage and acceptance coverage");
    }
    const expectedCoverage = taskCoverageFingerprint(failed);
    if (supersession.coverageFingerprint !== expectedCoverage) {
      throw new Error("supersession does not match immutable failed task coverage");
    }
    const replacements = supersession.replacementTaskIds.map((taskId) => this.tasks.get(taskId));
    if (replacements.some((task) => !task || task.mission_id !== supersession.missionId)) {
      throw new Error("supersession contains an unknown replacement task ID");
    }
    const coveredAcceptance = new Set(replacements.flatMap((task) => task?.acceptance_ids ?? []));
    if (
      replacements.some((task) => task?.repo_id !== supersession.repoId) ||
      [...declaredAcceptance].some((id) => !coveredAcceptance.has(id))
    ) {
      throw new Error("replacement tasks do not provide matching repository coverage and acceptance coverage");
    }
    if (supersession.recoveryDecisionId) {
      const decision = this.recoveryDecisions.get(supersession.recoveryDecisionId);
      if (!decision || decision.missionId !== supersession.missionId) {
        throw new Error("supersession recovery decision does not match mission");
      }
      if (!supersession.expectedReplacementFingerprints) {
        throw new Error("recovery supersession requires replacement fingerprints");
      }
      if (Object.keys(supersession.expectedReplacementFingerprints).length !== replacements.length) {
        throw new Error("recovery supersession requires exactly one fingerprint per ordered replacement");
      }
      for (const replacement of replacements) {
        const authority = replacement?.recovery_authority;
        const expected = supersession.expectedReplacementFingerprints?.[replacement!.task_id];
        if (
          replacement?.replacement_spec_fingerprint !== expected ||
          (authority !== undefined &&
            (authority.recoveryDecisionId !== supersession.recoveryDecisionId ||
              authority.supersessionId !== supersession.supersessionId ||
              authority.originalTaskId !== supersession.failedTaskId ||
              expected !== authority.expectedReplacementFingerprint))
        ) {
          throw new Error("supersession replacement recovery fingerprint mismatch");
        }
      }
    }
    const copy = copyTaskSupersession(supersession);
    this.taskSupersessions.set(copy.supersessionId, copy);
    this.emit("task.superseded", supersession.missionId, {
      actor: "system",
      supersession: copy,
    });
    return copyTaskSupersession(copy);
  }

  listTaskSupersessions(missionId?: string): TaskSupersession[] {
    return [...this.taskSupersessions.values()]
      .filter((supersession) => (missionId ? supersession.missionId === missionId : true))
      .map(copyTaskSupersession);
  }

  /** Current transitive leaves for a task's immutable supersession lineage. */
  taskSupersessionLeaves(taskId: string, visiting = new Set<string>()): OrchestrationTask[] {
    if (visiting.has(taskId)) return [];
    const lineage = [...this.taskSupersessions.values()].find((entry) => entry.failedTaskId === taskId);
    const task = this.tasks.get(taskId);
    if (!lineage) return task ? [copyTask(task)] : [];
    const next = new Set(visiting).add(taskId);
    return lineage.replacementTaskIds.flatMap((replacementId) => this.taskSupersessionLeaves(replacementId, next));
  }

  isTaskSatisfiedBySupersession(taskId: string): boolean {
    const leaves = this.taskSupersessionLeaves(taskId);
    return leaves.length > 0 && leaves.every((task) => task.status === "SUCCEEDED");
  }

  getTaskSupersession(supersessionId: string): TaskSupersession | undefined {
    const supersession = this.taskSupersessions.get(supersessionId);
    return supersession ? copyTaskSupersession(supersession) : undefined;
  }
}
