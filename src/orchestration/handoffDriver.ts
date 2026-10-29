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
 * `acknowledgeHandoff` path. `phase_transition` records are not driven either: their predecessor is the orchestrating
 * session, which wrote no checkpoint, so the protocol would reject every one of them.
 */

import { DEFAULT_CONTEXT_THRESHOLDS } from "../context/thresholds.ts";
import type { HandoffRecord } from "../runtime/host/handoffKinds.ts";
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
      record.kind !== "phase_transition" &&
      (record.state === "prepared" || record.state === "validated")
    );
  }

  private pickCheckpoint(record: HandoffRecord): TaskCheckpoint | undefined {
    const sha = record.checkpointSha;
    if (!sha) return undefined;
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
          // A quota switch is only taken over by an execution on the configured fallback: a same-model retry racing in
          // from the scheduler's resilience path is not the successor.
          (record.toModel === undefined || e.model === record.toModel) &&
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

  private async run(handoffId: string): Promise<DriveResult> {
    const { store } = this.deps;
    const record = store.getHandoffRecord(handoffId);
    if (!record) return { status: "skipped", reason: "unknown handoff record" };
    if (!this.drivable(record)) return { status: "skipped", reason: `not drivable (${record.kind}, ${record.state})` };
    const checkpoint = this.pickCheckpoint(record);
    if (!checkpoint) {
      this.deps.report(
        record.missionId,
        `[mission ${record.missionId}] handoff ${handoffId} waiting: no checkpoint ${record.checkpointSha?.slice(0, 7)} recorded`,
      );
      return { status: "skipped", reason: "no matching checkpoint" };
    }
    const successor = this.discoverSuccessor(record, checkpoint);
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
      fenceSource: composeFences(
        // Quota switch: the task's model is switched (durably, idempotently) AFTER verification and BEFORE the writer
        // is fenced, so the retry the fence unblocks already asks for the fallback model and starts from the checkpoint.
        async () => {
          if (record.cause === "quota_exhausted" && record.toModel) {
            store.switchTaskModel(checkpoint.taskId, record.toModel, checkpoint.candidateSha ?? undefined, record.id);
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

  private describe(id: string, outcome: HandoffOutcome): string {
    const m = outcome.record.missionId;
    switch (outcome.status) {
      case "acknowledged":
        return `[mission ${m}] handoff ${id} verified, source fenced, acknowledged by ${outcome.record.successor?.sessionId}`;
      case "fenced":
        return `[mission ${m}] handoff ${id} verified, source fenced${outcome.record.toModel ? ` (task switched ${outcome.record.fromModel ?? "?"} -> ${outcome.record.toModel})` : ""}; awaiting the successor session`;
      case "already_acknowledged":
        return `[mission ${m}] handoff ${id} already acknowledged (${outcome.resume.decision})`;
      case "rejected":
        return `[mission ${m}] handoff ${id} REJECTED, source untouched: ${outcome.errors.join("; ")}; fallback ${outcome.fallback.fallback} (${outcome.fallback.reason})`;
      case "fence_failed":
        return `[mission ${m}] handoff ${id} fence failed (retried on the next drive): ${outcome.error}`;
    }
  }
}
