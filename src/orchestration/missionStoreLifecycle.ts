/**
 * MissionStore layer: External sync, resume/stop fences, plan and spec records.
 * Moved verbatim out of missionStore.ts; composed by inheritance (state lives in
 * MissionStoreBase, `private` members became `protected` so layers can share them).
 */

import { id } from "../core/ids.ts";
import type { EventStoreBackend, StoredEvent } from "../platform/eventstore/backend.ts";
import { MissionStore } from "./missionStore.ts";
import { copyMissionStop, settlementIdentityMatches } from "./missionStoreCopy.ts";
import { MissionStoreEvidence } from "./missionStoreEvidence.ts";
import { type MissionRevisionFence, type OrchestrationEvent, fromStored } from "./missionStoreTypes.ts";
import type {
  LeaseTransition,
  Mission,
  MissionLease,
  MissionResumption,
  MissionStop,
  OperatorModelPin,
  RepositoryLease,
} from "./types.ts";

export abstract class MissionStoreLifecycle extends MissionStoreEvidence {
  /**
   * Apply events other sessions appended to this namespace since the last
   * read (per-session streams). A no-op for single-stream backends. Returns how
   * many events were applied.
   */
  syncExternal(): number {
    const backend = this.backend as EventStoreBackend & { refresh?: () => StoredEvent[] };
    const fresh = backend.refresh?.() ?? [];
    for (const event of fresh) this.apply(fromStored(event));
    return fresh.length;
  }

  /**
   * Resolve a mission for a MUTATION, applying what other sessions appended to
   * this namespace first (#427).
   *
   * The live projection is not the authority — the appended events are. Observed
   * on a shared dev box: `mission status/resume MSN-J9sycT` answered "Unknown
   * mission" from the session that had just run it, while the per-session streams
   * replayed that mission perfectly. A mutation path that declares a mission
   * unknown without this re-read strands work the durable log still describes.
   *
   * Deliberately not used by ordinary reads: `refresh()` re-scans stream files,
   * so hot read paths keep the projection and the tool layer's cached durable
   * lookup instead.
   */
  resolveMission(missionId: string): Mission | undefined {
    const known = this.getMission(missionId);
    if (known) return known;
    this.syncExternal();
    return this.getMission(missionId);
  }

  /** Local takeover is permitted only while this process owns the JSONL writer boundary. */
  hasExclusiveWriterAuthority(): boolean {
    const backend = this.backend as EventStoreBackend & {
      ownsWriterLock?: () => boolean;
    };
    return backend.ownsWriterLock?.() ?? false;
  }

  protected applyLeaseTransition(
    transition: LeaseTransition,
    scope: "mission" | "repository",
    lease: MissionLease | RepositoryLease,
  ): void {
    if (!this.missions.has(lease.missionId)) throw new Error(`unknown mission ${lease.missionId}`);
    if (scope === "mission") {
      const prior = this.missionLeaseEpochs.get(lease.missionId);
      if (prior && prior.generation !== lease.generation) {
        this.invalidateCurrentCandidate(lease.missionId, "mission generation changed");
      }
      this.missionLeaseEpochs.set(lease.missionId, { ...lease });
      if (transition === "expired" || transition === "fenced") this.missionLeases.delete(lease.missionId);
      else this.missionLeases.set(lease.missionId, { ...lease });
    } else {
      const repositoryLease = lease as RepositoryLease;
      this.repositoryLeaseEpochs.set(repositoryLease.repoId, {
        ...repositoryLease,
      });
      if (transition === "expired" || transition === "fenced") this.repositoryLeases.delete(repositoryLease.repoId);
      else
        this.repositoryLeases.set(repositoryLease.repoId, {
          ...repositoryLease,
        });
    }
    this.emit(`lease.${transition}`, lease.missionId, {
      actor: "system",
      scope,
      lease,
    });
  }

  resumeMission(missionId: string, reason: string): MissionResumption {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const currentLease = this.missionLeases.get(missionId);
    if (currentLease) {
      this.applyLeaseTransition("fenced", "mission", currentLease);
      for (const repository of this.listRepositoryLeases(missionId)) {
        this.applyLeaseTransition("fenced", "repository", repository);
      }
    }
    const resumption = {
      missionId,
      reason,
      resumedAt: new Date().toISOString(),
      generation: (this.listMissionResumptions(missionId).at(-1)?.generation ?? 0) + 1,
      stopGeneration: this.listMissionStops(missionId).at(-1)?.generation ?? 0,
    };
    this.missionResumptions.push(resumption);
    this.emit("mission.resumed", missionId, { actor: "system", resumption });
    return { ...resumption };
  }

  /** Conditional automatic resumption; operator intent is checked at the durable append boundary. */
  resumeMissionIfCurrent(
    missionId: string,
    reason: string,
    expected: MissionRevisionFence,
    selectedModel?: OperatorModelPin,
    canResume?: () => boolean,
  ): Promise<MissionResumption | undefined> {
    const operationKey = JSON.stringify([
      missionId,
      expected.revision,
      expected.status,
      expected.blockedEpisodeId,
      expected.resumptionGeneration,
    ]);
    const eligible = (store: MissionStore): boolean => {
      const mission = store.getMission(missionId);
      return (
        store.matchesMissionFence(missionId, expected) &&
        (!canResume || canResume()) &&
        (!selectedModel || !store.listExecutions(missionId).some((execution) => execution.status === "RUNNING")) &&
        !mission?.operator_paused_at &&
        !["WAITING_FOR_USER", "NEEDS_ATTENTION", "CANCELING"].includes(mission?.status ?? "") &&
        !store
          .listRecoveryDecisions(missionId)
          .some(
            (decision) =>
              (decision.resumptionGeneration ?? 0) === expected.resumptionGeneration &&
              decision.action === "WAIT_FOR_REQUIREMENT" &&
              ["planned", "started"].includes(decision.status),
          )
      );
    };
    const settle = this.emitChain.then(async () => {
      await this.drainPending();
      const durable = MissionStore.open(this.backend);
      if (!eligible(durable)) {
        for (const eventId of this.resumptionWriteFailures.get(operationKey) ?? [])
          this.clearPersistenceFailure(eventId);
        this.resumptionWriteFailures.delete(operationKey);
        return undefined;
      }
      if (!eligible(this)) return undefined;
      const resumption: MissionResumption = {
        missionId,
        reason,
        resumedAt: new Date().toISOString(),
        generation: expected.resumptionGeneration + 1,
        stopGeneration: durable.listMissionStops(missionId).at(-1)?.generation ?? 0,
      };
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: missionId,
        timestamp: resumption.resumedAt,
        type: "mission.resumed",
        actor: "system",
        payload: { actor: "system", resumption, ...(selectedModel ? { selectedModel } : {}) },
      };
      try {
        const appended = await this.backend.appendConditionally(
          {
            event_id: event.event_id,
            timestamp: event.timestamp,
            type: event.type,
            project_id: null,
            run_id: missionId,
            worker_id: null,
            payload: event.payload,
          },
          () => eligible(this) && eligible(MissionStore.open(this.backend)),
          () => this.apply(event),
        );
        if (appended) {
          for (const eventId of this.resumptionWriteFailures.get(operationKey) ?? [])
            this.clearPersistenceFailure(eventId);
          this.resumptionWriteFailures.delete(operationKey);
          return { ...resumption };
        }
        return undefined;
      } catch (error) {
        const failed = this.resumptionWriteFailures.get(operationKey) ?? new Set<string>();
        failed.add(event.event_id);
        this.resumptionWriteFailures.set(operationKey, failed);
        this.recordPersistenceFailure(event, error);
        throw error;
      }
    });
    this.emitChain = settle.then(
      () => undefined,
      () => undefined,
    );
    return settle;
  }

  listMissionResumptions(missionId?: string): MissionResumption[] {
    return this.missionResumptions
      .filter((resumption) => (missionId ? resumption.missionId === missionId : true))
      .map((resumption) => ({ ...resumption }));
  }

  stopMission(
    missionId: string,
    input: Omit<
      MissionStop,
      | "missionId"
      | "stoppedAt"
      | "generation"
      | "resumptionGeneration"
      | "blockedEpisodeId"
      | "recoveryDeadline"
      | "settlementIdentity"
    >,
  ): MissionStop {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`unknown mission ${missionId}`);
    const resumptionGeneration = this.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
    const deadlines = this.listRecoveryDecisions(missionId)
      .filter((decision) => (decision.resumptionGeneration ?? 0) === resumptionGeneration)
      .flatMap((decision) => (decision.deadline ? [decision.deadline] : []))
      .filter((deadline) => Number.isFinite(Date.parse(deadline)))
      .sort();
    const stop: MissionStop = {
      missionId,
      reason: input.reason,
      preservedWork: [...input.preservedWork],
      attemptedRecoveries: [...input.attemptedRecoveries],
      resumeCondition: input.resumeCondition,
      // #418: the queue state observed at park time rides with the stop, so a
      // mission parked hours ago can still tell the operator what the gateway said.
      ...(input.queue ? { queue: { ...input.queue } } : {}),
      stoppedAt: new Date().toISOString(),
      generation: (this.listMissionStops(missionId).at(-1)?.generation ?? 0) + 1,
      resumptionGeneration,
      blockedEpisodeId: mission.blocked_episode_id ?? null,
      recoveryDeadline: deadlines[0] ?? null,
    };
    this.missionStops.push(stop);
    this.emit("mission.stopped", missionId, { actor: "system", stop });
    return copyMissionStop(stop);
  }

  /** Settle an exact durable mission snapshot once across every store sharing the backend. */
  stopMissionIfCurrent(
    missionId: string,
    input: Omit<
      MissionStop,
      | "missionId"
      | "stoppedAt"
      | "generation"
      | "resumptionGeneration"
      | "blockedEpisodeId"
      | "recoveryDeadline"
      | "settlementIdentity"
    >,
    expected: MissionRevisionFence,
  ): Promise<MissionStop | undefined> {
    const settle = this.emitChain.then(async () => {
      await this.drainPending();

      const durableBefore = MissionStore.open(this.backend);
      const existingBefore = durableBefore.currentStopForGeneration(missionId, expected.resumptionGeneration);
      if (existingBefore) {
        return settlementIdentityMatches(existingBefore.settlementIdentity, expected)
          ? copyMissionStop(existingBefore)
          : undefined;
      }
      if (!durableBefore.matchesMissionFence(missionId, expected)) return undefined;

      const deadlines = durableBefore
        .listRecoveryDecisions(missionId)
        .filter((decision) => (decision.resumptionGeneration ?? 0) === expected.resumptionGeneration)
        .flatMap((decision) => (decision.deadline ? [decision.deadline] : []))
        .filter((deadline) => Number.isFinite(Date.parse(deadline)))
        .sort();
      const stop: MissionStop = {
        missionId,
        reason: input.reason,
        preservedWork: [...input.preservedWork],
        attemptedRecoveries: [...input.attemptedRecoveries],
        resumeCondition: input.resumeCondition,
        ...(input.queue ? { queue: { ...input.queue } } : {}),
        stoppedAt: new Date().toISOString(),
        generation: (durableBefore.listMissionStops(missionId).at(-1)?.generation ?? 0) + 1,
        resumptionGeneration: expected.resumptionGeneration,
        blockedEpisodeId: expected.blockedEpisodeId,
        recoveryDeadline: deadlines[0] ?? null,
        settlementIdentity: { ...expected },
      };
      const payload = structuredClone({ actor: "system", stop });
      const event: OrchestrationEvent = {
        event_id: id("oevt"),
        mission_id: missionId,
        timestamp: stop.stoppedAt,
        type: "mission.stopped",
        actor: "system",
        payload,
      };
      const stored: StoredEvent = {
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.type,
        project_id: null,
        run_id: missionId,
        worker_id: null,
        payload,
      };
      let committedByAnotherStore: MissionStop | undefined;
      let appended: StoredEvent | undefined;
      try {
        appended = await this.backend.appendConditionally(
          stored,
          () => {
            const durableCurrent = MissionStore.open(this.backend);
            const existing = durableCurrent.currentStopForGeneration(missionId, expected.resumptionGeneration);
            if (existing) {
              if (settlementIdentityMatches(existing.settlementIdentity, expected)) {
                committedByAnotherStore = existing;
              }
              return false;
            }
            return durableCurrent.matchesMissionFence(missionId, expected);
          },
          () => this.apply(event),
        );
      } catch (error) {
        this.recordPersistenceFailure(event, error);
        throw error;
      }
      if (appended) {
        this.clearPersistenceFailure(event.event_id);
        return copyMissionStop(stop);
      }
      return committedByAnotherStore ? copyMissionStop(committedByAnotherStore) : undefined;
    });
    this.emitChain = settle.then(
      () => undefined,
      () => undefined,
    );
    return settle;
  }

  protected currentStopForGeneration(missionId: string, resumptionGeneration: number): MissionStop | undefined {
    return this.missionStops
      .filter((stop) => stop.missionId === missionId && stop.resumptionGeneration === resumptionGeneration)
      .at(-1);
  }

  protected matchesMissionFence(missionId: string, expected: MissionRevisionFence): boolean {
    const mission = this.missions.get(missionId);
    const currentGeneration =
      this.missionResumptions.filter((resumption) => resumption.missionId === missionId).at(-1)?.generation ?? 0;
    return (
      !!mission &&
      !["COMPLETE", "FAILED", "CANCELED"].includes(mission.status) &&
      currentGeneration === expected.resumptionGeneration &&
      mission.revision === expected.revision &&
      mission.status === expected.status &&
      (mission.blocked_episode_id ?? null) === expected.blockedEpisodeId
    );
  }

  listMissionStops(missionId?: string): MissionStop[] {
    return this.missionStops.filter((stop) => (missionId ? stop.missionId === missionId : true)).map(copyMissionStop);
  }

  // ── Autonomous spec approval records ────────────────────────────────────

  // ── Plan revisions, review policy and decisions (T03) ─────────────────

  appendPlanRevision(record: import("./planRecords.ts").PlanRevisionRecord): void {
    this.apply(this.emit("plan.revision", record.missionId, { actor: "system", record }));
  }

  appendPlanPolicy(record: import("./planRecords.ts").PlanPolicyRecord): void {
    this.apply(this.emit("plan.policy", record.missionId, { actor: "system", record }));
  }

  appendPlanDecision(record: import("./planRecords.ts").PlanDecisionRecord): void {
    this.apply(this.emit("plan.decision", record.missionId, { actor: "system", record }));
  }

  listPlanRevisions(missionId: string): import("./planRecords.ts").PlanRevisionRecord[] {
    return this.planRevisions.filter((r) => r.missionId === missionId).map((r) => structuredClone(r));
  }

  listPlanPolicies(missionId: string): import("./planRecords.ts").PlanPolicyRecord[] {
    return this.planPolicies.filter((r) => r.missionId === missionId).map((r) => structuredClone(r));
  }

  listPlanDecisions(missionId: string): import("./planRecords.ts").PlanDecisionRecord[] {
    return this.planDecisions.filter((r) => r.missionId === missionId).map((r) => structuredClone(r));
  }

  appendSpecStage(stage: import("./specApproval.ts").SpecStageAttempt): void {
    this.apply(this.emit("spec.stage", stage.missionId, { actor: "system", stage }));
  }

  appendSpecRevision(revision: import("./specApproval.ts").MissionSpecRevision): void {
    this.apply(this.emit("spec.revision", revision.missionId, { actor: "system", revision }));
  }

  appendSpecReview(review: import("./specApproval.ts").SpecReviewEvidence): void {
    this.apply(this.emit("spec.review", review.missionId, { actor: "system", review }));
  }

  appendSpecApproval(approval: import("./specApproval.ts").SpecApproval): void {
    this.apply(this.emit("spec.approval", approval.missionId, { actor: "system", approval }));
  }

  /** Durable invalidation event carrying the prior approval ID + new fencing identity. */
  invalidateSpecApproval(missionId: string, approvalId: string, reason: string, fencingToken: number): void {
    this.apply(
      this.emit("spec.invalidation", missionId, {
        actor: "system",
        invalidation: { missionId, approvalId, reason, fencingToken },
      }),
    );
  }

  appendSpecMaterialization(
    missionId: string,
    approvalId: string,
    semanticSpecHash: string,
    created: string[],
    reused: string[],
  ): void {
    this.apply(
      this.emit("spec.materialized", missionId, {
        actor: "system",
        materialization: { missionId, approvalId, semanticSpecHash, created, reused },
      }),
    );
  }

  getSpecRevision(missionId: string): import("./specApproval.ts").MissionSpecRevision | null {
    let latest: import("./specApproval.ts").MissionSpecRevision | null = null;
    for (const revision of this.specRevisions.values()) {
      if (revision.missionId !== missionId) continue;
      if (!latest || revision.revisionNumber > latest.revisionNumber) latest = revision;
    }
    return latest ? structuredClone(latest) : null;
  }

  getSpecReview(missionId: string): import("./specApproval.ts").SpecReviewEvidence | null {
    let latest: import("./specApproval.ts").SpecReviewEvidence | null = null;
    for (const review of this.specReviews.values()) {
      if (review.missionId !== missionId) continue;
      if (!latest || review.reviewedAt > latest.reviewedAt) latest = review;
    }
    return latest ? structuredClone(latest) : null;
  }

  getSpecApproval(missionId: string): import("./specApproval.ts").SpecApproval | null {
    const approval = this.specApprovals.get(missionId);
    return approval ? structuredClone(approval) : null;
  }

  listSpecStages(missionId: string): import("./specApproval.ts").SpecStageAttempt[] {
    return this.specStages.filter((stage) => stage.missionId === missionId).map((stage) => ({ ...stage }));
  }

  getSpecInvalidation(missionId: string): { approvalId: string; reason: string; fencingToken: number } | null {
    const invalidation = this.specInvalidations.get(missionId);
    return invalidation ? { ...invalidation } : null;
  }

  listSpecMaterializations(missionId: string): Array<{
    approvalId: string;
    semanticSpecHash: string;
    created: string[];
    reused: string[];
  }> {
    return this.specMaterializations
      .filter((materialization) => materialization.missionId === missionId)
      .map((materialization) => ({
        approvalId: materialization.approvalId,
        semanticSpecHash: materialization.semanticSpecHash,
        created: [...materialization.created],
        reused: [...materialization.reused],
      }));
  }
}
