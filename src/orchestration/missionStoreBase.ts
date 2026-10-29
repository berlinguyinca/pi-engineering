/**
 * MissionStore layer: Fields, lineage hooks, persistence drain and the event `apply` replay.
 * Moved verbatim out of missionStore.ts; composed by inheritance (state lives in
 * MissionStoreBase, `private` members became `protected` so layers can share them).
 */

import { id } from "../core/ids.ts";
import type {
  GithubGateDecision,
  GithubLinkPatch,
  GithubLinkRecord,
  GithubLinkSuggestion,
  GithubRereviewRequest,
  GithubStaleSignal,
} from "../github/types.ts";
import type { EventStoreBackend, StoredEvent } from "../platform/eventstore/backend.ts";
import { type LineageEmitter, lineageNodeId } from "../runtime/herdr/lineage.ts";
import type { HandoffEndpoint, HandoffRecord, HandoffState } from "../runtime/host/handoffKinds.ts";
import { type CanonicalLifecycleState, LIFECYCLE_SCHEMA_VERSION, toCanonical } from "./canonicalLifecycle.ts";
import {
  candidateKey,
  copyCandidateRevision,
  copyEvidenceInvalidation,
  copyExecution,
  copyFailureClassification,
  copyMission,
  copyMissionStop,
  copyReviewEvidence,
  copyTask,
  copyTaskSupersession,
  copyValidationEvidence,
  copyWorkspaceManifest,
} from "./missionStoreCopy.ts";
import {
  type CanonicalLifecycle,
  type CanonicalLifecycleRecord,
  type DagProjection,
  LEGACY_AUTHORITY_LOSS,
  MAX_PERSISTENCE_DIAGNOSTICS,
  type MissionPersistenceDiagnostic,
  ORCHESTRATION_EVENT_TYPES,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type RepositoryWait,
  applyGithubLinkPatch,
  persistenceErrorMessage,
} from "./missionStoreTypes.ts";
import type {
  CandidateEvidenceIdentity,
  CandidateRevision,
  DiskSuspendEpisode,
  EvidenceInvalidation,
  Execution,
  ExecutionStatus,
  FailureClassification,
  LeaseTransition,
  Mission,
  MissionLease,
  MissionResumption,
  MissionStatus,
  MissionStop,
  OperatorModelPin,
  OrchestrationTask,
  ReconstructedCandidateSource,
  RecoveryDecision,
  RepositoryLease,
  ReviewEvidence,
  ReviewFinding,
  TaskCheckpoint,
  TaskStatus,
  TaskSupersession,
  ValidationEvidence,
  WorkspaceManifest,
} from "./types.ts";

export abstract class MissionStoreBase {
  protected readonly backend: EventStoreBackend;
  protected readonly missions = new Map<string, Mission>();
  /**
   * The canonical lifecycle image recorded by the last transition, with the
   * status it was recorded for. Rebuilt on replay from the transition event;
   * a journal written before the field existed leaves no entry and is derived
   * with `toCanonical` on read, never written back.
   */
  protected readonly canonicalRecords = new Map<string, CanonicalLifecycleRecord>();
  protected readonly tasks = new Map<string, OrchestrationTask>();
  /** Tasks currently waiting for another mission's repository lease (informational, in-memory). */
  protected readonly repositoryWaits = new Map<string, RepositoryWait>();
  protected readonly executions = new Map<string, Execution>();
  protected readonly findings = new Map<string, ReviewFinding>();
  protected readonly handoffRecords = new Map<string, HandoffRecord>();
  protected readonly workspaceManifests = new Map<string, WorkspaceManifest>();
  protected readonly taskCheckpoints = new Map<string, TaskCheckpoint>();
  /** Replay-stable position of the most recent durable event for each checkpoint lineage. */
  protected readonly taskCheckpointLastEventOrdinals = new Map<string, number>();
  protected taskCheckpointEventOrdinal = 0;
  protected readonly failureClassifications = new Map<string, FailureClassification>();
  protected readonly recoveryDecisions = new Map<string, RecoveryDecision>();
  protected readonly taskSupersessions = new Map<string, TaskSupersession>();
  protected readonly evidenceInvalidations = new Map<string, EvidenceInvalidation>();
  /** Optional GitHub linkage (T05): inert unless something records into it. */
  protected readonly githubLinks = new Map<string, GithubLinkRecord>();
  protected readonly githubSuggestions = new Map<string, GithubLinkSuggestion>();
  protected readonly githubStaleSignals = new Map<string, GithubStaleSignal>();
  protected readonly githubRereviews = new Map<string, GithubRereviewRequest>();
  protected readonly githubGates = new Map<string, GithubGateDecision>();
  protected readonly dagProjections = new Map<string, DagProjection>();
  protected readonly candidates = new Map<string, CandidateRevision>();
  protected readonly validationEvidence = new Map<string, ValidationEvidence>();
  protected readonly reviewEvidence = new Map<string, ReviewEvidence>();
  protected readonly candidateExecutionIds = new Set<string>();
  protected readonly authoritativeExecutionStartOrder = new Map<string, number>();
  protected executionStartSequence = 0;
  protected readonly evidenceReplayErrors = new Map<string, string[]>();
  protected readonly missionLeases = new Map<string, MissionLease>();
  protected readonly repositoryLeases = new Map<string, RepositoryLease>();
  /** Last epochs survive release/expiry so a restarted owner cannot reuse a token. */
  protected readonly missionLeaseEpochs = new Map<string, MissionLease>();
  protected readonly repositoryLeaseEpochs = new Map<string, RepositoryLease>();
  protected readonly missionResumptions: MissionResumption[] = [];
  protected readonly missionStops: MissionStop[] = [];
  /** (#416) disk-pressure suspend episodes, oldest first. */
  protected readonly diskSuspendEpisodes: DiskSuspendEpisode[] = [];
  protected readonly specRevisions = new Map<string, import("./specApproval.ts").MissionSpecRevision>();
  protected readonly specReviews = new Map<string, import("./specApproval.ts").SpecReviewEvidence>();
  protected readonly specApprovals = new Map<string, import("./specApproval.ts").SpecApproval>();
  protected readonly specStages: import("./specApproval.ts").SpecStageAttempt[] = [];
  protected readonly planRevisions: import("./planRecords.ts").PlanRevisionRecord[] = [];
  protected readonly planPolicies: import("./planRecords.ts").PlanPolicyRecord[] = [];
  protected readonly planDecisions: import("./planRecords.ts").PlanDecisionRecord[] = [];
  protected readonly specInvalidations = new Map<
    string,
    { approvalId: string; reason: string; fencingToken: number }
  >();
  protected readonly specMaterializations: Array<{
    missionId: string;
    approvalId: string;
    semanticSpecHash: string;
    created: string[];
    reused: string[];
  }> = [];
  protected readonly persistenceErrors: MissionPersistenceDiagnostic[] = [];
  protected readonly executionRejectionReasons = new Map<string, string>();
  protected readonly resumptionWriteFailures = new Map<string, Set<string>>();
  protected readonly pendingWrites: Array<{
    event: OrchestrationEvent;
    stored: StoredEvent;
  }> = [];
  protected emitChain: Promise<void> = Promise.resolve();
  /** Optional lineage emitter (T02). Null = no lineage; every hook below is then a no-op. */
  protected lineage: LineageEmitter | null = null;
  /** Logical agents (one per task) whose node was upserted, and whether they are currently ended. */
  protected readonly lineageAgents = new Map<string, "live" | "ended">();

  protected constructor(backend: EventStoreBackend) {
    this.backend = backend;
  }

  /**
   * Attach (or detach with null) the lineage emitter. Hooks fire from the
   * mutators only, never from `apply()`, so replaying history on open emits nothing.
   */
  setLineage(emitter: LineageEmitter | null): void {
    this.lineage = emitter;
  }

  /** Run a lineage hook fire-and-forget: absent emitter = no-op, errors never reach the caller. */
  protected lineageDo(hook: (lineage: LineageEmitter) => void): void {
    const lineage = this.lineage;
    if (!lineage) return;
    try {
      hook(lineage);
    } catch {
      // lineage is observational; it must never disturb the mission path
    }
  }

  /** Model-driven executions only: process/integration/validation runs are not agents. */
  protected lineageAgentExecution(ex: Execution): boolean {
    return ex.backend === "agent" || ex.backend === "research" || ex.backend === "review";
  }

  protected lineageAttemptEnded(ex: Execution, state: "done" | "failed" | "cancelled", reason?: string): void {
    if (!this.lineageAgentExecution(ex)) return;
    this.lineageDo((l) => {
      const ended = ex.ended_at ?? undefined;
      l.attemptState(
        { attempt: ex.execution_id, agent: ex.task_id, missionId: ex.mission_id, taskId: ex.task_id },
        state,
        "end", // an attempt ends once: a retried end dedupes
        reason ?? ex.exit_status ?? undefined,
        ended,
      );
      // The agent's state is the aggregate of its attempts: it ends only when none is still live.
      const stillLive = [...this.executions.values()].some(
        (other) =>
          other.task_id === ex.task_id &&
          other.execution_id !== ex.execution_id &&
          (other.status === "PENDING" || other.status === "RUNNING"),
      );
      if (!stillLive) {
        this.lineageAgents.set(ex.task_id, "ended");
        l.agentState(
          { agent: ex.task_id, missionId: ex.mission_id, taskId: ex.task_id },
          state,
          `end:${ex.execution_id}`,
          reason ?? ex.exit_status ?? undefined,
          ended,
        );
      }
    });
  }

  /**
   * A worker review's verdict becomes a `review:` node, a `reviewed` edge bound to the exact candidate commit, and
   * a `produced` edge from the reviewing attempt. The edge targets the commit, not a PR: only a trusted reviewer's
   * edge on a PR counts toward Herdr's quorum, so Pi's own record never poses as a quorum vote. Reviews that were
   * not valid or not accessible are never projected (no verdict was given).
   */
  protected lineageReviewRecorded(ev: ReviewEvidence): void {
    if (!ev.outputValid || !ev.accessible) return;
    const sha = ev.identity.candidateSha;
    this.lineageDo((l) => {
      const review = lineageNodeId("review", ev.evidenceId);
      const commit = lineageNodeId("commit", sha);
      const scope = { mission_id: ev.missionId, task_id: ev.taskId };
      l.nodeUpsert(
        review,
        {
          label: `review ${ev.verdict}`,
          state: "done",
          attrs: {
            verdict: ev.verdict,
            independence: ev.independenceMode,
            findings: ev.findings.length,
            candidate_sha: sha,
            commit: sha,
          },
        },
        `review:${ev.evidenceId}`,
        scope,
        ev.recordedAt,
      );
      l.nodeUpsert(commit, { label: sha.slice(0, 12), attrs: { sha } }, `review-commit:${sha}`, scope, ev.recordedAt);
      l.edgeAdd(
        "reviewed",
        review,
        commit,
        `review:${ev.evidenceId}`,
        { commit: sha, verdict: ev.verdict, independence: ev.independenceMode },
        scope,
        ev.recordedAt,
      );
      l.edgeAdd(
        "produced",
        lineageNodeId("attempt", ev.executionId),
        review,
        `review-produced:${ev.evidenceId}`,
        {},
        scope,
        ev.recordedAt,
      );
    });
  }

  /**
   * A rollover is the successor session taking over. Open handoff records of the mission that named the replaced
   * session as predecessor advance to `acknowledged` with the observed successor, but only when they carry a
   * checkpoint (that is what `validated` means); a record without one is left for its owner. Records carry no
   * execution id, so when another live execution of the mission still holds the replaced session the owner is
   * ambiguous and nothing is advanced. Bookkeeping only: any failure is swallowed, because the checkpoint or status
   * update that observed the rollover is already durable and must not be reported as failed.
   */
  protected acknowledgeObservedHandoffs(ex: Execution, previous: string | null, next: string | null): void {
    if (!previous || !next || previous === next || !this.lineageAgentExecution(ex)) return;
    try {
      const shared = [...this.executions.values()].some(
        (other) =>
          other.execution_id !== ex.execution_id &&
          other.mission_id === ex.mission_id &&
          other.session_id === previous &&
          other.status !== "SUCCEEDED" &&
          other.status !== "FAILED" &&
          other.status !== "CANCELED",
      );
      if (shared) return;
      const open = [...this.handoffRecords.values()].filter(
        (r) =>
          r.missionId === ex.mission_id &&
          r.predecessor.sessionId === previous &&
          r.checkpointSha &&
          (r.state === "prepared" || r.state === "validated"),
      );
      for (const record of open) {
        if (record.state === "prepared") this.transitionHandoffRecord(record.id, "validated");
        this.transitionHandoffRecord(record.id, "acknowledged", {
          sessionId: next,
          generation: record.predecessor.generation + 1,
        });
      }
    } catch {
      // see above: never surface handoff bookkeeping failures to the caller
    }
  }

  /** A model session attached to (or replacing the one on) an attempt. */
  protected lineageSessionChange(ex: Execution, previous: string | null, next: string | null, at: string): void {
    if (!next || next === previous || !this.lineageAgentExecution(ex)) return;
    this.lineageDo((l) =>
      previous
        ? l.sessionRolledOver({
            agent: ex.task_id,
            attempt: ex.execution_id,
            fromSession: previous,
            toSession: next,
            missionId: ex.mission_id,
            taskId: ex.task_id,
            transition: `${previous}>${next}`,
            at,
          })
        : l.sessionAttached({
            agent: ex.task_id,
            attempt: ex.execution_id,
            session: next,
            missionId: ex.mission_id,
            taskId: ex.task_id,
            transition: `attach:${next}`,
            at,
          }),
    );
  }

  protected emit(
    type: OrchestrationEventType,
    missionId: string,
    payload: Record<string, unknown>,
    timestamp = new Date().toISOString(),
  ): OrchestrationEvent {
    const durablePayload = structuredClone(payload);
    const event: OrchestrationEvent = {
      event_id: id("oevt"),
      mission_id: missionId,
      timestamp,
      type,
      actor: (durablePayload.actor as OrchestrationEvent["actor"]) ?? "system",
      payload: durablePayload,
    };
    const stored: StoredEvent = {
      event_id: event.event_id,
      timestamp: event.timestamp,
      type: event.type,
      project_id: null,
      run_id: missionId,
      worker_id: null,
      payload: durablePayload,
    };
    this.advanceMissionRevision(missionId);
    this.pendingWrites.push({ event, stored });
    this.scheduleDrain();
    return event;
  }

  protected scheduleDrain(): void {
    const drain = this.emitChain.then(() => this.drainPending());
    // Background persistence must not create an unhandled rejection. The
    // failed head remains queued; flush() performs a retry and reports failure.
    this.emitChain = drain.catch(() => undefined);
  }

  protected async drainPending(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const pending = this.pendingWrites[0]!;
      try {
        await this.backend.append(pending.stored);
      } catch (error) {
        this.recordPersistenceFailure(pending.event, error);
        throw error;
      }
      this.pendingWrites.shift();
      this.clearPersistenceFailure(pending.event.event_id);
    }
  }

  protected recordPersistenceFailure(event: OrchestrationEvent, error: unknown): void {
    const diagnostic: MissionPersistenceDiagnostic = {
      eventId: event.event_id,
      eventType: event.type,
      missionId: event.mission_id,
      eventTimestamp: event.timestamp,
      message: persistenceErrorMessage(error),
    };
    const existing = this.persistenceErrors.findIndex((entry) => entry.eventId === event.event_id);
    if (existing >= 0) this.persistenceErrors[existing] = diagnostic;
    else this.persistenceErrors.push(diagnostic);
    if (this.persistenceErrors.length > MAX_PERSISTENCE_DIAGNOSTICS) this.persistenceErrors.shift();
  }

  protected clearPersistenceFailure(eventId: string): void {
    const index = this.persistenceErrors.findIndex((entry) => entry.eventId === eventId);
    if (index >= 0) this.persistenceErrors.splice(index, 1);
  }

  /** Await all pending event writes (so tests can assert durability). */
  async flush(): Promise<void> {
    await this.emitChain;
    if (this.pendingWrites.length === 0) return;

    const drain = this.drainPending();
    this.emitChain = drain.catch(() => undefined);
    await drain;
  }

  /** Recent persistence failures, oldest first. */
  persistenceDiagnostics(): MissionPersistenceDiagnostic[] {
    return this.persistenceErrors.map((diagnostic) => ({ ...diagnostic }));
  }

  protected apply(e: OrchestrationEvent): void {
    if (!ORCHESTRATION_EVENT_TYPES.has(e.type)) return;
    switch (e.type) {
      case "mission.created": {
        const p = e.payload.mission as Mission;
        if (p) this.missions.set(p.mission_id, copyMission(p));
        break;
      }
      case "mission.updated": {
        const idm = e.payload.mission_id as string;
        const patch = e.payload.patch as Partial<Mission>;
        const m = this.missions.get(idm);
        if (m && patch) {
          this.missions.set(idm, { ...m, ...patch, updated_at: e.timestamp });
          this.recordCanonical(idm, patch.status, e.payload);
        }
        break;
      }
      case "mission.completed":
      case "mission.failed": {
        const idm = e.payload.mission_id as string;
        const m = this.missions.get(idm);
        if (m) {
          m.status = e.type === "mission.completed" ? "COMPLETE" : "FAILED";
          m.completed_at = e.timestamp;
          m.updated_at = e.timestamp;
          if (e.payload.failure_reason) m.failure_reason = e.payload.failure_reason as string;
        }
        break;
      }
      case "task.created": {
        const p = e.payload.task as OrchestrationTask;
        if (p) {
          this.tasks.set(p.task_id, copyTask(p));
          const mission = this.missions.get(p.mission_id);
          if (mission && !mission.task_ids.includes(p.task_id)) {
            this.missions.set(mission.mission_id, {
              ...mission,
              task_ids: [...mission.task_ids, p.task_id],
              updated_at: p.created_at,
            });
          }
        }
        break;
      }
      case "task.ready":
      case "task.started":
      case "task.completed":
      case "task.failed":
      case "task.retried":
      case "task.canceled": {
        const tid = e.payload.task_id as string;
        const status = e.payload.status as TaskStatus;
        const t = this.tasks.get(tid);
        if (t) {
          t.status = status;
          if (status === "RUNNING") t.started_at = e.timestamp;
          if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED") t.completed_at = e.timestamp;
          if (e.payload.attempt !== undefined) t.attempt = e.payload.attempt as number;
          if (e.payload.assigned_execution_id !== undefined) {
            t.assigned_execution_id = e.payload.assigned_execution_id as string | null;
          }
          if (e.payload.failure_reason !== undefined) t.failure_reason = e.payload.failure_reason as string;
          this.tasks.set(tid, t);
        }
        break;
      }
      case "task.steered": {
        const tid = e.payload.task_id as string;
        const req = e.payload.request as string;
        const t = this.tasks.get(tid);
        if (t && req) {
          t.steer_requests.push(req);
          this.tasks.set(tid, t);
        }
        break;
      }
      case "task.authority_assigned": {
        const taskId = e.payload.task_id as string;
        const task = this.tasks.get(taskId);
        if (task) {
          task.mission_generation = e.payload.mission_generation as number;
          task.fencing_token = e.payload.fencing_token as number;
          if (e.payload.resumption_generation !== undefined) {
            task.resumption_generation = e.payload.resumption_generation as number;
          }
          if (e.payload.assigned_execution_id !== undefined) {
            task.assigned_execution_id = e.payload.assigned_execution_id as string;
          }
        }
        break;
      }
      case "execution.created":
      case "execution.started":
      case "execution.completed":
      case "execution.failed":
      case "execution.canceled": {
        if (e.payload.execution) {
          const ex = e.payload.execution as Execution;
          this.executions.set(ex.execution_id, copyExecution(ex));
          if (e.type === "execution.started") this.recordAuthoritativeExecutionStart(ex);
        } else {
          const xid = e.payload.execution_id as string;
          const status = e.payload.status as ExecutionStatus;
          const ex = this.executions.get(xid);
          if (ex) {
            ex.status = status;
            if (e.payload.exit_status !== undefined) ex.exit_status = e.payload.exit_status as string | null;
            if (e.payload.ended_at !== undefined) ex.ended_at = e.payload.ended_at as string | null;
            if (status === "RUNNING") ex.started_at = e.timestamp;
            this.executions.set(xid, ex);
          }
        }
        break;
      }
      case "execution.gate_evidence_published": {
        this.applyGateEvidencePublication(e.payload);
        break;
      }
      case "execution.late_result_rejected": {
        const execution = e.payload.execution as Execution | undefined;
        if (execution) {
          this.executions.set(execution.execution_id, copyExecution(execution));
          if (typeof e.payload.reason === "string" && LEGACY_AUTHORITY_LOSS.test(e.payload.reason))
            this.executionRejectionReasons.set(execution.execution_id, e.payload.reason);
        }
        break;
      }
      case "execution.orphaned":
      case "execution.reconciled": {
        const execution = e.payload.execution as Execution | undefined;
        if (execution) this.executions.set(execution.execution_id, copyExecution(execution));
        break;
      }
      case "finding.created": {
        const f = e.payload.finding as ReviewFinding;
        if (f) this.findings.set(f.finding_id, { ...f });
        break;
      }
      case "repository.wait": {
        const p = e.payload as {
          task_id: string;
          mission_id: string;
          repoId: string;
          holderMissionId: string;
          holderOwnerId: string;
        };
        this.repositoryWaits.set(p.task_id, {
          missionId: p.mission_id,
          repoId: p.repoId,
          holderMissionId: p.holderMissionId,
          holderOwnerId: p.holderOwnerId,
        });
        break;
      }
      case "repository.wait_cleared":
        this.repositoryWaits.delete(e.payload.task_id as string);
        break;
      case "finding.resolved": {
        const fid = e.payload.finding_id as string;
        const f = this.findings.get(fid);
        if (f) {
          f.status = "resolved";
          this.findings.set(fid, f);
        }
        break;
      }
      case "workspace.authorized":
      case "workspace.rebound": {
        const manifest = e.payload.manifest as WorkspaceManifest;
        if (manifest) this.workspaceManifests.set(manifest.missionId, copyWorkspaceManifest(manifest));
        break;
      }
      case "handoff.created":
      case "handoff.transitioned": {
        const handoff = e.payload.handoff as HandoffRecord | undefined;
        if (handoff?.id) this.handoffRecords.set(handoff.id, { ...handoff });
        break;
      }
      case "task.checkpointed": {
        const checkpoint = e.payload.checkpoint as TaskCheckpoint;
        if (checkpoint) this.recordTaskCheckpoint(checkpoint);
        break;
      }
      case "failure.classified": {
        const classification = e.payload.classification as FailureClassification;
        if (classification) {
          this.failureClassifications.set(classification.classificationId, copyFailureClassification(classification));
        }
        break;
      }
      case "recovery.planned":
      case "recovery.started":
      case "recovery.succeeded":
      case "recovery.failed":
      case "recovery.exhausted": {
        const decision = e.payload.decision as RecoveryDecision;
        if (decision) this.recoveryDecisions.set(decision.recoveryId, { ...decision });
        const missionPatch = e.payload.mission_patch as Partial<Mission> | undefined;
        if (decision && missionPatch) {
          const mission = this.missions.get(decision.missionId);
          if (mission) {
            this.missions.set(decision.missionId, {
              ...mission,
              ...missionPatch,
            });
            this.recordCanonical(decision.missionId, missionPatch.status, e.payload);
          }
        }
        break;
      }
      case "task.superseded": {
        const supersession = e.payload.supersession as TaskSupersession;
        if (supersession) {
          this.taskSupersessions.set(supersession.supersessionId, copyTaskSupersession(supersession));
        }
        break;
      }
      case "evidence.invalidated": {
        const invalidation = e.payload.invalidation as EvidenceInvalidation;
        if (invalidation) {
          this.evidenceInvalidations.set(invalidation.invalidationId, copyEvidenceInvalidation(invalidation));
        }
        break;
      }
      case "github.link_recorded": {
        const link = e.payload.link as GithubLinkRecord | undefined;
        if (link?.linkId) this.githubLinks.set(link.linkId, structuredClone(link));
        break;
      }
      case "github.link_suggested": {
        const suggestion = e.payload.suggestion as GithubLinkSuggestion | undefined;
        if (suggestion?.suggestionId && !this.githubSuggestions.has(suggestion.suggestionId)) {
          this.githubSuggestions.set(suggestion.suggestionId, structuredClone(suggestion));
        }
        break;
      }
      case "github.suggestion_resolved": {
        const existing = this.githubSuggestions.get(String(e.payload.suggestionId));
        const resolution = e.payload.resolution;
        if (existing && (resolution === "confirmed" || resolution === "dismissed")) existing.state = resolution;
        break;
      }
      case "github.link_corrected": {
        const existing = this.githubLinks.get(String(e.payload.linkId));
        const patch = e.payload.patch as GithubLinkPatch | undefined;
        if (existing && patch) this.githubLinks.set(existing.linkId, applyGithubLinkPatch(existing, patch));
        break;
      }
      case "github.evidence_stale": {
        const signal = e.payload.signal as GithubStaleSignal | undefined;
        if (signal?.signalId) this.githubStaleSignals.set(signal.signalId, structuredClone(signal));
        break;
      }
      case "github.gate_decided": {
        const g = e.payload.gate as GithubGateDecision | undefined;
        if (g?.target) this.githubGates.set(g.target, structuredClone(g));
        break;
      }
      case "dag.projected": {
        const d = e.payload.projection as DagProjection | undefined;
        if (d?.missionId) this.dagProjections.set(d.missionId, structuredClone(d));
        break;
      }
      case "github.rereview_requested": {
        const request = e.payload.request as GithubRereviewRequest | undefined;
        if (request?.signalId) this.githubRereviews.set(request.signalId, structuredClone(request));
        break;
      }
      case "candidate.changed": {
        const candidate = e.payload.candidate as CandidateRevision;
        if (candidate) {
          try {
            const identity = this.assertCandidateIdentity(
              candidate.missionId,
              candidate.identity,
              candidate.identityHash,
            );
            if (candidate.reconstructedFrom) {
              // A reconstructed candidate (#360) is anchored to a preserved
              // checkpoint rather than to a SUCCEEDED authoritative execution —
              // the producing execution deliberately FAILED before publishing.
              // Validate the checkpoint trust anchor instead of the
              // SUCCEEDED-execution provenance (mirrors recordReconstructedCandidate).
              this.assertReconstructedCandidateProvenance(candidate.missionId, identity, candidate.reconstructedFrom);
            } else {
              this.assertCandidateProvenance(candidate.missionId, identity, candidate.taskId, candidate.executionId);
            }
            this.assertUnusedCandidateExecution(candidate.executionId);
            this.candidates.set(
              candidateKey(candidate.missionId, identity.repoId),
              copyCandidateRevision({ ...candidate, identity }),
            );
            this.candidateExecutionIds.add(candidate.executionId);
          } catch (error) {
            this.quarantineEvidence(candidate.missionId, error);
          }
        }
        break;
      }
      case "evidence.validation_recorded": {
        const evidence = e.payload.evidence as ValidationEvidence;
        if (evidence) {
          try {
            this.assertValidationEvidence(evidence);
            this.assertUnusedEvidenceExecution(evidence.executionId, this.validationEvidence.values());
            this.validationEvidence.set(evidence.evidenceId, copyValidationEvidence(evidence));
          } catch (error) {
            this.quarantineEvidence(evidence.missionId, error);
          }
        }
        break;
      }
      case "evidence.review_recorded": {
        const evidence = e.payload.evidence as ReviewEvidence;
        if (evidence) {
          try {
            this.assertReviewEvidence(evidence);
            this.assertUnusedEvidenceExecution(evidence.executionId, this.reviewEvidence.values());
            this.reviewEvidence.set(evidence.evidenceId, copyReviewEvidence(evidence));
          } catch (error) {
            this.quarantineEvidence(evidence.missionId, error);
          }
        }
        break;
      }
      case "lease.acquired":
      case "lease.renewed":
      case "lease.expired":
      case "lease.fenced": {
        const scope = e.payload.scope as "mission" | "repository";
        const transition = e.type.slice("lease.".length) as LeaseTransition;
        if (scope === "mission") {
          const lease = e.payload.lease as MissionLease;
          if (lease) {
            this.missionLeaseEpochs.set(lease.missionId, { ...lease });
            if (transition === "expired" || transition === "fenced") this.missionLeases.delete(lease.missionId);
            else this.missionLeases.set(lease.missionId, { ...lease });
          }
        } else if (scope === "repository") {
          const lease = e.payload.lease as RepositoryLease;
          if (lease) {
            this.repositoryLeaseEpochs.set(lease.repoId, { ...lease });
            if (transition === "expired" || transition === "fenced") this.repositoryLeases.delete(lease.repoId);
            else this.repositoryLeases.set(lease.repoId, { ...lease });
          }
        }
        break;
      }
      case "mission.resumed": {
        const resumption = e.payload.resumption as MissionResumption;
        if (resumption) {
          this.missionResumptions.push({ ...resumption });
          const selectedModel = e.payload.selectedModel as OperatorModelPin | undefined;
          const mission = this.missions.get(resumption.missionId);
          if (selectedModel && mission) {
            mission.operator_model_pin = { ...selectedModel };
            mission.operator_model_decided_at = selectedModel.set_at;
          }
        }
        break;
      }
      case "mission.stopped": {
        const stop = e.payload.stop as MissionStop;
        if (stop) this.missionStops.push(copyMissionStop(stop));
        break;
      }
      case "mission.disk_suspend_marked": {
        const episode = e.payload.episode as DiskSuspendEpisode | undefined;
        if (!episode) break;
        // A merge re-emits the full episode under the same id: replay upserts,
        // so the durable history is idempotent like the live projection.
        const at = this.diskSuspendEpisodes.findIndex((entry) => entry.episodeId === episode.episodeId);
        if (at >= 0) this.diskSuspendEpisodes[at] = structuredClone(episode);
        else this.diskSuspendEpisodes.push(structuredClone(episode));
        break;
      }
      case "mission.disk_suspend_resolved": {
        const resolved = e.payload as { episodeId?: string; missionId?: string; resolvedAt?: string };
        if (resolved.episodeId) {
          const episode = this.diskSuspendEpisodes.find((entry) => entry.episodeId === resolved.episodeId);
          if (episode) episode.resolvedAt = resolved.resolvedAt ?? new Date(0).toISOString();
        } else if (resolved.missionId) {
          // Resolve-any is a coarse operator fallback; newest open episode wins.
          const episode = [...this.diskSuspendEpisodes]
            .reverse()
            .find((entry) => entry.missionId === resolved.missionId && entry.resolvedAt === null);
          if (episode) episode.resolvedAt = resolved.resolvedAt ?? new Date(0).toISOString();
        }
        break;
      }
      case "spec.stage": {
        const stage = e.payload.stage as import("./specApproval.ts").SpecStageAttempt;
        if (stage) this.specStages.push({ ...stage });
        break;
      }
      case "plan.revision": {
        const record = e.payload.record as import("./planRecords.ts").PlanRevisionRecord | undefined;
        if (record) this.planRevisions.push(structuredClone(record));
        break;
      }
      case "plan.policy": {
        const record = e.payload.record as import("./planRecords.ts").PlanPolicyRecord | undefined;
        if (record) this.planPolicies.push(structuredClone(record));
        break;
      }
      case "plan.decision": {
        const record = e.payload.record as import("./planRecords.ts").PlanDecisionRecord | undefined;
        if (record) this.planDecisions.push(structuredClone(record));
        break;
      }
      case "spec.revision": {
        const revision = e.payload.revision as import("./specApproval.ts").MissionSpecRevision;
        if (revision) this.specRevisions.set(revision.revisionId, structuredClone(revision));
        break;
      }
      case "spec.review": {
        const review = e.payload.review as import("./specApproval.ts").SpecReviewEvidence;
        if (review) this.specReviews.set(review.reviewId, structuredClone(review));
        break;
      }
      case "spec.approval": {
        const approval = e.payload.approval as import("./specApproval.ts").SpecApproval;
        if (approval) this.specApprovals.set(approval.missionId, structuredClone(approval));
        break;
      }
      case "spec.invalidation": {
        const invalidation = e.payload.invalidation as {
          missionId: string;
          approvalId: string;
          reason: string;
          fencingToken: number;
        };
        if (invalidation) this.specInvalidations.set(invalidation.missionId, invalidation);
        break;
      }
      case "spec.materialized": {
        const materialization = e.payload.materialization as {
          missionId: string;
          approvalId: string;
          semanticSpecHash: string;
          created: string[];
          reused: string[];
        };
        if (materialization) this.specMaterializations.push(materialization);
        break;
      }
    }
    this.advanceMissionRevision(e.mission_id);
  }

  /** Remember the canonical image a transition event carried, if it carried one. */
  protected recordCanonical(
    missionId: string,
    status: MissionStatus | undefined,
    payload: Record<string, unknown>,
  ): void {
    if (!status) return;
    const canonicalState = payload.canonicalState;
    const version = payload.lifecycleSchemaVersion;
    if (typeof canonicalState !== "string" || typeof version !== "number") return;
    this.canonicalRecords.set(missionId, {
      status,
      canonicalState: canonicalState as CanonicalLifecycleState,
      lifecycleSchemaVersion: version,
    });
  }

  /**
   * The mission's canonical lifecycle state (R-LIFE). The recorded image wins
   * while it still describes the current status; otherwise (a journal from
   * before the field, or a status changed by a path that records none) it is
   * derived from the status. Derived values are never written back.
   */
  getCanonicalLifecycle(missionId: string): CanonicalLifecycle | undefined {
    const mission = this.missions.get(missionId);
    if (!mission) return undefined;
    const recorded = this.canonicalRecords.get(missionId);
    if (recorded && recorded.status === mission.status) {
      return { canonicalState: recorded.canonicalState, lifecycleSchemaVersion: recorded.lifecycleSchemaVersion };
    }
    return { canonicalState: toCanonical(mission.status), lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION };
  }

  protected advanceMissionRevision(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) return;
    mission.revision = (mission.revision ?? 0) + 1;
  }

  // Members implemented by later layers of the MissionStore class chain.
  protected abstract applyGateEvidencePublication(payload: Record<string, unknown>): void;
  protected abstract applyLeaseTransition(
    transition: LeaseTransition,
    scope: "mission" | "repository",
    lease: MissionLease | RepositoryLease,
  ): void;
  protected abstract assertCandidateIdentity(
    missionId: string,
    raw: CandidateEvidenceIdentity,
    identityHash: string,
  ): CandidateEvidenceIdentity;
  protected abstract assertCandidateProvenance(
    missionId: string,
    identity: CandidateEvidenceIdentity,
    taskId?: string,
    executionId?: string,
  ): void;
  protected abstract assertReconstructedCandidateProvenance(
    missionId: string,
    identity: CandidateEvidenceIdentity,
    source: ReconstructedCandidateSource,
  ): void;
  protected abstract assertReviewEvidence(raw: ReviewEvidence): void;
  protected abstract assertSettledExecutionIdentity(
    task: OrchestrationTask,
    execution: Execution,
    identity: CandidateEvidenceIdentity,
    backend?: "validation" | "review",
  ): void;
  protected abstract assertUnusedCandidateExecution(executionId: string): void;
  protected abstract assertUnusedEvidenceExecution<T extends { executionId: string }>(
    executionId: string,
    existing: IterableIterator<T>,
  ): void;
  protected abstract assertValidationEvidence(raw: ValidationEvidence): void;
  protected abstract freshEvidenceTimestamp(raw: {
    missionId: string;
    identityHash: string;
    recordedAt: string;
  }): string;
  abstract getFailureClassification(classificationId: string): FailureClassification | undefined;
  protected abstract invalidateCurrentCandidate(missionId: string, reason: string): void;
  abstract listFailureClassifications(missionId?: string): FailureClassification[];
  abstract listMissionResumptions(missionId?: string): MissionResumption[];
  abstract listMissionStops(missionId?: string): MissionStop[];
  abstract listRecoveryDecisions(missionId?: string): RecoveryDecision[];
  abstract listTaskSupersessions(missionId?: string): TaskSupersession[];
  protected abstract quarantineEvidence(missionId: string, error: unknown): void;
  protected abstract recordAuthoritativeExecutionStart(execution: Execution): void;
  protected abstract recordTaskCheckpoint(checkpoint: TaskCheckpoint): void;
  abstract transitionHandoffRecord(
    id: string,
    to: HandoffState,
    successor?: HandoffEndpoint,
    ackAt?: string,
  ): HandoffRecord;
}
