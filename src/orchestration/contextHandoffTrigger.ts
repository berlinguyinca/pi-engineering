/**
 * Context-pressure and quota handoff trigger (spec: continuity protocol).
 *
 * Observes a running execution's live context size and, on a real crossing of the configured thresholds
 * (context/thresholds.ts), requests a checkpoint and records a `context` HandoffRecord carrying that checkpoint's SHA and
 * `cause: "context_pressure"`:
 *   - `preferred` (default 0.80) acts at a SAFE POINT only (a checkpoint boundary or a phase boundary);
 *   - `emergency` (default 0.90) acts at once.
 * Quota exhaustion is a DISTINCT cause: decideQuotaResume picks the action and a `recovery` record is written with
 * `cause: "quota_exhausted"`. Both are idempotent per execution: a crossing fires once, repeated polls do nothing, and
 * a failed attempt (no durable checkpoint SHA) is retried at the next opportunity.
 *
 * No I/O of its own: every effect is an injected dependency, so the unit is testable without a broker.
 */

import { type ContextThresholds, type CrossingState, contextLevel, evaluateCrossing } from "../context/thresholds.ts";
import type { InferenceFailureClass } from "../inference/failureClassifier.ts";
import type { HandoffCause, HandoffEndpoint, HandoffKind, HandoffRecord } from "../runtime/host/handoffKinds.ts";
import { type QuotaResumeModel, decideQuotaResume } from "../runtime/host/quotaResume.ts";

export interface ContextHandoffDeps {
  thresholdsFor(model: string | null): ContextThresholds;
  /** Persist a checkpoint of the live execution; true when it is durable. */
  requestCheckpoint(executionId: string): Promise<boolean>;
  /** Newest durable checkpoint SHA for the task, when one exists. */
  latestCheckpointSha(missionId: string, taskId: string): string | undefined;
  addHandoff(record: Record<string, unknown>): HandoffRecord;
  endpoint(missionId: string): HandoffEndpoint | null;
  report(missionId: string, line: string): void;
  /** Catalogue for quota switching; empty = no alternate known. */
  catalogue?(): readonly QuotaResumeModel[];
  now?(): Date;
}

export interface ContextObservation {
  missionId: string;
  taskId: string;
  executionId: string;
  model: string;
  tokens: number;
  window: number;
}

export class ContextHandoffTrigger {
  private readonly deps: ContextHandoffDeps;
  private readonly latest = new Map<string, ContextObservation>();
  private readonly crossing = new Map<string, CrossingState>();
  private readonly inFlight = new Set<string>();
  private readonly quotaDone = new Set<string>();

  constructor(deps: ContextHandoffDeps) {
    this.deps = deps;
  }

  /** A live context reading. Only `emergency` can act here; `preferred` waits for a safe point. */
  async observe(obs: ContextObservation): Promise<void> {
    this.latest.set(obs.executionId, obs);
    await this.evaluate(obs.executionId, false);
  }

  /** A safe point (checkpoint boundary, phase boundary) for one execution: `preferred` may act now. */
  async safePoint(executionId: string): Promise<void> {
    await this.evaluate(executionId, true);
  }

  /** Safe point for every execution observed under a mission (phase boundary). */
  async safePointForMission(missionId: string): Promise<void> {
    for (const obs of [...this.latest.values()]) if (obs.missionId === missionId) await this.safePoint(obs.executionId);
  }

  forget(executionId: string): void {
    this.latest.delete(executionId);
    this.crossing.delete(executionId);
    this.inFlight.delete(executionId);
    this.quotaDone.delete(executionId);
  }

  private async evaluate(executionId: string, atSafePoint: boolean): Promise<void> {
    const obs = this.latest.get(executionId);
    if (!obs || this.inFlight.has(executionId)) return;
    const thresholds = this.deps.thresholdsFor(obs.model);
    const level = contextLevel(obs.window > 0 ? obs.tokens / obs.window : null, thresholds);
    const before = this.crossing.get(executionId) ?? { fired: "ok" };
    const { state, action } = evaluateCrossing(before, level, atSafePoint);
    this.crossing.set(executionId, state);
    if (!action) return;
    this.inFlight.add(executionId);
    try {
      const done = await this.handoff(obs, "context", "context_pressure", {
        note: `context ${(obs.tokens / obs.window).toFixed(2)} crossed ${action} (${thresholds[action]})`,
      });
      // No durable checkpoint = no handoff: stay armed so the next opportunity retries instead of going silent.
      if (!done) this.crossing.set(executionId, before);
    } finally {
      this.inFlight.delete(executionId);
    }
  }

  /**
   * Provider quota exhaustion for an execution (a different cause from context size). Returns the decision action.
   * Records a `recovery` handoff only when decideQuotaResume says pause or switch_model, once per execution.
   */
  async quotaExhausted(input: {
    missionId: string;
    taskId: string;
    executionId: string;
    model: string;
    failureClass: InferenceFailureClass;
    retryAfterMs?: number;
  }): Promise<"pause" | "switch_model" | "wait" | "fail" | "already_handled"> {
    if (this.quotaDone.has(input.executionId)) return "already_handled";
    // Best effort: the execution may already be gone, in which case the newest earlier checkpoint is what exists.
    await this.deps.requestCheckpoint(input.executionId);
    const sha = this.deps.latestCheckpointSha(input.missionId, input.taskId);
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const decision = decideQuotaResume({
      failureClass: input.failureClass,
      currentModelId: input.model,
      catalogue: this.deps.catalogue?.() ?? [],
      ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
      nowMs,
      pausedAtMs: null,
      maxPauseMs: Number.MAX_SAFE_INTEGER,
      // The executor does not report which external side effects are uncommitted; an empty list means "none known".
      sideEffects: [],
      hasCheckpoint: sha !== undefined,
    });
    if (decision.action === "pause" || decision.action === "switch_model") {
      this.quotaDone.add(input.executionId);
      const done = await this.handoff(input, decision.handoffKind ?? "recovery", "quota_exhausted", {
        skipRequest: true,
        note: `${decision.action}: ${decision.reasons.join("; ")}${decision.alternateModelId ? ` -> ${decision.alternateModelId}` : ""}`,
      });
      if (!done) this.quotaDone.delete(input.executionId);
    } else {
      this.deps.report(
        input.missionId,
        `[mission ${input.missionId}] quota failure: ${decision.action} (${decision.reasons.join("; ")})`,
      );
    }
    return decision.action;
  }

  private async handoff(
    obs: Pick<ContextObservation, "missionId" | "taskId" | "executionId">,
    kind: HandoffKind,
    cause: HandoffCause,
    detail: { note: string; skipRequest?: boolean },
  ): Promise<boolean> {
    const { missionId } = obs;
    const endpoint = this.deps.endpoint(missionId);
    if (!endpoint) {
      this.deps.report(missionId, `[mission ${missionId}] ${cause} handoff skipped: no session endpoint available`);
      return false;
    }
    if (!detail.skipRequest) await this.deps.requestCheckpoint(obs.executionId);
    const checkpointSha = this.deps.latestCheckpointSha(missionId, obs.taskId);
    if (!checkpointSha) {
      this.deps.report(
        missionId,
        `[mission ${missionId}] ${cause} handoff deferred: no durable checkpoint yet (${detail.note})`,
      );
      return false;
    }
    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    try {
      const record = this.deps.addHandoff({
        id: [
          "ho",
          missionId,
          cause === "context_pressure" ? "ctx" : "quota",
          obs.executionId,
          createdAt.replace(/[:.]/g, ""),
        ].join("-"),
        kind,
        state: "prepared",
        missionId,
        predecessor: endpoint,
        checkpointSha,
        createdAt,
        cause,
      });
      this.deps.report(
        missionId,
        `[mission ${missionId}] ${cause} handoff ${record.id} @ ${checkpointSha.slice(0, 7)} (${detail.note})`,
      );
      return true;
    } catch (error) {
      this.deps.report(
        missionId,
        `[mission ${missionId}] ${cause} handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
