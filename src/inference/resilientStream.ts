/**
 * Wiring the LIVE inference paths through the unified resilient layer
 * (fault-tolerance spec §21/§23).
 *
 * Every model invocation in this harness reaches one of two seams:
 *
 *   * a `ModelRuntime.streamSimple` — Pi's agent loop for a worker session
 *     (planner, scout, implementer, reviewer, specialist reviewer, challenge,
 *     tournament candidate, remediation worker, spec verifier, background
 *     engineering workers) and for the vision / narration / compaction calls;
 *   * a provider-registry `streamSimple` — the interactive engineering turn.
 *
 * Both already funnel through the gateway retry pump (`src/gateway/
 * streamRetry.ts`), which owns the one rule that makes replay legal: nothing
 * may reach the transcript before a retry. This module does NOT add a second
 * retry system. It installs the harness's ONE canonical decision into that
 * existing pump, per provider call:
 *
 *   response-metadata capture (InferWeave headers + status + stream state, §8)
 *     → classifyInferenceFailure (§7, structural, one classifier for all)
 *     → StreamRetryPolicy (server `Retry-After` / `retry_after_ms` as a floor, §4)
 *     → ModelHealthRegistry penalty + model-scoped circuit breaker (§15)
 *     → RecoveryLadder step (§10/§18): same-model retry | catalog refresh |
 *       capability-based comparable-model fallback through the EXISTING
 *       RoleRouter, gated by the recorded RequiredModelEnvelope (§12) |
 *       mission-level WAITING_FOR_INFERENCE_CAPACITY with automatic resume
 *       driven by the existing outage probe (§20/§21)
 *     → concise user-visible status line (§26) + structured telemetry (§26)
 *
 * A transient never fails the request: when the per-model budget is spent and
 * no comparable model exists, the flow keeps the pump alive at the probe
 * cadence and parks the mission durably, so the existing long-transient-outage
 * machinery resumes the SAME logical request.
 *
 * Idempotency (§6): when the failed generation already executed tool calls,
 * the retried request carries the concise "already done, do not repeat"
 * evidence block; the actions themselves are never replayed here.
 */

import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import { ROLE_NAMES, ROLE_REQUIREMENTS, type RoleName, routerRoleFor } from "../capability/roles.ts";
import type { RoleRouter } from "../capability/router.ts";
import {
  type ProviderResponseLike,
  type ProviderResponseOptions,
  captureGatewayAttemptResponse,
} from "../gateway/installStreamRetry.ts";
import type { GatewayWaitSignal } from "../gateway/signals.ts";
import {
  type AttemptObservation,
  type RetrySink,
  type RetryableEvent,
  type RetryableResult,
  pumpWithGatewayRetry,
} from "../gateway/streamRetry.ts";
import type { ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import { CircuitBreakerRegistry, type ModelCircuitBreaker } from "./circuitBreaker.ts";
import type { RequiredModelEnvelope } from "./envelope.ts";
import { envelopeCapabilities, envelopeSatisfied } from "./envelope.ts";
import type { ClassifiedInferenceFailure, StreamTerminationState } from "./failureClassifier.ts";
import { classifyInferenceFailure } from "./failureClassifier.ts";
import type { InferenceInvocation } from "./inferenceContext.ts";
import { metadataFromResponse } from "./inferweaveMetadata.ts";
import { ModelHealthRegistry } from "./modelHealth.ts";
import { type ExecutedActionTracker, type RecoveryStep, decideRecoveryStep } from "./recovery.ts";
import { type InferenceResilienceConfig, resolveInferenceResilienceConfig } from "./resilienceConfig.ts";
import { StreamRetryPolicy } from "./retryPolicy.ts";
import {
  type InferenceTelemetry,
  type InferenceTelemetryData,
  type InferenceTelemetryEventName,
  describeFallbackStatus,
  describeRetryStatus,
  describeWaitingStatus,
} from "./telemetry.ts";

/** Mission-side capacity machinery (the same seam `resilientInference` uses). */
export interface ResilientStreamScheduler {
  /** Durable WAITING_FOR_INFERENCE_CAPACITY park (the mission does NOT fail). */
  park(info: { missionId?: string; workerId?: string; role: string; reason: string; untilMs: number }): void;
  /** Resume notice: capacity returned, the parked request continues. */
  resumed?(info: { missionId?: string; role: string; waitedMs: number }): void;
  isCapacityAvailable(): boolean | Promise<boolean>;
}

export interface ResilientStreamOptions {
  /**
   * Which role this invocation belongs to (telemetry + capability fallback).
   * A function is resolved per provider call, so one install on a shared
   * ModelRuntime can serve every role — usually via `context()` (the
   * AsyncLocalStorage invocation) with this as the fallback.
   */
  role: string | (() => string);
  /**
   * Per-call identity (role / mission / worker / interactive). Consulted for
   * every provider call; wins over the static fields above.
   */
  context?: () => Partial<InferenceInvocation> | undefined;
  /** Identity of the model object handed to the provider call. */
  refOf(model: unknown): ModelRef;
  /** Resolve a fallback selection back to a live model object. */
  resolveModel?(ref: ModelRef): unknown | undefined;
  missionId?: string;
  workerId?: string;
  /** Interactive sessions use their OWN fallback policy (spec §21, opt-in). */
  interactive?: boolean;
  env?: Record<string, string | undefined>;
  config?: Partial<InferenceResilienceConfig>;
  registry?: ModelCapabilityRegistry;
  router?: RoleRouter;
  health?: ModelHealthRegistry;
  breakers?: CircuitBreakerRegistry;
  telemetry?: InferenceTelemetry;
  actions?: ExecutedActionTracker;
  scheduler?: ResilientStreamScheduler;
  /** Concise user-visible status line (never stack traces). */
  status?: (line: string) => void;
  /** Capacity probe cadence for the mission-level wait (existing machinery: 10s). */
  probeIntervalMs?: number;
  /** Upper bound on the mission-level capacity wait (PI_GATEWAY_RETRY_WINDOW). */
  capacityWaitMaxMs?: number;
  now?: () => number;
  random?: () => number;
}

const DEFAULT_PROBE_INTERVAL_MS = 10_000;
const DEFAULT_CAPACITY_WAIT_MAX_MS = 12 * 3_600_000;
/** Short pacing floor for a model-scoped switch (never a wait the gateway asked for). */
const FALLBACK_MIN_DELAY_MS = 1_000;

function emit(
  telemetry: InferenceTelemetry | undefined,
  name: InferenceTelemetryEventName,
  data: InferenceTelemetryData,
): void {
  telemetry?.emit(name, data);
}

/**
 * The envelope the CURRENT selection satisfies (spec §12): the router role's
 * hard requirements, plus the context window the original model actually
 * offered. A fallback that cannot do what the original could is not a
 * comparable model, so every requirement here gates the candidate.
 */
export function envelopeForSelection(role: string, record?: { contextWindow?: number }): RequiredModelEnvelope {
  const routerRole: RoleName | undefined = (ROLE_NAMES as readonly string[]).includes(role)
    ? (role as RoleName)
    : routerRoleFor(role);
  if (routerRole === undefined) {
    return {
      role,
      requiredCapabilities: [],
      ...(record?.contextWindow ? { minimumContextTokens: record.contextWindow } : {}),
    };
  }
  const required = new Set<string>(ROLE_REQUIREMENTS[routerRole].requires);
  return {
    role: routerRole,
    requiredCapabilities: [...required],
    ...(required.has("vision") ? { visionRequired: true } : {}),
    ...(required.has("tool_calling") ? { toolCallingRequired: true } : {}),
    ...(record?.contextWindow ? { minimumContextTokens: record.contextWindow } : {}),
  };
}

/**
 * One logical provider call: the per-call state of the recovery ladder.
 *
 * Retries touch ONLY the failed model invocation — role, mission, worker,
 * candidate and context all stay as the caller built them.
 */
export class ResilientAttemptFlow {
  private readonly opts: ResilientStreamOptions;
  private readonly config: InferenceResilienceConfig;
  private readonly policy: StreamRetryPolicy;
  private readonly health: ModelHealthRegistry;
  private readonly breakers: CircuitBreakerRegistry | undefined;
  private readonly now: () => number;
  readonly role: string;
  readonly missionId: string | undefined;
  readonly workerId: string | undefined;
  readonly interactive: boolean | undefined;
  private current: ModelRef;
  private readonly startedAt: number;
  private attemptOnModel = 0;
  private tried: ModelRef[] = [];
  private fallbackExhausted = false;
  private activationSince: number | undefined;
  private capacitySince: number | undefined;
  private parked = false;
  /** The classification of the attempt currently being decided (for onHold). */
  private readonly actions: ExecutedActionTracker | undefined;
  private lastFailure: ClassifiedInferenceFailure | undefined;
  private lastNote: string | undefined;

  constructor(opts: ResilientStreamOptions, model: ModelRef) {
    const call = opts.context?.() ?? {};
    this.opts = opts;
    this.role = call.role ?? (typeof opts.role === "function" ? opts.role() : opts.role);
    this.missionId = call.missionId ?? opts.missionId;
    this.workerId = call.workerId ?? opts.workerId;
    this.interactive = call.interactive ?? opts.interactive;
    this.actions = call.actions ?? opts.actions;
    this.current = model;
    this.now = opts.now ?? (() => Date.now());
    this.config = resolveInferenceResilienceConfig(opts.env ?? (typeof process !== "undefined" ? process.env : {}), {
      ...opts.config,
      // Interactive sessions never inherit the worker fallback default.
      ...(this.interactive ? { modelFallbackForWorkers: false } : {}),
    });
    this.policy = new StreamRetryPolicy({
      config: {
        enabled: this.config.streamRetryEnabled,
        maxAttempts: this.config.streamRetryMaxAttempts,
        initialDelayMs: this.config.streamRetryInitialMs,
        maxDelayMs: this.config.streamRetryMaxMs,
      },
      random: opts.random ?? Math.random,
    });
    this.health =
      opts.health ??
      new ModelHealthRegistry({
        now: this.now,
        config: { unavailabilityPenaltyMs: this.config.unavailabilityPenaltyMs },
      });
    this.breakers =
      opts.breakers ??
      new CircuitBreakerRegistry({
        failureThreshold: this.config.circuitFailures,
        windowMs: this.config.circuitWindowMs,
        cooldownMs: this.config.circuitCooldownMs,
        now: this.now,
      });
    if (opts.registry) this.health.bindCapabilityRegistry(opts.registry);
    this.startedAt = this.now();
  }

  /** The model the NEXT attempt must be sent with (possibly a fallback). */
  get model(): ModelRef {
    return this.current;
  }

  get attempts(): number {
    return this.attemptOnModel;
  }

  /** Concise status for the hold that is about to happen (spec §26). */
  statusLineFor(waitMs: number): string {
    const failure = this.lastFailure;
    if (this.capacitySince !== undefined) {
      return describeWaitingStatus(this.now() - this.startedAt, waitMs);
    }
    if (failure) return describeRetryStatus(failure, waitMs);
    return this.lastNote ?? `inference unavailable · retrying in ${Math.round(waitMs / 1000)}s`;
  }

  /**
   * The unified decision for one failed attempt. Returns the wait this layer
   * owns (honoured exactly by the pump), or `retryable: false` to settle.
   */
  async decide(observed: AttemptObservation<RetryableResult>): Promise<GatewayWaitSignal | undefined> {
    const model = this.current;
    const base: InferenceTelemetryData = {
      ...(this.missionId ? { mission_id: this.missionId } : {}),
      ...(this.workerId ? { worker_id: this.workerId } : {}),
      role: this.role,
      logical_model: modelKey(model),
      attempt: observed.attempt,
    };
    this.attemptOnModel = observed.attempt;

    const metadata = metadataFromResponse({
      ...(observed.status !== undefined ? { status: observed.status } : {}),
      ...(observed.headers ? { headers: observed.headers } : {}),
      ...(observed.text ? { body: { message: observed.text } } : {}),
      provider: model.provider,
      requestedModel: model.id,
    });
    const streamState: StreamTerminationState = {
      finished: observed.streamState.finished,
      outputCommitted: observed.streamState.outputCommitted,
      ...(observed.streamState.partialChars !== undefined ? { partialChars: observed.streamState.partialChars } : {}),
    };
    const failure = classifyInferenceFailure({
      ...(observed.thrown !== undefined ? { error: observed.thrown } : { error: new Error(observed.text) }),
      metadata,
      streamState,
      model: model.id,
      provider: model.provider,
    });
    this.lastFailure = failure;
    emit(this.opts.telemetry, "inference.failure.classified", {
      ...base,
      failure_class: failure.class,
      retry_delay: failure.retryAfterMs,
      elapsed_wait: this.now() - this.startedAt,
      classified: failure,
      metadata,
    });

    // A partial generation is recorded as `incomplete_generation` — never
    // appended to the transcript as a completed response (spec §20).
    if (failure.class === "incomplete_stream" && observed.streamState.outputCommitted) {
      emit(this.opts.telemetry, "inference.stream.incomplete", {
        ...base,
        partial_chars: observed.streamState.partialChars,
        kind: "incomplete_generation",
      });
      this.actions?.recordIncompleteGeneration({
        model: modelKey(model),
        attempt: observed.attempt,
        chars: observed.streamState.partialChars,
      });
    }

    // Spec §3 + §6: an incomplete stream retries the SAME model — but only
    // while the attempt has executed no side-effecting tool calls. Once tools
    // ran, a same-model retry would replay them (bash included) under a fresh
    // budget, so settle with the distinct non-transient truncation marker
    // instead and let the caller surface `truncated_after_progress`. Text-only
    // partials still retry: replaying generated text is side-effect free.
    if (failure.class === "incomplete_stream" && (this.actions?.list().length ?? 0) > 0) {
      this.opts.status?.("stream interrupted after executed tool calls · not replaying side effects");
      return {
        retryAfterMs: 0,
        retryable: false,
        source: "default",
        reason: "truncated_after_progress",
      };
    }

    if (failure.modelScoped) {
      this.health.penalize(model, failure.class, {
        retryAfterMs: failure.retryAfterMs,
        reason: failure.reason ?? failure.class,
      });
      const breaker = this.breakerFor(model);
      const state = breaker?.recordFailure();
      if (state === "OPEN") {
        emit(this.opts.telemetry, "inference.model.circuit_opened", { ...base, failure_class: failure.class });
      }
    }

    let step = decideRecoveryStep({
      failure,
      model,
      attempt: observed.attempt,
      fallbackEnabled: this.fallbackEnabled(),
      fallbackExhausted: this.fallbackExhausted,
      activationElapsedMs: this.activationSince !== undefined ? this.now() - this.activationSince : undefined,
      config: this.config,
      streamPolicy: this.policy,
    });
    // Breaker gating (spec §13): a model whose circuit is OPEN before its
    // cooldown is not retried on the same model — repeated failures stop
    // reselecting the bad model. Prefer the capability fallback; without one,
    // wait for capacity until the cooldown's HALF_OPEN probe re-admits it.
    // allowRequest() doubles as the re-admission: once the cooldown has
    // elapsed it arms the single HALF_OPEN probe for this retry (and the
    // probe re-opens the circuit if it fails), so the loop stays live. Only
    // model-scoped failures open breakers, so this never touches a
    // gateway/queue wait (spec §10).
    if (failure.modelScoped && step.kind !== "fallback" && !(this.breakerFor(model)?.allowRequest() ?? true)) {
      if (this.fallbackEnabled() && !this.fallbackExhausted) {
        step = { kind: "fallback", note: `${failure.class}: circuit OPEN — capability fallback` };
      } else {
        step = {
          kind: "wait_capacity",
          delayMs: this.policy.ladderDelayMs(this.attemptOnModel),
          note: `${failure.class}: circuit OPEN — waiting for capacity`,
        };
      }
    }
    return this.runStep(step, failure, base);
  }

  /**
   * Consume the HALF_OPEN single-probe slot at request start (spec §13):
   * idempotent for CLOSED, single-use while HALF_OPEN, so a tripped model
   * gets exactly one re-admission probe after its cooldown.
   */
  beginProbe(): void {
    this.breakerFor(this.model)?.beginProbe();
  }

  /** A served attempt: clear the penalty, close the breaker, end any wait. */
  served(model: ModelRef): void {
    this.health.clear(model);
    this.breakerFor(model)?.recordSuccess();
    if (this.capacitySince !== undefined) {
      const waitedMs = this.now() - this.startedAt;
      this.capacitySince = undefined;
      this.opts.scheduler?.resumed?.({
        ...(this.missionId ? { missionId: this.missionId } : {}),
        role: this.role,
        waitedMs,
      });
      emit(this.opts.telemetry, "inference.mission.resumed", {
        role: this.role,
        logical_model: modelKey(model),
        elapsed_wait: waitedMs,
      });
      this.opts.status?.("inference capacity recovered · continuing");
    }
  }

  /** Idempotency evidence for the retried request (spec §6), when any ran. */
  evidence(): string | undefined {
    return this.actions?.evidenceForRetry();
  }

  private fallbackEnabled(): boolean {
    return this.config.modelFallbackForWorkers || this.config.modelFallbackInteractive;
  }

  private breakerFor(model: ModelRef): ModelCircuitBreaker | undefined {
    return this.breakers?.forModel(model.provider, model.id);
  }

  /** Turn a ladder step into the wait the pump will honour. */
  private async runStep(
    step: RecoveryStep,
    failure: ClassifiedInferenceFailure,
    base: InferenceTelemetryData,
  ): Promise<GatewayWaitSignal | undefined> {
    this.lastNote = step.kind === "fail" ? undefined : step.note;

    switch (step.kind) {
      case "fail":
        // Permanent request errors fail fast (auth, invalid request, 413).
        this.opts.status?.(`${failure.class} · not retryable`);
        return { retryAfterMs: 0, retryable: false, source: "default", reason: failure.reason ?? failure.class };

      case "compact_and_retry":
        // Request-body fitting owns this rung (src/request/bodyBudget.ts); the
        // classifier's word is recorded so the operator sees why we replay.
        return this.wait(
          failure,
          failure.retryAfterMs ?? this.policy.ladderDelayMs(this.attemptOnModel),
          base,
          step.note,
        );

      case "fallback": {
        const next = await this.selectFallback(failure, base);
        if (!next) {
          this.fallbackExhausted = true;
          emit(this.opts.telemetry, "inference.fallback.exhausted", {
            ...base,
            failure_class: failure.class,
            excluded: [...this.tried, this.current].map(modelKey),
          });
          return this.capacityWait(failure, base, step.note);
        }
        const from = this.current;
        this.tried.push(from);
        this.current = next;
        this.attemptOnModel = 0;
        this.activationSince = undefined;
        emit(this.opts.telemetry, "inference.fallback.selected", {
          ...base,
          failure_class: failure.class,
          fallback_model: modelKey(next),
        });
        this.opts.status?.(describeFallbackStatus(from.id, next.id));
        return {
          retryAfterMs: Math.max(failure.retryAfterMs ?? 0, FALLBACK_MIN_DELAY_MS),
          retryable: true,
          source: failure.retryAfterMs !== undefined ? "body" : "default",
          reason: failure.reason ?? failure.class,
          ...((failure.model ?? this.current.id) ? { model: failure.model ?? this.current.id } : {}),
        };
      }

      case "wait_capacity":
        return this.capacityWait(failure, base, step.note);

      case "refresh_and_fail":
        // model_not_found with no comparable fallback (spec §18): refresh the
        // catalog ONCE so a just-listed model is not chased, then settle with
        // the failure visible so the caller names the model that was tried.
        await this.refreshCatalog({ ...base, failure_class: failure.class });
        this.opts.status?.(`${failure.class} · not retryable`);
        return { retryAfterMs: 0, retryable: false, source: "default", reason: failure.reason ?? failure.class };

      // "refresh_and_retry" and "retry" share the default branch (the block
      // selects the delay/refresh by step.kind); explicit labels would be
      // useless fall-throughs.
      default: {
        const delay = step.kind === "refresh_and_retry" ? this.policy.ladderDelayMs(this.attemptOnModel) : step.delayMs;
        if (step.kind === "refresh_and_retry") {
          await this.refreshCatalog({ ...base, failure_class: failure.class });
        }
        if (failure.class === "model_activating" && this.activationSince === undefined) {
          this.activationSince = this.now();
        }
        return this.wait(failure, delay, base, step.note);
      }
    }
  }

  private wait(
    failure: ClassifiedInferenceFailure,
    delayMs: number,
    base: InferenceTelemetryData,
    note: string,
  ): GatewayWaitSignal {
    const waitMs = Math.max(0, Math.round(delayMs));
    emit(this.opts.telemetry, "inference.retry.scheduled", {
      ...base,
      failure_class: failure.class,
      retry_delay: waitMs,
      note,
    });
    return {
      retryAfterMs: waitMs,
      retryable: true,
      // A server-supplied timing keeps the `body` source so the pump's
      // escalation rules leave it alone; a local ladder wait says so too.
      source: failure.retryAfterMs !== undefined ? "body" : "default",
      reason: failure.reason ?? failure.class,
      ...(failure.model ? { model: failure.model } : {}),
      status: failure.rawStatus,
    };
  }

  /**
   * Mission-level WAITING_FOR_INFERENCE_CAPACITY: park durably, keep probing
   * at the existing cadence, and let the SAME request resume when capacity
   * returns. Never a failure (spec §20/§21).
   */
  private capacityWait(
    failure: ClassifiedInferenceFailure,
    base: InferenceTelemetryData,
    note: string,
  ): GatewayWaitSignal {
    const maxWait = this.opts.capacityWaitMaxMs ?? DEFAULT_CAPACITY_WAIT_MAX_MS;
    const probe = this.opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const since = this.capacitySince ?? this.now();
    const elapsed = this.now() - since;
    const remaining = maxWait - elapsed;
    if (remaining <= 0) {
      // The retry window is exhausted: settle the stream with the failure
      // visible. The mission-level park (not this call) owns anything beyond.
      return { retryAfterMs: 0, retryable: false, source: "default", reason: failure.reason ?? failure.class };
    }
    if (!this.parked) {
      this.parked = true;
      this.capacitySince = since;
      emit(this.opts.telemetry, "inference.mission.waiting_capacity", {
        ...base,
        failure_class: failure.class,
        until_ms: since + maxWait,
        reason: failure.reason ?? failure.class,
        note,
      });
      this.opts.scheduler?.park({
        ...(this.missionId ? { missionId: this.missionId } : {}),
        ...(this.workerId ? { workerId: this.workerId } : {}),
        role: this.role,
        reason: failure.reason ?? failure.class,
        untilMs: since + maxWait,
      });
    }
    const delay = Math.min(probe, remaining);
    this.opts.status?.(describeWaitingStatus(this.now() - this.startedAt, delay));
    return { retryAfterMs: delay, retryable: true, source: "default", reason: failure.reason ?? failure.class };
  }

  /** Capability-based comparable model, via the EXISTING RoleRouter (§12). */
  private async selectFallback(
    failure: ClassifiedInferenceFailure,
    base: InferenceTelemetryData,
  ): Promise<ModelRef | undefined> {
    const { registry, router } = this.opts;
    if (!registry) return undefined;
    if (failure.shouldRefreshCatalog || this.config.catalogRefreshOnNoWorkers) {
      await this.refreshCatalog({ ...base, failure_class: failure.class });
    }
    const exclude = [...this.tried, this.current];
    const excluded = new Set(exclude.map(modelKey));
    emit(this.opts.telemetry, "inference.fallback.requested", {
      ...base,
      failure_class: failure.class,
      excluded: [...excluded],
    });
    const envelope = envelopeForSelection(this.role, registry.get(this.current));
    if (router && (ROLE_NAMES as readonly string[]).includes(envelope.role)) {
      const decision = await router.select({
        role: envelope.role as RoleName,
        exclude,
        extraRequires: envelopeCapabilities(envelope),
        ...(envelope.minimumContextTokens ? { minContext: envelope.minimumContextTokens } : {}),
      });
      const pool = [decision.selected, ...decision.candidates.map((c) => c.model)].filter(
        (m): m is ModelRef => m !== undefined,
      );
      for (const candidate of pool) {
        if (excluded.has(modelKey(candidate))) continue;
        if (this.health.isPenalized(candidate)) continue;
        // Breaker gating (spec §13): a tripped model is not reselected. The
        // check is allowRequest — OPEN before cooldown is refused, and the
        // HALF_OPEN single probe is consumed here (one probe at a time).
        if (!(this.breakerFor(candidate)?.allowRequest() ?? true)) continue;
        const record = registry.get(candidate);
        if (record && !envelopeSatisfied(record, envelope)) continue;
        if (this.opts.resolveModel && !this.opts.resolveModel(candidate)) continue;
        return candidate;
      }
      return undefined;
    }
    for (const record of registry.all()) {
      const ref: ModelRef = { provider: record.provider, id: record.id };
      if (excluded.has(modelKey(ref))) continue;
      if (!record.enabled || !record.healthy || !record.available) continue;
      if (this.health.isPenalized(ref)) continue;
      // Breaker gating (spec §13) — same rule as the router path above.
      if (!(this.breakerFor(ref)?.allowRequest() ?? true)) continue;
      if (!envelopeSatisfied(record, envelope)) continue;
      if (this.opts.resolveModel && !this.opts.resolveModel(ref)) continue;
      return ref;
    }
    return undefined;
  }

  private async refreshCatalog(base?: InferenceTelemetryData): Promise<void> {
    try {
      const result = await this.opts.registry?.refresh();
      emit(this.opts.telemetry, "inference.catalog.refreshed", {
        ...(base ?? {}),
        logical_model: modelKey(this.current),
        ...(result ? { models: result.models, changed: result.changed } : {}),
      });
    } catch {
      // A failed refresh must not block recovery; the stale catalog stays.
      emit(this.opts.telemetry, "inference.catalog.refreshed", {
        ...(base ?? {}),
        logical_model: modelKey(this.current),
        failed: true,
      });
    }
  }
}

/**
 * The classifier seam for one provider call: builds the per-call ladder state
 * and hands the pump a decision function bound to the current model.
 */
export function createResilientAttemptDecider(
  opts: ResilientStreamOptions,
  initialModel: unknown,
): {
  flow: ResilientAttemptFlow;
  classifyAttempt: (observed: AttemptObservation<RetryableResult>) => Promise<GatewayWaitSignal | undefined>;
} {
  const flow = new ResilientAttemptFlow(opts, opts.refOf(initialModel));
  return {
    flow,
    classifyAttempt: (observed) => flow.decide(observed),
  };
}

/** A context that can carry the idempotency notice (Pi's transcript context). */
interface ContextLike {
  messages?: unknown[];
}

function contextAlreadyCarries(context: ContextLike | undefined, evidence: string): boolean {
  const messages = context?.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.includes(evidence)) return true;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.includes(evidence)) return true;
      }
    }
  }
  return false;
}

/**
 * Inject the idempotency evidence into the retried request (spec §6): the
 * already-executed tool calls are LISTED, never replayed, and the injection is
 * idempotent so a second retry does not stack a second notice.
 */
export function withRetryEvidence<C>(context: C, evidence: string | undefined): C {
  if (!evidence) return context;
  const ctx = context as ContextLike | undefined;
  if (!ctx || !Array.isArray(ctx.messages)) return context;
  if (contextAlreadyCarries(ctx, evidence)) return context;
  const notice = {
    role: "user",
    content: [{ type: "text", text: evidence }],
    timestamp: Date.now(),
  };
  return { ...ctx, messages: [...ctx.messages, notice] } as C;
}

// ─── The install seam ────────────────────────────────────────────────────────

/** One provider attempt, shaped like Pi's `AssistantMessageEventStream`. */
export type ResilientAttemptStream = AsyncIterable<RetryableEvent> & { result(): Promise<RetryableResult> };

/** The `streamSimple` shape this installer wraps. */
export type ResilientStreamFunction<M, C, O> = (model: M, context: C, options?: O) => ResilientAttemptStream;

export interface ResilientStreamInstallOptions extends ResilientStreamOptions {
  /** The stream handed back to Pi; its lifetime spans every attempt. */
  createStream(): RetrySink<RetryableEvent, RetryableResult> & ResilientAttemptStream;
  /**
   * Honour a reported wait — normally the shared admission gate, so every
   * other caller in the process backs off behind the same cooldown. Receives
   * the call's abort signal so escape ends THIS hold at once.
   */
  hold(signal: GatewayWaitSignal, abort: AbortSignal | undefined, model: unknown): Promise<void>;
  /** Read the turn's abort signal off the provider options. */
  signalOf?(options: unknown): AbortSignal | undefined;
  /** Turn a thrown transport failure into an assistant error message. */
  errorMessage(model: unknown, error: unknown): RetryableResult;
  /** Elapsed budget for the whole chain (PI_GATEWAY_RETRY_WINDOW default: 12h). */
  maxElapsedMs?: number;
}

/**
 * Wrap one `streamSimple` so every provider call is decided by the unified
 * resilient layer inside the EXISTING gateway pump.
 *
 * The pump keeps its own rule — nothing may reach the transcript before a
 * replay — and the resilient flow supplies the decision the pump used to infer
 * from text: how long to wait (server timing first), whether to replay at all,
 * which model to send next, and what the operator is told.
 */
export function createResilientStreamSimple<M, C, O>(
  base: ResilientStreamFunction<M, C, O>,
  install: ResilientStreamInstallOptions,
  live?: () => ResilientStreamInstallOptions,
): ResilientStreamFunction<M, C, O> {
  return (model, context, options) => {
    // Re-arm support: the install options are resolved per call, so a
    // capability registry / router / mission scheduler / status sink that
    // arrives after the first install takes effect without a second wrap.
    const inst = live ? live() : install;
    const telemetry = inst.telemetry;
    const out = inst.createStream();
    const signal = inst.signalOf?.(options);
    const flow = new ResilientAttemptFlow(inst, inst.refOf(model));
    const identity = (extra: InferenceTelemetryData): InferenceTelemetryData => ({
      ...(flow.missionId ? { mission_id: flow.missionId } : {}),
      ...(flow.workerId ? { worker_id: flow.workerId } : {}),
      role: flow.role,
      ...extra,
    });
    let sentModel: unknown = model;
    let attemptCapture: ReturnType<typeof captureGatewayAttemptResponse> | undefined;
    emit(telemetry, "inference.request.started", identity({ logical_model: modelKey(flow.model) }));
    void (async () => {
      await pumpWithGatewayRetry<RetryableEvent, RetryableResult>(
        (attempt) => {
          // The ladder may have moved this logical request to a comparable
          // model; the request itself is unchanged apart from the idempotency
          // evidence for tool calls that already executed (spec §6).
          const ref = flow.model;
          const resolved = inst.resolveModel?.(ref);
          sentModel = resolved ?? sentModel;
          flow.beginProbe();
          const capture = captureGatewayAttemptResponse(
            (options ?? {}) as ProviderResponseOptions<ProviderResponseLike, unknown>,
          );
          attemptCapture = capture;
          return base(
            sentModel as M,
            withRetryEvidence(context, attempt > 1 ? flow.evidence() : undefined),
            capture.options as O,
          );
        },
        out,
        {
          hold: (waitSignal) => inst.hold(waitSignal, signal, sentModel),
          classifyAttempt: (observed) => flow.decide(observed),
          // Anything reached the transcript: the model served, so its penalty
          // and circuit leave the picture and any capacity wait is over.
          onProgress: () => flow.served(flow.model),
          onHold: (info) => inst.status?.(flow.statusLineFor(info.signal.retryAfterMs)),
          ...(signal ? { signal } : {}),
          ...(inst.maxElapsedMs !== undefined ? { maxElapsedMs: inst.maxElapsedMs } : {}),
          response: () => attemptCapture?.take(),
          onSettle: (settled) => {
            if (settled !== "ok") return;
            emit(
              telemetry,
              "inference.request.completed",
              identity({ logical_model: modelKey(flow.model), attempts: flow.attempts }),
            );
          },
        },
      );
    })().catch((error: unknown) => {
      // A throw the pump could not represent (never a gateway wait): Pi
      // expects a terminal event, not a rejected promise.
      const message = inst.errorMessage(sentModel, error);
      out.push({ type: "error", reason: "error", error: message } as RetryableEvent);
      out.end(message);
    });
    return out;
  };
}

const RUNTIME_WRAPPED = Symbol.for("pi-engineering.resilientInference");
const INSTALL_HOLDER = Symbol.for("pi-engineering.resilientInference.install.holder");

/** Options a re-arm may update on a live install (the rest are runtime-bound). */
const RARMABLE_INSTALL_FIELDS = [
  "role",
  "context",
  "env",
  "config",
  "registry",
  "router",
  "health",
  "breakers",
  "telemetry",
  "actions",
  "scheduler",
  "status",
  "probeIntervalMs",
  "capacityWaitMaxMs",
  "maxElapsedMs",
] as const;

function mergeInstallOptions(
  current: ResilientStreamInstallOptions,
  next: ResilientStreamInstallOptions,
): ResilientStreamInstallOptions {
  const merged: Record<string, unknown> = { ...current };
  for (const key of RARMABLE_INSTALL_FIELDS) {
    const value = next[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as ResilientStreamInstallOptions;
}

/** True when `runtime.streamSimple` is the resilient wrapper. */
export function isResilientRuntime(runtime: unknown): boolean {
  const target = runtime as { [RUNTIME_WRAPPED]?: boolean } | undefined;
  return target?.[RUNTIME_WRAPPED] === true;
}

/**
 * Install the resilient layer onto a `ModelRuntime` IN PLACE.
 *
 * One wrap covers every model invocation the runtime serves — for a worker
 * that is every turn of the agent loop (planner, scout, implementer, reviewer,
 * specialist reviewer, challenge, tournament candidate, remediation worker,
 * spec verifier, background engineering), and for the vision / narration /
 * compaction helpers their own single call. Idempotent.
 */
export function installResilientRuntime<M, C, O>(
  runtime: { streamSimple: ResilientStreamFunction<M, C, O> },
  install: ResilientStreamInstallOptions,
): "installed" | "already-installed" {
  const target = runtime as {
    [RUNTIME_WRAPPED]?: boolean;
    [INSTALL_HOLDER]?: { current: ResilientStreamInstallOptions };
  };
  if (target[RUNTIME_WRAPPED]) {
    // Re-arm: merge the new options into the live holder. The wrapper reads
    // it on every call, so a capability registry / router / mission
    // scheduler / status sink that arrives after the first install takes
    // effect immediately — production builds the capability pool AFTER the
    // worker executor (spec §23), so idempotence alone would leave the
    // fallback, park and status rungs unarmed.
    const holder = target[INSTALL_HOLDER];
    if (holder) holder.current = mergeInstallOptions(holder.current, install);
    return "already-installed";
  }
  const holder = { current: install };
  const base = runtime.streamSimple.bind(runtime) as ResilientStreamFunction<M, C, O>;
  runtime.streamSimple = createResilientStreamSimple<M, C, O>(base, install, () => holder.current);
  target[INSTALL_HOLDER] = holder;
  target[RUNTIME_WRAPPED] = true;
  return "installed";
}

export type { RetryableEvent, RetryableResult };
