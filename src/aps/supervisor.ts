/**
 * APS Phase 1/2 — AgentProgressSupervisor (detect-only).
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
import { contextUtilization } from "./context.ts";
import { ToolCallNormalizer } from "./fingerprint.ts";
import { ProgressEvaluator } from "./progress.ts";
import {
  type AgentAction,
  type AgentLoopCandidateEvent,
  type AgentLoopEvent,
  type AgentLoopPreventedEvent,
  DEFAULT_LOOP_PREVENTION,
  type LoopPreventionOptions,
  type LoopVerdict,
  type ProgressThresholds,
} from "./types.ts";

/** Persistent event type for loop candidates (additive to the store's type space). */
export const AGENT_LOOP_CANDIDATE_EVENT = "agent.loop_candidate";
/** Persistent event type for loop prevention (Phase 3 enforcement). */
export const AGENT_LOOP_PREVENTED_EVENT = "agent.loop_prevented";

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
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * Telemetry notice emitter. Defaults to the global telemetry sink
   * (`emitTelemetry` in `src/telemetry/sink.ts`).
   */
  emitNotice?: (event: AgentLoopEvent) => void;
  /** Injectable clock for deterministic timestamps. */
  now?: () => string;
  /**
   * Loop-prevention configuration (Phase 3 enforcement). Defaults to
   * `DEFAULT_LOOP_PREVENTION` (enabled, conservative).
   */
  prevention?: LoopPreventionOptions;
  /**
   * Enforcement callback invoked when a loop is PREVENTED (Phase 3). The
   * caller wires this to terminate the current run attempt. Settable after
   * construction because the abort handle (the session) is created later.
   */
  onPrevented?: (event: AgentLoopPreventedEvent) => void;
}

/** Verdict plus whether a new event was emitted for this action. */
export interface ObserveResult extends LoopVerdict {
  /** True when a fresh `agent.loop_candidate` event was emitted. */
  emitted: boolean;
  /** True when the run was PREVENTED (Phase 3 enforcement fired) by this action. */
  prevented?: boolean;
  /** Loop-prevention reason (e.g. "no_progress_turns"), when prevented. */
  preventionReason?: string;
}

export class AgentProgressSupervisor {
  private readonly evaluator: ProgressEvaluator;
  private readonly normalizer: ToolCallNormalizer;
  private readonly eventStore: EventStoreBackend | undefined;
  private readonly onEvent: ((event: AgentLoopEvent) => void) | undefined;
  private readonly emitNotice: (event: AgentLoopEvent) => void;
  private readonly now: () => string;
  /** sessionId -> fingerprint of the loop already reported for that session. */
  private readonly reportedLoops = new Map<string, string>();
  private readonly events: AgentLoopEvent[] = [];
  private readonly prevention: Required<LoopPreventionOptions>;
  /** Enforcement callback (settable after construction; see options). */
  onPrevented: ((event: AgentLoopPreventedEvent) => void) | undefined;
  /** Fires prevention at most once per supervisor (the session is aborted). */
  private preventionFired = false;

  constructor(options: AgentProgressSupervisorOptions = {}) {
    this.evaluator = new ProgressEvaluator({
      historySize: options.historySize,
      thresholds: options.thresholds,
    });
    this.normalizer = options.normalizer ?? new ToolCallNormalizer();
    this.eventStore = options.eventStore;
    this.onEvent = options.onEvent;
    this.onPrevented = options.onPrevented;
    this.prevention = { ...DEFAULT_LOOP_PREVENTION, ...options.prevention };
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

  /** All events emitted so far, in emission order (candidate + prevented). */
  get emittedEvents(): readonly AgentLoopEvent[] {
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
    const vector = this.evaluator.vector();
    // Phase 3 enforcement (independent of the detection gate): a SUSTAINED run
    // of identical no-progress actions (noProgressTurns at/above the PREVENTION
    // threshold) is prevented — the enforcement hook fires once and the caller
    // aborts the run. Conservative: only identical-fingerprint no-progress
    // triggers it; changed inputs/results change the fingerprint and keep
    // noProgressTurns low, so legitimate repeats are never prevented.
    if (this.prevention.enabled && !this.preventionFired && vector.noProgressTurns >= this.prevention.noProgressTurns) {
      this.preventionFired = true;
      const event = this.buildPreventedEvent(action, vector.noProgressTurns);
      this.events.push(event);
      try {
        this.onPrevented?.(event);
      } catch {
        /* A failing enforcement callback must not break detection. */
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
          /* Persistence is best-effort. */
        }
      }
      return { ...verdict, emitted: true, prevented: true, preventionReason: "no_progress_turns" };
    }
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

  private buildPreventedEvent(action: AgentAction, noProgressTurns: number): AgentLoopPreventedEvent {
    const candidate = this.buildEvent(action, "no_progress_turns");
    const { type: _type, ...rest } = candidate;
    return {
      ...rest,
      type: "agent.loop_prevented",
      prevented: true,
      metrics: { ...candidate.metrics, noProgressTurns },
    };
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
      tool: action.tool,
      model:
        action.modelProvider !== undefined || action.modelId !== undefined
          ? { provider: action.modelProvider ?? "unknown", id: action.modelId ?? "unknown" }
          : null,
      contextUtilization: contextUtilization(action.inputTokens, action.maxContextTokens),
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
  private toStoredEvent(event: AgentLoopEvent): StoredEvent {
    return {
      event_id: event.event_id,
      timestamp: event.timestamp,
      type: (event.type === "agent.loop_prevented"
        ? AGENT_LOOP_PREVENTED_EVENT
        : AGENT_LOOP_CANDIDATE_EVENT) as StoredEvent["type"],
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
        tool: event.tool,
        model: event.model === null ? null : { ...event.model },
        contextUtilization: event.contextUtilization,
        family: event.family,
        target: event.target,
        metrics: { ...event.metrics },
      },
    };
  }
}
