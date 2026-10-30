/**
 * The production caller of the verify-before-revoke handoff protocol.
 *
 * A handoff record created by a context-pressure, quota or phase trigger (contextHandoffTrigger.ts) names the
 * predecessor worker session and a checkpoint SHA. This driver finds that checkpoint, then runs `executeHandoff`:
 *
 *   verify the checkpoint -> fence the source writer (execution authority + its registered process groups) -> acknowledge
 *
 * through the runtime's existing seams only: `MissionStore.verifyHandoff / fenceHandoffSource / acknowledgeHandoff`
 * for the state, `fenceExecutionWriter` for the execution's authority, and `ExecutionBroker.quarantineExecution` for
 * the processes (only the groups its tools registered). It is idempotent and resumable: every call re-reads the durable
 * record, so a crash between any two stages is recovered by driving the record again (`resumeOpen`), and a duplicate
 * trigger coalesces onto the flight already running for that record.
 *
 * Fence scope: the source WRITER (the execution), not the mission lease. The mission lease belongs to the runtime
 * that is driving the mission and orchestrating this very handoff; fencing it would stop the orchestrator, not the
 * source. (`fenceMissionLease` remains available for a host-level handoff that does hand the whole mission over.)
 *
 * Successor: acknowledgement needs a session that has actually taken over. When one already exists (a later
 * execution of the same task under another session) it is passed to `executeHandoff`; otherwise the record stops at
 * `sourceFencedAt` and is acknowledged either by a later drive or by the observed rollover, which is gated on those
 * stamps (MissionStore.acknowledgeObservedHandoffs). Never inferred, never invented.
 *
 * Quota switch: a `quota_exhausted` record that carries `toModel` (a model the operator listed under engineering.yaml
 * `quota_fallbacks`) switches the TASK's model durably after verification and before the source is fenced
 * (MissionStore.switchTaskModel, idempotent); the scheduler's ordinary retry of the fenced task then asks for that model
 * through `execution_requirements.model` and starts from the verified checkpoint. Only an execution on `toModel`
 * acknowledges. A record with `blockedReason` (no fallback configured/eligible) is never driven: the source is untouched.
 *
 * Records without a checkpoint SHA have nothing to verify and are not driven: they keep the legacy direct
 * `acknowledgeHandoff` path.
 *
 * Phase boundary (`phase_transition`): the predecessor is the orchestrating session. The boundary first writes a real
 * checkpoint of the orchestration state (CheckpointManager.persistPhaseBoundary, scope "orchestrator", read only
 * through MissionStore.listOrchestratorCheckpoints) and the record names its SHA, so the same verify -> fence ->
 * acknowledge path runs. What "fence" means here is a DECISION: the orchestrator must not stop itself from running the
 * handoff, so it is never fenced and neither is the mission lease; only the PREVIOUS phase's worker authority is
 * revoked, i.e. executions still RUNNING that started strictly before the record was created (stragglers of the
 * finished phase: writer authority plus their registered process groups). A worker the next phase started after the
 * boundary is not touched. The successor is the orchestrating session itself entering the next phase one generation
 * later (a phase may start no agent session at all), driven at the moment that phase begins.
 */

import { DEFAULT_CONTEXT_THRESHOLDS } from "../context/thresholds.ts";
import type { HandoffRecord } from "../runtime/host/handoffKinds.ts";
import { sameModel } from "../runtime/host/quotaResume.ts";
import {
  type HandoffOutcome,
  type HandoffVerifyDeps,
  composeFences,
  createHandoffVerifyDeps,
  executeHandoff,
  fenceExecutionWriter,
} from "./handoffProtocol.ts";
import type { MissionStore } from "./missionStore.ts";
import type { TaskCheckpoint } from "./types.ts";

export type DriveResult =
  | { status: HandoffOutcome["status"]; record: HandoffRecord }
  | { status: "skipped"; reason: string };

export interface HandoffDriverDeps {
  store: MissionStore;
  /** Terminates the process groups an execution's tools registered. */
  quarantineExecution(executionId: string): Promise<void>;
  report(missionId: string, line: string): void;
  artifacts?: { readContentByUri(uri: string): Promise<string | undefined> };
  /** Verification dependencies; defaults to the production ones (artifact store + the worktree's own repository). */
  verifyDeps?: HandoffVerifyDeps;
  /** The phase a mission was in at an instant (ISO), or null when unknown (e.g. after a restart). */
  phaseAt?(missionId: string, atIso: string): string | null;
  /** Mission context utilization and the configured pressure level; they only pick the fallback after a rejection. */
  utilization?(missionId: string): number | null;
  pressureThreshold?(): number | undefined;
}

export class HandoffDriver {
  private readonly deps: HandoffDriverDeps;
  private readonly flights = new Map<string, Promise<DriveResult>>();

  constructor(deps: HandoffDriverDeps) {
    this.deps = deps;
  }

  /** Drive one record as far as the evidence allows. Concurrent calls for one record share a single flight. */
  drive(handoffId: string): Promise<DriveResult> {
    const running = this.flights.get(handoffId);
    if (running) return running;
    const flight = this.run(handoffId)
      .catch((error): DriveResult => {
        const record = this.deps.store.getHandoffRecord(handoffId);
        if (record) {
          this.deps.report(
            record.missionId,
            `[mission ${record.missionId}] handoff ${handoffId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        if (this.flights.get(handoffId) === flight) this.flights.delete(handoffId);
      });
    this.flights.set(handoffId, flight);
    return flight;
  }

  /** Drive every open, drivable record (after a crash, at a phase boundary). Returns what each did. */
  async resumeOpen(missionId?: string): Promise<DriveResult[]> {
    const open = this.deps.store.listHandoffRecords(missionId).filter((r) => this.drivable(r));
    const out: DriveResult[] = [];
    for (const record of open) out.push(await this.drive(record.id));
    return out;
  }

  /** Resolves when no drive is in flight. */
  async idle(): Promise<void> {
    while (this.flights.size > 0) await Promise.allSettled([...this.flights.values()]);
  }

  private drivable(record: HandoffRecord): boolean {
    return (
      record.checkpointSha !== undefined &&
      record.blockedReason === undefined &&
      (record.state === "prepared" || record.state === "validated")
    );
  }

  private pickCheckpoint(record: HandoffRecord): TaskCheckpoint | undefined {
    const sha = record.checkpointSha;
    if (!sha) return undefined;
    if (record.kind === "phase_transition") {
      // The orchestrating session's own checkpoint (scope "orchestrator"), never a worker's.
      return this.deps.store
        .listOrchestratorCheckpoints(record.missionId)
        .filter(
          (c) =>
            c.candidateSha?.startsWith(sha) &&
            c.sessionId === record.predecessor.sessionId &&
            Date.parse(c.createdAt) <= Date.parse(record.createdAt) &&
            // It must be THIS boundary's checkpoint, not another record's that happens to share a SHA.
            (record.toPhase === undefined ||
              c.handoff?.decisions.some((d) => d.id === `phase:${record.fromPhase ?? "start"}->${record.toPhase}`)),
        )
        .at(-1);
    }
    const matching = this.deps.store
      .listTaskCheckpoints(record.missionId)
      .filter((c) => c.candidateSha?.startsWith(sha) && c.executionId);
    return matching.filter((c) => c.sessionId === record.predecessor.sessionId).at(-1) ?? matching.at(-1) ?? undefined;
  }

  /** A session that already took over: a later execution of the same task, under another session, started after the record. */
  private discoverSuccessor(record: HandoffRecord, checkpoint: TaskCheckpoint) {
    const later = this.deps.store
      .listExecutions(record.missionId)
      .filter(
        (e) =>
          e.task_id === checkpoint.taskId &&
          // A quota fallback is only taken over by an execution on the configured model: a same-model retry racing in from
          // the scheduler's resilience path is not the successor. A context handoff's pin is a preference: an operator pin
          // or a failover may route the successor elsewhere and it is still the session that took over.
          (record.cause !== "quota_exhausted" ||
            record.toModel === undefined ||
            (e.model !== null && sameModel(e.model, record.toModel))) &&
          e.execution_id !== checkpoint.executionId &&
          e.session_id &&
          e.session_id !== record.predecessor.sessionId &&
          e.started_at !== null &&
          Date.parse(e.started_at) >= Date.parse(record.createdAt),
      )
      .sort((a, b) => (a.started_at as string).localeCompare(b.started_at as string));
    const first = later[0];
    return first?.session_id
      ? { sessionId: first.session_id, generation: record.predecessor.generation + 1 }
      : undefined;
  }

  /**
   * The successor of a phase boundary is the orchestrating session entering the next phase one generation later: the
   * boundary is the orchestrator's own context boundary, and a phase may start no agent session at all (integration,
   * validation), so no worker can be the one to take over. It is driven at the moment the next phase begins.
   */
  private phaseSuccessor(record: HandoffRecord) {
    return { sessionId: record.predecessor.sessionId, generation: record.predecessor.generation + 1 };
  }

  /**
   * Phase fence: revoke the PREVIOUS phase's worker authority and nothing else. Exactly the executions still RUNNING
   * that started strictly before the boundary record was created (late stragglers of the finished phase) lose their
   * writer authority and their registered process groups. The orchestrating session is never fenced (it runs this very
   * handoff), the mission lease is untouched, and a worker the next phase started after the boundary is left alone
   * (the drive is launched asynchronously, so it may already be running).
   */
  private phaseFence(record: HandoffRecord): () => Promise<void> {
    return composeFences(
      ...this.deps.store
        .listExecutions(record.missionId)
        .filter(
          (e) =>
            e.status === "RUNNING" &&
            e.started_at !== null &&
            Date.parse(e.started_at) < Date.parse(record.createdAt) &&
            // Only the finished phase's workers; a worker of unknown phase (restart) or of the current phase is spared.
            record.fromPhase !== undefined &&
            this.deps.phaseAt?.(record.missionId, e.started_at) === record.fromPhase,
        )
        .map((e) =>
          fenceExecutionWriter(this.deps.store, e.execution_id, () => this.deps.quarantineExecution(e.execution_id)),
        ),
    );
  }

  private async run(handoffId: string): Promise<DriveResult> {
    const { store } = this.deps;
    const record = store.getHandoffRecord(handoffId);
    if (!record) return { status: "skipped", reason: "unknown handoff record" };
    if (!this.drivable(record)) return { status: "skipped", reason: `not drivable (${record.kind}, ${record.state})` };
    const checkpoint = this.pickCheckpoint(record);
    if (!checkpoint && record.kind === "phase_transition") {
      // Written before orchestrator checkpoints existed (or its checkpoint is gone): nothing can ever verify it.
      const reason = "phase_transition record has no orchestrator checkpoint (predates them); aborted, nothing fenced";
      store.abortHandoff(handoffId, reason);
      this.deps.report(record.missionId, `[mission ${record.missionId}] handoff ${handoffId} ${reason}`);
      return { status: "skipped", reason };
    }
    if (!checkpoint) {
      this.deps.report(
        record.missionId,
        `[mission ${record.missionId}] handoff ${handoffId} waiting: no checkpoint ${record.checkpointSha?.slice(0, 7)} recorded`,
      );
      return { status: "skipped", reason: "no matching checkpoint" };
    }
    // Retry budget BEFORE the fence: the successor is the scheduler's retry of the fenced task. With no attempt left the
    // fence would cancel the source and nobody would continue, so the record is aborted instead and the source untouched.
    if (
      !record.sourceFencedAt &&
      ((record.cause === "quota_exhausted" && record.toModel) || record.cause === "context_pressure")
    ) {
      const task = store.getTask(checkpoint.taskId);
      if (!task || task.attempt >= task.max_attempts) {
        const reason = `no retry budget left for task ${checkpoint.taskId} (attempt ${task?.attempt ?? "?"} of ${task?.max_attempts ?? "?"}); source not fenced, successor${record.toModel ? ` on ${record.toModel}` : ""} not started`;
        store.abortHandoff(handoffId, reason);
        this.deps.report(
          record.missionId,
          `[mission ${record.missionId}] ${record.cause === "quota_exhausted" ? "quota" : "context"} handoff ${handoffId} ABORTED: ${reason}`,
        );
        return { status: "skipped", reason };
      }
    }
    const successor =
      record.kind === "phase_transition" ? this.phaseSuccessor(record) : this.discoverSuccessor(record, checkpoint);
    const pressure = this.deps.pressureThreshold?.();
    // A record whose cause IS context pressure crossed a level above the pressure threshold by construction, even when
    // no usage figure was recorded on the executions; the fallback after a rejection must not forget that.
    let utilization = this.deps.utilization?.(record.missionId) ?? null;
    if (record.cause === "context_pressure") {
      utilization = Math.max(utilization ?? 0, pressure ?? DEFAULT_CONTEXT_THRESHOLDS.soft);
    }
    const outcome = await executeHandoff(store, {
      handoffId,
      checkpoint,
      ...(successor ? { successor } : {}),
      deps: this.deps.verifyDeps ?? createHandoffVerifyDeps(this.deps.artifacts),
      fenceSource:
        record.kind === "phase_transition"
          ? this.phaseFence(record)
          : composeFences(
              // Model switch: the task's model is switched (durably, idempotently) AFTER verification and BEFORE the writer
              // is fenced, so the retry the fence unblocks already asks for that model and starts from the checkpoint. A
              // quota fallback names another model; a context-pressure handoff names the predecessor's own.
              async () => {
                if ((record.cause === "quota_exhausted" || record.cause === "context_pressure") && record.toModel) {
                  store.switchTaskModel(
                    checkpoint.taskId,
                    record.toModel,
                    checkpoint.candidateSha ?? undefined,
                    record.id,
                  );
                } else if (record.cause === "context_pressure" && checkpoint.candidateSha) {
                  // Model not pinned: the successor routes normally but still starts from the verified checkpoint.
                  store.resumeTaskFromCheckpoint(checkpoint.taskId, checkpoint.candidateSha, record.id);
                }
              },
              fenceExecutionWriter(store, checkpoint.executionId, () =>
                this.deps.quarantineExecution(checkpoint.executionId),
              ),
            ),
      contextUtilization: utilization,
      ...(pressure !== undefined ? { pressureThreshold: pressure } : {}),
    });
    this.deps.report(record.missionId, this.describe(handoffId, outcome));
    return { status: outcome.status, record: outcome.record };
  }

  private switchNote(record: HandoffRecord): string {
    if (!record.toModel) return "";
    return record.fromModel && sameModel(record.fromModel, record.toModel)
      ? ` (successor pinned to ${record.toModel})`
      : ` (task switched ${record.fromModel ?? "?"} -> ${record.toModel})`;
  }

  private describe(id: string, outcome: HandoffOutcome): string {
    const m = outcome.record.missionId;
    switch (outcome.status) {
      case "acknowledged":
        return `[mission ${m}] handoff ${id} verified, source fenced, acknowledged by ${outcome.record.successor?.sessionId}`;
      case "fenced":
        return `[mission ${m}] handoff ${id} verified, source fenced${this.switchNote(outcome.record)}; awaiting the successor session`;
      case "already_acknowledged":
        return `[mission ${m}] handoff ${id} already acknowledged (${outcome.resume.decision})`;
      case "rejected":
        return `[mission ${m}] handoff ${id} REJECTED, source untouched: ${outcome.errors.join("; ")}; fallback ${outcome.fallback.fallback} (${outcome.fallback.reason})`;
      case "fence_failed":
        return `[mission ${m}] handoff ${id} fence failed (retried on the next drive): ${outcome.error}`;
    }
  }
}
