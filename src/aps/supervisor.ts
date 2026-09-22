/**
 * APS Phase 1 — AgentProgressSupervisor (detect-only).
 *
 * The supervisor consumes `AgentAction`s, runs them through the
 * `ProgressEvaluator`, and — when the evaluator classifies a loop candidate —
 * emits ONE structured `agent.loop_candidate` event into the existing
 * telemetry/event bus:
 *   - in-process subscribers (`onEvent`),
 *   - the global telemetry sink (`emitTelemetry`, unless overridden),
 *   - and, when an `EventStoreBackend` is provided, the persistent event store
 *     (stored as a `StoredEvent` of type `agent.loop_candidate`).
 *
 * HARD CONSTRAINTS (Phase 1): the supervisor NEVER terminates a run,
 * compacts or prunes context, replans, switches models, changes sampling, or
 * escalates. It observes and reports; it does not act. It also never throws
 * into the observed session: a failing store or subscriber degrades to the
 * remaining sinks.
 */

import { id } from "../core/ids.ts";
import type { EventStoreBackend, StoredEvent } from "../platform/eventstore/backend.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { ToolCallNormalizer } from "./fingerprint.ts";
import { ProgressEvaluator } from "./progress.ts";
import type { AgentAction, AgentLoopCandidateEvent, LoopVerdict, ProgressThresholds } from "./types.ts";

/** Persistent event type for loop candidates (additive to the store's type space). */
export const AGENT_LOOP_CANDIDATE_EVENT = "agent.loop_candidate";

export interface AgentProgressSupervisorOptions {
  /** Bounded history size passed to the evaluator. Default 50. */
  historySize?: number;
  /** Detection thresholds passed to the evaluator. */
  thresholds?: Partial<ProgressThresholds>;
  /** Normalizer used to derive family/target for event payloads. */
  normalizer?: ToolCallNormalizer;
  /**
   * Existing event-bus seam: loop candidates are persisted as `StoredEvent`s
   * of type `agent.loop_candidate`. Optional; absence means no persistence.
   */
  eventStore?: EventStoreBackend;
  /** In-process subscriber, invoked before any async sink. */
  onEvent?: (event: AgentLoopCandidateEvent) => void;
  /**
   * Telemetry notice emitter. Defaults to the global telemetry sink
   * (`emitTelemetry` in `src/telemetry/sink.ts`).
   */
  emitNotice?: (event: AgentLoopCandidateEvent) => void;
  /** Injectable clock for deterministic timestamps. */
  now?: () => string;
}

/** Verdict plus whether a new event was emitted for this action. */
export interface ObserveResult extends LoopVerdict {
  /** True when a fresh `agent.loop_candidate` event was emitted. */
  emitted: boolean;
}

export class AgentProgressSupervisor {
  private readonly evaluator: ProgressEvaluator;
  private readonly normalizer: ToolCallNormalizer;
  private readonly eventStore: EventStoreBackend | undefined;
  private readonly onEvent: ((event: AgentLoopCandidateEvent) => void) | undefined;
  private readonly emitNotice: (event: AgentLoopCandidateEvent) => void;
  private readonly now: () => string;
  /** sessionId -> fingerprint of the loop already reported for that session. */
  private readonly reportedLoops = new Map<string, string>();
  private readonly events: AgentLoopCandidateEvent[] = [];

  constructor(options: AgentProgressSupervisorOptions = {}) {
    this.evaluator = new ProgressEvaluator({
      historySize: options.historySize,
      thresholds: options.thresholds,
    });
    this.normalizer = options.normalizer ?? new ToolCallNormalizer();
    this.eventStore = options.eventStore;
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date().toISOString());
    this.emitNotice =
      options.emitNotice ??
      ((event) =>
        emitTelemetry({
          level: "warning",
          key: "agent.loop_candidate",
          text: `APS: loop candidate in session ${event.sessionId}: ${event.family} ${event.target || "(no target)"} (${event.reason})`,
          detail: event,
        }));
  }

  /** All events emitted so far, in emission order. */
  get emittedEvents(): readonly AgentLoopCandidateEvent[] {
    return this.events;
  }

  /**
   * Observe one action. Records it in the bounded history, classifies it, and
   * emits at most one `agent.loop_candidate` event per distinct loop (same
   * session + fingerprint). Detect-only: the action is never mutated and no
   * control flow of the observed run is affected.
   */
  async observe(action: AgentAction): Promise<ObserveResult> {
    const verdict = this.evaluator.classify(action);
    if (!verdict.loop_candidate) {
      // Progress (or a non-loop action) resets the reported-loop marker.
      this.reportedLoops.delete(action.sessionId);
      return { ...verdict, emitted: false };
    }
    const fingerprint = action.contentFingerprint;
    if (this.reportedLoops.get(action.sessionId) === fingerprint) {
      return { ...verdict, emitted: false }; // this exact loop was already reported
    }
    this.reportedLoops.set(action.sessionId, fingerprint);

    const event = this.buildEvent(action, verdict.reason ?? "loop_candidate");
    this.events.push(event);

    try {
      this.onEvent?.(event);
    } catch {
      /* A failing subscriber must not break detection. */
    }
    try {
      this.emitNotice(event);
    } catch {
      /* A failing notice emitter must not break detection. */
    }
    if (this.eventStore !== undefined) {
      try {
        await this.eventStore.append(this.toStoredEvent(event));
      } catch {
        /* Persistence is best-effort; in-process + telemetry already fired. */
      }
    }
    return { ...verdict, emitted: true };
  }

  private buildEvent(action: AgentAction, reason: string): AgentLoopCandidateEvent {
    const vector = this.evaluator.vector();
    const call = this.normalizer.normalize({ name: action.tool, arguments: action.normalizedArguments });
    return {
      type: "agent.loop_candidate",
      event_id: id("aps"),
      timestamp: this.now(),
      sessionId: action.sessionId,
      runId: action.runId,
      workItemId: action.workItemId,
      role: action.role,
      iteration: action.iteration,
      phase: action.phase,
      reason,
      fingerprint: action.contentFingerprint,
      family: call.family,
      target: call.target,
      metrics: {
        noProgressTurns: vector.noProgressTurns,
        repeatedCalls: vector.repeatedCalls[action.contentFingerprint] ?? 0,
        staleToolResults: vector.staleToolResults,
      },
    };
  }

  /** Map an APS event onto the shared persistent event model. */
  private toStoredEvent(event: AgentLoopCandidateEvent): StoredEvent {
    return {
      event_id: event.event_id,
      timestamp: event.timestamp,
      type: AGENT_LOOP_CANDIDATE_EVENT,
      project_id: null,
      run_id: event.runId,
      worker_id: event.sessionId,
      payload: {
        sessionId: event.sessionId,
        runId: event.runId,
        workItemId: event.workItemId,
        role: event.role,
        iteration: event.iteration,
        phase: event.phase,
        reason: event.reason,
        fingerprint: event.fingerprint,
        family: event.family,
        target: event.target,
        metrics: { ...event.metrics },
      },
    };
  }
}
