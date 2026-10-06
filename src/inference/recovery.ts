/**
 * The recovery ladder (fault-tolerance spec §4/§10/§18/§21).
 *
 * classify →
 *   permanent      → fail immediately (auth, invalid request, request too large);
 *   transient      → honour Retry-After (server timing is a FLOOR, never
 *                    shortened) → retry the SAME logical model/alias →
 *                    refresh InferWeave/model state (catalog, health,
 *                    resolved model) → retry the same alias/routing target →
 *                    capability-based comparable-model fallback →
 *   mission-level  → durable WAITING_FOR_INFERENCE_CAPACITY with automatic
 *                    resume through the existing long-transient-outage
 *                    machinery (recovery probe + time-based retry window).
 *
 * When no model is available the mission WAITS — it never fails on
 * infrastructure. No blind try/catch + sleep + retry: every branch below is
 * driven by the unified failure classifier's structural decision
 * (InferWeave metadata + status + stream state), and the wait times come
 * from the server where the server supplied them.
 *
 * Task-state preservation: the ladder restarts ONLY the failed model
 * invocation. Mission id, work item, worker role, candidate/worktree, ledger
 * state, tool results, verification state, and context hydration travel in
 * `LadderRunInput` untouched; the same logical `request` object is re-sent,
 * with idempotency evidence injected when prior tool calls already executed
 * (spec §20).
 */

import type { ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import type {
  ClassifiedInferenceFailure,
  StreamTerminationState,
} from "./failureClassifier.ts";
import type { InferenceResponseMetadata } from "./inferweaveMetadata.ts";
import { DEFAULT_INFERENCE_RESILIENCE, type InferenceResilienceConfig } from "./resilienceConfig.ts";
import {
  DEFAULT_STREAM_RETRY_POLICY,
  StreamRetryPolicy,
  type RetryDecision,
  type StreamRetryDelaySource,
} from "./retryPolicy.ts";
import {
  describeFallbackStatus,
  describeRetryStatus,
  describeWaitingStatus,
  formatDurationMs,
  type InferenceTelemetryData,
  type InferenceTelemetryEventName,
} from "./telemetry.ts";
import type { RequiredModelEnvelope } from "./envelope.ts";

/** One model invocation as seen by the ladder (transport seam). */
export interface LadderOutcome {
  ok: boolean;
  error?: unknown;
  metadata?: InferenceResponseMetadata;
  streamState?: StreamTerminationState;
}

export interface LadderTransport {
  send(input: { model: ModelRef; request: LadderRequest; attempt: number; signal?: AbortSignal }): Promise<LadderOutcome>;
}

/** Opaque provider request payload; the ladder only adds retry evidence. */
export type LadderRequest = Record<string, unknown>;

/** A model-scoped circuit breaker, structurally (circuitBreaker.ts satisfies it). */
export interface LadderBreaker {
  allowRequest(): boolean;
  beginProbe(): void;
  recordSuccess(): string;
  recordFailure(): string;
  getState(): string;
}

export interface LadderHooks {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Concise user-visible status line (spec §26); never stack traces. */
  status?(line: string): void;
  /** Structured telemetry (spec §13). */
  telemetry?(name: InferenceTelemetryEventName, data: InferenceTelemetryData): void;
  /** Capability-based fallback through the existing RoleRouter. */
  selectFallback?(query: {
    role: string;
    envelope?: RequiredModelEnvelope;
    exclude: ModelRef[];
  }): Promise<ModelRef | undefined>;
  /** Refresh InferWeave catalog/routing state (spec: stale route, no_workers). */
  refreshCatalog?(): Promise<void>;
  /** Compact an overflowing context before retry (spec §18). */
  compactContext?(request: LadderRequest): Promise<LadderRequest | undefined> | LadderRequest | undefined;
  /** Park the mission in WAITING_FOR_INFERENCE_CAPACITY (durable). */
  parkForCapacity?(info: {
    missionId?: string;
    workerId?: string;
    role: string;
    reason: string;
    untilMs: number;
  }): void;
  /** Existing long-transient-outage probe: capacity (any eligible model) available? */
  isCapacityAvailable?(): boolean | Promise<boolean>;
  /** Probe cadence for the capacity wait (existing machinery; default 10s). */
  probeIntervalMs?: number;
  /** Model-scoped unavailability penalty (spec §15). */
  onModelPenalty?(model: ModelRef, failure: ClassifiedInferenceFailure): void;
  /** A success: clear the model's penalty; it is eligible again. */
  onModelServed?(model: ModelRef): void;
  /** Circuit breaker for a logical model, when breakers are enabled. */
  breakerFor?(model: ModelRef): LadderBreaker | undefined;
  /** Idempotency: tool actions already executed by the failed generation. */
  actions?: ExecutedActionTracker;
  /** Upper bound on the mission-level capacity wait (the retry window). */
  capacityWaitMaxMs?: number;
}

export interface LadderRunInput {
  request: LadderRequest;
  role: string;
  /** The logical model (alias) — InferWeave keeps node/quant/backend selection. */
  model: ModelRef;
  requiredEnvelope?: RequiredModelEnvelope;
  missionId?: string;
  workerId?: string;
  signal?: AbortSignal;
}

export interface LadderRunOutcome {
  ok: boolean;
  model?: ModelRef;
  resolvedModel?: string;
  attempts: number;
  elapsedMs: number;
  fallbackModel?: ModelRef;
  failure?: ClassifiedInferenceFailure;
  reason?: string;
  /**
   * The logical request ended in a mission-level capacity wait. NOT a
   * failure: the mission stays parked in WAITING_FOR_INFERENCE_CAPACITY and
   * the existing recovery machinery resumes it when capacity appears.
   */
  waitingForCapacity?: boolean;
  /** Incomplete generations recorded (never appended as completed output). */
  incompleteGenerations: number;
}

// ─── Pure decision step ──────────────────────────────────────────────────────

export type RecoveryStep =
  | { kind: "retry"; model: ModelRef; delayMs: number; source: StreamRetryDelaySource; note: string }
  | { kind: "refresh_and_retry"; model: ModelRef; note: string }
  | { kind: "fallback"; note: string }
  | { kind: "wait_capacity"; delayMs: number; note: string }
  | { kind: "compact_and_retry"; model: ModelRef; note: string }
  | { kind: "fail"; reason: string; permanent: boolean };

export interface RecoveryStepInput {
  failure: ClassifiedInferenceFailure;
  model: ModelRef;
  /** 1-based: the attempt that just failed on `model`. */
  attempt: number;
  fallbackEnabled: boolean;
  /** True once the router has no further eligible model. */
  fallbackExhausted: boolean;
  /** How long the model has been stuck activating (for model_activating). */
  activationElapsedMs?: number;
  config: InferenceResilienceConfig;
  streamPolicy: StreamRetryPolicy;
}

function waitOrExhaust(
  policy: StreamRetryPolicy,
  attempt: number,
  serverDelayMs: number | undefined,
  model: ModelRef,
): { kind: "retry"; model: ModelRef; delayMs: number; source: RetryDecision["source"]; note: string } | {
  kind: "wait_capacity";
  delayMs: number;
  note: string;
} {
  const decision = policy.decide(attempt, serverDelayMs);
  if (decision.shouldRetry) {
    return {
      kind: "retry",
      model,
      delayMs: decision.delayMs,
      source: decision.source,
      note: `same-model retry ${decision.attemptsUsed + 1}/${policy.config.maxAttempts}`,
    };
  }
  // The per-model attempt budget is spent. The mission scheduler's existing
  // time-based outage machinery (PI_GATEWAY_RETRY_WINDOW + recovery probe)
  // takes over the wait — the request is NEVER failed on a transient.
  return {
    kind: "wait_capacity",
    delayMs: policy.ladderDelayMs(attempt),
    note: `same-model retry budget exhausted (${policy.config.maxAttempts} attempts); mission-level wait`,
  };
}

/**
 * Decide the next step on the recovery ladder for one classified failure.
 * Pure: no sleeping, no I/O — the executor (RecoveryLadder) runs the step.
 */
export function decideRecoveryStep(input: RecoveryStepInput): RecoveryStep {
  const { failure, model, attempt, config, streamPolicy } = input;
  const serverDelay = failure.retryAfterMs;

  switch (failure.action) {
    case "retry_same_model":
      // Stream/EOF/reset/link cut: wait + retry the SAME logical model
      // (spec §3/§18). Server timing, when present, is a floor.
      return waitOrExhaust(streamPolicy, attempt, serverDelay, model);

    case "honor_retry_after":
      // 429 / queue saturation / global admission / model activating:
      // honour the wait and keep the model — NEVER model-switch on a
      // queue or rate limit (spec §10).
      if (
        failure.class === "model_activating" &&
        (input.activationElapsedMs ?? 0) >= config.activationFallbackAfterMs &&
        input.fallbackEnabled &&
        !input.fallbackExhausted
      ) {
        return {
          kind: "fallback",
          note: `model activating exceeded ${formatDurationMs(config.activationFallbackAfterMs)}; capability-based fallback`,
        };
      }
      return waitOrExhaust(streamPolicy, attempt, serverDelay, model);

    case "wait_gateway_retry":
      // Gateway/provider outage: wait + retry the GATEWAY, same model —
      // switching models cannot fix a dead gateway (spec §10).
      return waitOrExhaust(streamPolicy, attempt, serverDelay, model);

    case "refresh_catalog_retry":
      // Stale route: refresh catalog/routing, retry the same target.
      return { kind: "refresh_and_retry", model, note: "stale route: catalog refreshed, retrying same target" };

    case "refresh_then_fallback":
      // Model-scoped unavailability (no_workers, model_unavailable, worker
      // evicted/restarting, model_not_found): short wait + catalog refresh +
      // comparable-model fallback (spec §10/§12).
      if (input.fallbackEnabled && !input.fallbackExhausted) {
        return { kind: "fallback", note: `model-scoped ${failure.class}: catalog refresh + comparable-model fallback` };
      }
      return {
        kind: "wait_capacity",
        delayMs: streamPolicy.ladderDelayMs(attempt),
        note: `no eligible fallback model for ${failure.class}; waiting for inference capacity`,
      };

    case "fallback":
      // Quota exhaustion: a comparable model may have headroom.
      if (input.fallbackEnabled && !input.fallbackExhausted) {
        return { kind: "fallback", note: "quota exhausted: capability-based fallback" };
      }
      return { kind: "wait_capacity", delayMs: streamPolicy.ladderDelayMs(attempt), note: "no eligible fallback model" };

    case "compact_and_retry":
      return { kind: "compact_and_retry", model, note: "context overflow: compact and retry" };

    case "fail":
      // Permanent request errors fail fast (spec §18): auth, invalid
      // request, request too large, billing.
      return {
        kind: "fail",
        reason: `${failure.class}: ${failure.reason ?? "permanent request error"}`,
        permanent: !failure.retryable,
      };

    default:
      return waitOrExhaust(streamPolicy, attempt, serverDelay, model);
  }
}

// ─── Idempotency (spec §20) ──────────────────────────────────────────────────

export interface ExecutedAction {
  /** Invocation id / tool-call id (stable across retries). */
  id: string;
  /** Tool name / action kind (edit, bash, commit, install, ...). */
  kind: string;
  /** What it did, for the evidence line. */
  summary: string;
  atMs: number;
}

/**
 * Tracks which tool calls of a failed generation ALREADY EXECUTED so a retry
 * never repeats them: no duplicate file writes, commits, installs, shell
 * commands, deployments, or issue creation. The tracker keys by invocation
 * id (tool-call id) and cross-checks the Engineering Ledger; the evidence
 * block is injected into the retried request.
 */
export class ExecutedActionTracker {
  private readonly actions = new Map<string, ExecutedAction>();
  private readonly incomplete: Array<{ model: string; attempt: number; chars?: number; atMs: number }> = [];

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  /** Record an executed tool action (idempotent on the invocation id). */
  record(action: Omit<ExecutedAction, "atMs">): void {
    if (this.actions.has(action.id)) return;
    this.actions.set(action.id, { ...action, atMs: this.now() });
  }

  list(): ExecutedAction[] {
    return [...this.actions.values()];
  }

  has(id: string): boolean {
    return this.actions.has(id);
  }

  /**
   * Record a partial generation (spec §20): the assistant text/reasoning that
   * stopped mid-stream. It is recorded as `incomplete_generation` telemetry —
   * never appended to the transcript as a completed response, and raw
   * internal reasoning is never injected.
   */
  recordIncompleteGeneration(info: { model: string; attempt: number; chars?: number }): void {
    this.incomplete.push({ ...info, atMs: this.now() });
  }

  incompleteCount(): number {
    return this.incomplete.length;
  }

  /**
   * Concise evidence for the retried request: the actions that MUST NOT be
   * repeated. Undefined when nothing executed (nothing to inject).
   */
  evidenceForRetry(): string | undefined {
    const list = this.list();
    if (list.length === 0) return undefined;
    const lines = list.map((a, i) => `  ${i + 1}. [${a.id}] ${a.kind}: ${a.summary}`);
    return [
      "Idempotency notice — a previous generation of this request was interrupted AFTER the following actions already executed:",
      ...lines,
      "These actions MUST NOT be repeated. The repository already reflects them; continue from the current state.",
    ].join("\n");
  }

  reset(): void {
    this.actions.clear();
    this.incomplete.length = 0;
  }
}

// ─── The ladder executor ─────────────────────────────────────────────────────

const DEFAULT_PROBE_INTERVAL_MS = 10_000;
const DEFAULT_CAPACITY_WAIT_MAX_MS = 12 * 3_600_000; // mirrors PI_GATEWAY_RETRY_WINDOW default

/** Mutable per-run state; retries touch ONLY the failed invocation. */
interface LadderState {
  request: LadderRequest;
  current: ModelRef;
  tried: ModelRef[];
  fallbackModel?: ModelRef;
  lastResolved?: string;
  totalAttempts: number;
  fallbackExhausted: boolean;
  compactBudget: number;
  activationSince?: number;
}

type ModelLoopResult =
  | { kind: "done"; result: LadderRunOutcome }
  | { kind: "fallback" }
  | { kind: "wait_capacity"; failure: ClassifiedInferenceFailure; note: string };

/**
 * Runs the recovery ladder around an injectable transport. This is the
 * single place where an inference failure becomes a decision; workers never
 * implement their own retry behaviour (spec §21).
 */
export class RecoveryLadder {
  private readonly config: InferenceResilienceConfig;
  private readonly streamPolicy: StreamRetryPolicy;
  private readonly hooks: LadderHooks;

  constructor(opts: {
    hooks: LadderHooks;
    config?: Partial<InferenceResilienceConfig>;
    streamPolicy?: StreamRetryPolicy;
    random?: () => number;
  }) {
    this.config = { ...DEFAULT_INFERENCE_RESILIENCE, ...opts.config };
    this.streamPolicy =
      opts.streamPolicy ??
      new StreamRetryPolicy({
        config: {
          enabled: this.config.streamRetryEnabled,
          maxAttempts: this.config.streamRetryMaxAttempts,
          initialDelayMs: this.config.streamRetryInitialMs,
          maxDelayMs: this.config.streamRetryMaxMs,
        },
        random: opts.random,
      });
    this.hooks = opts.hooks;
  }

  get streamPolicyConfig(): StreamRetryPolicy["config"] {
    return this.streamPolicy.config;
  }

  /**
   * Execute one logical request through the ladder. Resolves on success, on a
   * permanent failure, or with `waitingForCapacity` when the mission is
   * parked (a transient NEVER fails the mission).
   */
  async run(
    transport: LadderTransport,
    input: LadderRunInput,
    classify: (outcome: LadderOutcome, model: ModelRef) => ClassifiedInferenceFailure,
  ): Promise<LadderRunOutcome> {
    const startedAt = this.hooks.now();
    const base: InferenceTelemetryData = {
      ...(input.missionId ? { mission_id: input.missionId } : {}),
      ...(input.workerId ? { worker_id: input.workerId } : {}),
      role: input.role,
    };
    const state: LadderState = {
      request: input.request,
      current: input.model,
      tried: [],
      totalAttempts: 0,
      fallbackExhausted: false,
      compactBudget: 2,
    };

    while (!input.signal?.aborted) {
      const loop = await this.attemptModel(transport, input, classify, base, state, startedAt);
      if (loop.kind === "done") return loop.result;
      if (loop.kind === "wait_capacity") {
        const resumed = await this.waitForCapacity(
          transport,
          input,
          classify,
          base,
          state,
          startedAt,
          loop.failure,
          loop.note,
        );
        if (resumed) continue; // capacity returned: resume the SAME logical request
        const failure = loop.failure;
        return {
          ok: false,
          model: state.current,
          ...(state.lastResolved ? { resolvedModel: state.lastResolved } : {}),
          attempts: state.totalAttempts,
          elapsedMs: this.hooks.now() - startedAt,
          ...(state.fallbackModel ? { fallbackModel: state.fallbackModel } : {}),
          failure,
          reason: "capacity wait window exhausted; mission parked for recovery",
          waitingForCapacity: true,
          incompleteGenerations: this.hooks.actions?.incompleteCount() ?? 0,
        };
      }
      // kind === "fallback": the model chain continues with the selected model
      // (state.current already advanced by attemptModel).
    }

    return {
      ok: false,
      model: state.current,
      attempts: state.totalAttempts,
      elapsedMs: this.hooks.now() - startedAt,
      reason: "aborted",
      incompleteGenerations: this.hooks.actions?.incompleteCount() ?? 0,
    };
  }

  /** Per-model attempt loop: send → classify → step; one model at a time. */
  private async attemptModel(
    transport: LadderTransport,
    input: LadderRunInput,
    classify: (outcome: LadderOutcome, model: ModelRef) => ClassifiedInferenceFailure,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
  ): Promise<ModelLoopResult> {
    const current = state.current;
    const actions = this.hooks.actions;
    let attempt = 0;
    let failure: ClassifiedInferenceFailure | undefined;

    while (!input.signal?.aborted) {
      attempt += 1;
      state.totalAttempts += 1;

      const breaker = this.hooks.breakerFor?.(current);
      if (breaker && !breaker.allowRequest()) {
        // Circuit OPEN: do not storm the model. Route it as a model-scoped
        // unavailability for this round (fallback or wait) — the breaker
        // re-qualifies the model on a later probe.
        this.hooks.telemetry?.("inference.model.unavailable", {
          ...base,
          logical_model: modelKey(current),
          failure_class: "circuit_open",
          attempt,
          elapsed_wait: this.hooks.now() - startedAt,
        });
        failure = {
          class: "model_unavailable",
          retryable: true,
          modelScoped: true,
          providerScoped: false,
          requestScoped: false,
          canFallback: true,
          shouldRefreshCatalog: false,
          shouldCompactContext: false,
          action: "refresh_then_fallback",
          source: "none",
          reason: "circuit open",
          model: current.id,
        } as ClassifiedInferenceFailure;
        return this.applyStep(input, base, state, startedAt, failure, attempt, {
          kind: "fallback",
          note: "circuit open for model; capability-based fallback or wait",
        });
      }
      breaker?.beginProbe();

      this.hooks.telemetry?.("inference.request.started", {
        ...base,
        logical_model: modelKey(current),
        ...(state.lastResolved ? { resolved_model: state.lastResolved } : {}),
        ...(state.fallbackModel ? { fallback_model: modelKey(state.fallbackModel) } : {}),
        attempt,
      });

      let outcome: LadderOutcome;
      try {
        outcome = await transport.send({
          model: current,
          request: state.request,
          attempt,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        outcome = { ok: false, error };
      }

      if (outcome.ok) {
        state.lastResolved = outcome.metadata?.resolvedModel ?? state.lastResolved;
        breaker?.recordSuccess();
        this.hooks.onModelServed?.(current);
        this.hooks.telemetry?.("inference.request.completed", {
          ...base,
          logical_model: modelKey(current),
          ...(state.lastResolved ? { resolved_model: state.lastResolved } : {}),
          attempt,
          elapsed_wait: this.hooks.now() - startedAt,
        });
        if (attempt > 1) {
          this.hooks.telemetry?.("inference.retry.succeeded", {
            ...base,
            logical_model: modelKey(current),
            attempt,
            elapsed_wait: this.hooks.now() - startedAt,
          });
        }
        return {
          kind: "done",
          result: {
            ok: true,
            model: current,
            ...(state.lastResolved ? { resolvedModel: state.lastResolved } : {}),
            attempts: state.totalAttempts,
            elapsedMs: this.hooks.now() - startedAt,
            ...(state.fallbackModel ? { fallbackModel: state.fallbackModel } : {}),
            incompleteGenerations: actions?.incompleteCount() ?? 0,
          },
        };
      }

      failure = classify(outcome, current);
      this.hooks.telemetry?.("inference.failure.classified", {
        ...base,
        logical_model: modelKey(current),
        ...(state.lastResolved ? { resolved_model: state.lastResolved } : {}),
        failure_class: failure.class,
        attempt,
        retry_delay: failure.retryAfterMs,
        elapsed_wait: this.hooks.now() - startedAt,
        classified: failure,
        ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
      });
      if (failure.class === "incomplete_stream" && outcome.streamState?.outputCommitted) {
        this.hooks.telemetry?.("inference.stream.incomplete", {
          ...base,
          logical_model: modelKey(current),
          attempt,
          partial_chars: outcome.streamState.partialChars,
          kind: "incomplete_generation",
        });
        actions?.recordIncompleteGeneration({
          model: modelKey(current),
          attempt,
          chars: outcome.streamState.partialChars,
        });
      }

      if (failure.modelScoped) {
        this.hooks.onModelPenalty?.(current, failure);
        const breakerState = breaker?.recordFailure();
        if (breakerState === "OPEN") {
          this.hooks.telemetry?.("inference.model.circuit_opened", {
            ...base,
            logical_model: modelKey(current),
            failure_class: failure.class,
            attempt,
          });
        }
      }

      const step = decideRecoveryStep({
        failure,
        model: current,
        attempt,
        fallbackEnabled: this.fallbackEnabledFor(input),
        fallbackExhausted: state.fallbackExhausted,
        activationElapsedMs:
          state.activationSince !== undefined ? this.hooks.now() - state.activationSince : undefined,
        config: this.config,
        streamPolicy: this.streamPolicy,
      });

      if (step.kind === "retry") {
        this.hooks.telemetry?.("inference.retry.scheduled", {
          ...base,
          logical_model: modelKey(current),
          failure_class: failure.class,
          retry_delay: step.delayMs,
          attempt,
          source: step.source,
        });
        this.hooks.status?.(describeRetryStatus(failure, step.delayMs));
        await this.hooks.sleep(step.delayMs);
        this.hooks.telemetry?.("inference.retry.started", {
          ...base,
          logical_model: modelKey(current),
          retry_delay: step.delayMs,
          attempt: attempt + 1,
        });
        if (failure.class === "model_activating" && state.activationSince === undefined) {
          state.activationSince = this.hooks.now();
        }
        // Idempotency: the retried request carries evidence of the tool
        // calls that already executed (spec §20).
        const evidence = actions?.evidenceForRetry();
        if (evidence) state.request = { ...state.request, pi_retry_evidence: evidence };
        continue;
      }

      return this.applyStep(input, base, state, startedAt, failure, attempt, step);
    }

    return { kind: "wait_capacity", failure: (failure as ClassifiedInferenceFailure) ?? this.unknownFailure(), note: "aborted mid-attempt" };
  }

  private async applyStep(
    input: LadderRunInput,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
    failure: ClassifiedInferenceFailure,
    attempt: number,
    step: RecoveryStep,
  ): Promise<ModelLoopResult> {
    switch (step.kind) {
      case "refresh_and_retry": {
        if (attempt >= this.streamPolicy.config.maxAttempts) {
          return { kind: "wait_capacity", failure, note: step.note };
        }
        // Same alias/routing target, next attempt (loop continues).
        this.hooks.status?.(step.note);
        // Re-enter the loop on the same model without resetting the count:
        // the attempt counter lives in attemptModel, so signal "continue".
        return this.refreshThenContinue(input, base, state, startedAt, failure);
      }
      case "compact_and_retry": {
        if (state.compactBudget <= 0 || !this.hooks.compactContext) {
          return {
            kind: "done",
            result: {
              ok: false,
              model: state.current,
              attempts: state.totalAttempts,
              elapsedMs: this.hooks.now() - startedAt,
              failure,
              reason: "context overflow: compaction unavailable or budget exhausted",
              incompleteGenerations: this.hooks.actions?.incompleteCount() ?? 0,
            },
          };
        }
        // compactContext is async — run it in the async wrapper.
        return this.compactThenContinue(input, base, state, startedAt, failure);
      }
      case "fallback": {
        state.tried.push(state.current);
        this.hooks.telemetry?.("inference.fallback.requested", {
          ...base,
          logical_model: modelKey(state.current),
          failure_class: failure.class,
          attempt,
          excluded: state.tried.map(modelKey),
        });
        // selectFallback is async — run it in the async wrapper.
        return this.fallbackThenContinue(input, base, state, startedAt, failure);
      }
      case "wait_capacity": {
        return { kind: "wait_capacity", failure, note: step.note };
      }
      case "fail": {
        return {
          kind: "done",
          result: {
            ok: false,
            model: state.current,
            attempts: state.totalAttempts,
            elapsedMs: this.hooks.now() - startedAt,
            failure,
            reason: step.reason,
            incompleteGenerations: this.hooks.actions?.incompleteCount() ?? 0,
          },
        };
      }
      case "retry": {
        // Handled inline in the attempt loop; unreachable here.
        return { kind: "wait_capacity", failure, note: step.note };
      }
    }
  }

  // Async step wrappers (applyStep awaits them; the decision stays pure).

  private async refreshCatalog(): Promise<void> {
    try {
      await this.hooks.refreshCatalog?.();
      this.hooks.telemetry?.("inference.catalog.refreshed", {});
    } catch {
      // A failed refresh must not block the ladder; the stale catalog stays.
    }
  }

  private async refreshThenContinue(
    input: LadderRunInput,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
    failure: ClassifiedInferenceFailure,
  ): Promise<ModelLoopResult> {
    await this.refreshCatalog();
    this.hooks.status?.("stale route · refreshing catalog");
    // The caller's attempt loop continues; but attemptModel returned, so the
    // outer run() re-enters attemptModel on the same model. We signal that by
    // returning a "fallback-free continue": model unchanged, tried unchanged.
    return this.continueSameModel(input, base, state, startedAt, failure);
  }

  private async compactThenContinue(
    input: LadderRunInput,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
    failure: ClassifiedInferenceFailure,
  ): Promise<ModelLoopResult> {
    if (state.compactBudget <= 0 || !this.hooks.compactContext) {
      return {
        kind: "done",
        result: {
          ok: false,
          model: state.current,
          attempts: state.totalAttempts,
          elapsedMs: this.hooks.now() - startedAt,
          failure,
          reason: "context overflow: compaction unavailable or budget exhausted",
          incompleteGenerations: this.hooks.actions?.incompleteCount() ?? 0,
        },
      };
    }
    state.compactBudget -= 1;
    let compacted: LadderRequest | undefined;
    try {
      compacted = await this.hooks.compactContext(state.request);
    } catch {
      compacted = undefined;
    }
    if (!compacted) {
      return {
        kind: "done",
        result: {
          ok: false,
          model: state.current,
          attempts: state.totalAttempts,
          elapsedMs: this.hooks.now() - startedAt,
          failure,
          reason: "context overflow: compaction produced no smaller context",
          incompleteGenerations: this.hooks.actions?.incompleteCount() ?? 0,
        },
      };
    }
    state.request = compacted;
    this.hooks.status?.("context overflow · compacting and retrying");
    return this.continueSameModel(input, base, state, startedAt, failure);
  }

  private async fallbackThenContinue(
    input: LadderRunInput,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
    failure: ClassifiedInferenceFailure,
  ): Promise<ModelLoopResult> {
    // Refresh the catalog first when the classifier says the route is stale
    // (no_workers / model_not_found) — fresh InferWeave state before selecting.
    if (failure.shouldRefreshCatalog || this.config.catalogRefreshOnNoWorkers) {
      await this.refreshCatalog();
    }
    let next: ModelRef | undefined;
    try {
      next = await this.hooks.selectFallback?.({
        role: input.role,
        ...(input.requiredEnvelope ? { envelope: input.requiredEnvelope } : {}),
        exclude: state.tried,
      });
    } catch {
      next = undefined;
    }
    if (!next || state.tried.some((m) => modelKey(m) === modelKey(next))) {
      state.fallbackExhausted = true;
      this.hooks.telemetry?.("inference.fallback.exhausted", {
        ...base,
        logical_model: modelKey(state.current),
        failure_class: failure.class,
        excluded: state.tried.map(modelKey),
      });
      return { kind: "wait_capacity", failure, note: "no eligible fallback model; waiting for capacity" };
    }
    state.fallbackModel = next;
    this.hooks.telemetry?.("inference.fallback.selected", {
      ...base,
      logical_model: modelKey(state.current),
      fallback_model: modelKey(next),
      failure_class: failure.class,
    });
    this.hooks.status?.(describeFallbackStatus(labelOf(state.current), labelOf(next)));
    state.current = next;
    state.activationSince = undefined;
    // The new model gets a fresh request (the logical request restarts on the
    // new model); idempotency evidence still travels with it.
    state.request = input.request;
    const evidence = this.hooks.actions?.evidenceForRetry();
    if (evidence) state.request = { ...state.request, pi_retry_evidence: evidence };
    return this.continueSameModel(input, base, state, startedAt, failure);
  }

  /**
   * Continue on the (possibly new) model in `state.current`. run() treats a
   * non-terminal result as "run the next model loop".
   */
  private continueSameModel(
    input: LadderRunInput,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
    failure: ClassifiedInferenceFailure,
  ): ModelLoopResult {
    return { kind: "fallback" };
  }

  private async waitForCapacity(
    transport: LadderTransport,
    input: LadderRunInput,
    classify: (outcome: LadderOutcome, model: ModelRef) => ClassifiedInferenceFailure,
    base: InferenceTelemetryData,
    state: LadderState,
    startedAt: number,
    failure: ClassifiedInferenceFailure,
    note: string,
  ): Promise<boolean> {
    const maxWait = this.hooks.capacityWaitMaxMs ?? DEFAULT_CAPACITY_WAIT_MAX_MS;
    const probeInterval = this.hooks.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const untilMs = this.hooks.now() + maxWait;
    this.hooks.telemetry?.("inference.mission.waiting_capacity", {
      ...base,
      failure_class: failure.class,
      attempt: state.totalAttempts,
      until_ms: untilMs,
      reason: failure.reason ?? failure.class,
      note,
    });
    this.hooks.parkForCapacity?.({
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      role: input.role,
      reason: failure.reason ?? failure.class,
      untilMs,
    });
    let waited = 0;
    while (!input.signal?.aborted) {
      if (this.hooks.now() >= untilMs) return false; // window exhausted → park
      let available: boolean;
      try {
        available = (await this.hooks.isCapacityAvailable?.()) ?? false;
      } catch {
        available = false;
      }
      if (available) {
        this.hooks.telemetry?.("inference.mission.resumed", {
          ...base,
          elapsed_wait: waited,
          attempt: state.totalAttempts,
        });
        this.hooks.status?.("inference capacity recovered · continuing");
        // Resume the SAME logical request (mission state untouched): the
        // outer run() loop continues with state.current.
        void transport;
        void classify;
        return true;
      }
      const delay = Math.min(probeInterval, untilMs - this.hooks.now());
      this.hooks.status?.(describeWaitingStatus(this.hooks.now() - startedAt, delay));
      await this.hooks.sleep(delay);
      waited += delay;
    }
    return false;
  }

  private fallbackEnabledFor(input: LadderRunInput): boolean {
    return (this.config.modelFallbackForWorkers || this.config.modelFallbackInteractive) && !input.signal?.aborted;
  }

  private unknownFailure(): ClassifiedInferenceFailure {
    return {
      class: "unknown",
      retryable: false,
      modelScoped: false,
      providerScoped: false,
      requestScoped: true,
      canFallback: false,
      shouldRefreshCatalog: false,
      shouldCompactContext: false,
      action: "fail",
      source: "none",
      reason: "unclassified inference failure",
    } as ClassifiedInferenceFailure;
  }
}

/** Short operator label for a model (the id, as served). */
export function labelOf(model: ModelRef): string {
  return model.id || `${model.provider}/${model.id}`;
}
