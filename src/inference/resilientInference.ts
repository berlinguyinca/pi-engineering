/**
 * The single unified resilient request layer (fault-tolerance spec §1/§21).
 *
 *   resilientInference.run({ request, role, model, requiredEnvelope,
 *                            missionId, workerId })
 *
 * EVERY inference caller routes through this one stack — interactive
 * engineering, planner, scout, implementer, reviewer, specialist reviewer,
 * challenge, vision worker, tournament candidate, remediation worker, spec
 * verifier, and background engineering workers. No caller implements its own
 * retry behaviour (spec §21). The pipeline inside `run`:
 *
 *   transport
 *     → capture InferWeave response metadata (success AND failure, §8)
 *     → unified failure classifier (structural, §7)
 *     → same-model retry policy with server-timing precedence (§4)
 *     → model health registry: temporary unavailability penalties (§15)
 *     → model-scoped circuit breakers (§15)
 *     → capability-based comparable-model fallback via the EXISTING
 *       RoleRouter + RequiredModelEnvelope (§12)
 *     → mission scheduler: durable WAITING_FOR_INFERENCE_CAPACITY with
 *       automatic resume through the existing long-transient-outage
 *       machinery (probe + time-based retry window) — a transient NEVER
 *       fails the mission (§4/§10).
 *
 * Task-state preservation (§19): only the failed model invocation restarts.
 * The mission id, work item, worker role, candidate/worktree, ledger state,
 * tool results, verification state, implementation progress, and context
 * hydration all travel in the caller's `request` untouched; idempotency
 * evidence for already-executed tool calls is injected before a retry (§20).
 */

import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import { ROLE_NAMES, type RoleName } from "../capability/roles.ts";
import type { RoleRouter } from "../capability/router.ts";
import type { ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import type { AdmissionHeaders } from "./admissionContract.ts";
import { CircuitBreakerRegistry } from "./circuitBreaker.ts";
import {
  type RequiredModelEnvelope,
  envelopeCapabilities,
  envelopeSatisfied,
  scoreFallbackCandidates,
} from "./envelope.ts";
import type { ClassifiedInferenceFailure, StreamTerminationState } from "./failureClassifier.ts";
import { classifyInferenceFailure } from "./failureClassifier.ts";
import type { InferenceResponseMetadata } from "./inferweaveMetadata.ts";
import { metadataFromResponse } from "./inferweaveMetadata.ts";
import { ModelHealthRegistry } from "./modelHealth.ts";
import {
  ExecutedActionTracker,
  type LadderOutcome,
  type LadderRunInput,
  type LadderRunOutcome,
  type LadderTransport,
  RecoveryLadder,
} from "./recovery.ts";
import { type InferenceResilienceConfig, resolveInferenceResilienceConfig } from "./resilienceConfig.ts";
import { InferenceTelemetry } from "./telemetry.ts";

/** One raw model invocation at the transport seam (provider-agnostic). */
export interface ResilientRawRequest {
  [key: string]: unknown;
}

export interface ResilientRawResult {
  ok: boolean;
  /** Success payload (assistant text / tool calls / structured result). */
  output?: unknown;
  /** The thrown or returned error (network error, HTTP error object, ...). */
  error?: unknown;
  status?: number;
  headers?: AdmissionHeaders;
  /** Raw body text or parsed object; only error bodies are buffered. */
  body?: unknown;
  provider?: string;
  requestedModel?: string;
  streamState?: StreamTerminationState;
}

export interface ResilientTransport {
  send(input: {
    model: ModelRef;
    request: ResilientRawRequest;
    attempt: number;
    signal?: AbortSignal;
  }): Promise<ResilientRawResult>;
}

/**
 * The EXISTING mission-side long-transient-outage machinery (recovery probe +
 * time-based retry window), exposed at the seam the ladder needs. The
 * scheduler parks the mission durably and probes capacity; the harness wires
 * the real implementation here rather than duplicating it.
 */
export interface MissionCapacityScheduler {
  park(info: { missionId?: string; workerId?: string; role: string; reason: string; untilMs: number }): void;
  isCapacityAvailable(): boolean | Promise<boolean>;
}

export interface ResilientInferenceOptions {
  transport: ResilientTransport;
  /** Environment for PI_INFERENCE_* / PI_GATEWAY_* resolution (default process.env). */
  env?: Record<string, string | undefined>;
  /** Direct config overrides (tests, harness wiring). */
  config?: Partial<InferenceResilienceConfig>;
  /** EXISTING capability registry: fallback pool + mirrored penalties. */
  registry?: ModelCapabilityRegistry;
  /** EXISTING RoleRouter: capability-based fallback selection. */
  router?: RoleRouter;
  /** Temporary unavailability penalties (default: fresh registry). */
  health?: ModelHealthRegistry;
  /** Model-scoped circuit breakers (default: fresh registry). */
  breakers?: CircuitBreakerRegistry;
  /** Structured telemetry bus (default: fresh bus). */
  telemetry?: InferenceTelemetry;
  /** Idempotency tracker for executed tool calls (default: fresh tracker). */
  actions?: ExecutedActionTracker;
  /** Mission scheduler for WAITING_FOR_INFERENCE_CAPACITY + auto-resume. */
  scheduler?: MissionCapacityScheduler;
  /** Concise user-visible status line (never stack traces). */
  status?: (line: string) => void;
  /** Compact an overflowing context before retry (spec §18). */
  compactContext?(
    request: ResilientRawRequest,
  ): Promise<ResilientRawRequest | undefined> | ResilientRawRequest | undefined;
  /** Injectable clock/sleep/random for deterministic behaviour. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Mission-level capacity wait cap (defaults mirror PI_GATEWAY_RETRY_WINDOW: 12h). */
  capacityWaitMaxMs?: number;
  /** Capacity probe cadence (existing machinery default: 10s). */
  probeIntervalMs?: number;
}

export interface ResilientRunInput {
  request: ResilientRawRequest;
  role: string;
  /** Logical model (alias). InferWeave keeps node/quant/backend selection (§14). */
  model: ModelRef;
  /** Hard requirements the original selection satisfied (§12). */
  requiredEnvelope?: RequiredModelEnvelope;
  missionId?: string;
  workerId?: string;
  signal?: AbortSignal;
  /**
   * Interactive sessions keep their own configurable fallback policy
   * (spec §21): only PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE applies.
   */
  interactive?: boolean;
}

export interface ResilientRunResult {
  ok: boolean;
  /** The raw result of the successful invocation (undefined on failure/wait). */
  raw?: ResilientRawResult;
  /** The recovery ladder's accounting for the logical request. */
  ladder: LadderRunOutcome;
  /** Response metadata of the final invocation (InferWeave headers preserved). */
  metadata?: InferenceResponseMetadata;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createResilientInference(opts: ResilientInferenceOptions): ResilientInference {
  return new ResilientInference(opts);
}

export class ResilientInference {
  private readonly transport: ResilientInferenceOptions["transport"];
  private readonly env: Record<string, string | undefined>;
  private readonly cfg: Partial<InferenceResilienceConfig>;
  private readonly registry?: ModelCapabilityRegistry;
  private readonly router?: RoleRouter;
  private readonly health: ModelHealthRegistry;
  private readonly breakers: CircuitBreakerRegistry;
  private readonly telemetry: InferenceTelemetry;
  private readonly actions: ExecutedActionTracker;
  private readonly scheduler?: MissionCapacityScheduler;
  private readonly status?: (line: string) => void;
  private readonly compactContext?: ResilientInferenceOptions["compactContext"];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly capacityWaitMaxMs?: number;
  private readonly probeIntervalMs?: number;
  /** Last raw invocation result (the caller's output on success). */
  private lastRaw: ResilientRawResult | undefined;
  private lastMetadata: InferenceResponseMetadata | undefined;

  constructor(opts: ResilientInferenceOptions) {
    this.transport = opts.transport;
    this.env = opts.env ?? (typeof process !== "undefined" && process.env ? process.env : {});
    this.cfg = opts.config ?? {};
    this.registry = opts.registry;
    this.router = opts.router;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.capacityWaitMaxMs = opts.capacityWaitMaxMs;
    this.probeIntervalMs = opts.probeIntervalMs;
    this.status = opts.status;
    this.compactContext = opts.compactContext;
    this.scheduler = opts.scheduler;

    const cfg = resolveInferenceResilienceConfig(this.env, this.cfg);
    this.telemetry = opts.telemetry ?? new InferenceTelemetry({ now: this.now });
    this.actions = opts.actions ?? new ExecutedActionTracker({ now: this.now });
    this.health =
      opts.health ??
      new ModelHealthRegistry({ now: this.now, config: { unavailabilityPenaltyMs: cfg.unavailabilityPenaltyMs } });
    this.breakers =
      opts.breakers ??
      new CircuitBreakerRegistry({
        failureThreshold: cfg.circuitFailures,
        windowMs: cfg.circuitWindowMs,
        cooldownMs: cfg.circuitCooldownMs,
        now: this.now,
        onTransition: (key, state) => {
          if (state === "CLOSED") this.telemetry.emit("inference.model.circuit_closed", { logical_model: key });
        },
      });
    // Mirror temporary unavailability into the EXISTING capability registry
    // (spec §15): the RoleRouter's health filter then excludes the model.
    if (this.registry) this.health.bindCapabilityRegistry(this.registry);
  }

  get telemetryBus(): InferenceTelemetry {
    return this.telemetry;
  }

  get actionTracker(): ExecutedActionTracker {
    return this.actions;
  }

  get healthRegistry(): ModelHealthRegistry {
    return this.health;
  }

  /**
   * Execute one logical request through the full resilient stack. Resolves
   * on success, on a permanent request failure, or with
   * `ladder.waitingForCapacity` when the mission is parked for capacity —
   * a transient infrastructure failure NEVER fails the request.
   */
  async run(input: ResilientRunInput): Promise<ResilientRunResult> {
    const config = resolveInferenceResilienceConfig(this.env, {
      ...this.cfg,
      // Interactive sessions keep their own configurable policy: the worker
      // default (PI_GATEWAY_MODEL_FALLBACK_ENABLED) does NOT apply to them.
      ...(input.interactive ? { modelFallbackForWorkers: false } : {}),
    });

    if (!config.enabled) {
      // Master switch off: one raw pass-through, metadata still captured.
      const raw = await this.sendRaw(input.model, input.request as ResilientRawRequest, 1, input.signal);
      return {
        ok: raw.ok,
        raw,
        ladder: {
          ok: raw.ok,
          model: input.model,
          attempts: 1,
          elapsedMs: 0,
          incompleteGenerations: 0,
        },
        ...(this.lastMetadata ? { metadata: this.lastMetadata } : {}),
      };
    }

    const ladder = new RecoveryLadder({
      config,
      random: this.random,
      hooks: {
        sleep: this.sleep,
        now: this.now,
        ...(this.status ? { status: this.status } : {}),
        telemetry: (name, data) => this.telemetry.emit(name, data),
        selectFallback: (query) => this.selectFallback(query),
        refreshCatalog: () => this.refreshCatalog(),
        ...(this.compactContext ? { compactContext: (req) => this.compactContext!(req as ResilientRawRequest) } : {}),
        ...(this.scheduler ? { parkForCapacity: (info) => this.scheduler!.park(info) } : {}),
        isCapacityAvailable: () => (this.scheduler ? this.scheduler.isCapacityAvailable() : false),
        ...(this.probeIntervalMs !== undefined ? { probeIntervalMs: this.probeIntervalMs } : {}),
        ...(this.capacityWaitMaxMs !== undefined ? { capacityWaitMaxMs: this.capacityWaitMaxMs } : {}),
        onModelPenalty: (model, failure) => {
          this.health.penalize(model, failure.class, {
            retryAfterMs: failure.retryAfterMs,
            reason: failure.reason ?? failure.class,
          });
        },
        onModelServed: (model) => this.health.clear(model),
        breakerFor: (model) => this.breakers.forModel(model.provider, model.id),
        actions: this.actions,
      },
    });

    const transport: LadderTransport = {
      send: ({ model, request, attempt, signal }) =>
        this.sendRaw(model, request as ResilientRawRequest, attempt, signal).then((raw) => ({
          ok: raw.ok,
          ...(raw.error !== undefined ? { error: raw.error } : {}),
          metadata: this.lastMetadata,
          ...(raw.streamState ? { streamState: raw.streamState } : {}),
        })),
    };

    const classify = (outcome: LadderOutcome, model: ModelRef): ClassifiedInferenceFailure =>
      classifyInferenceFailure({
        error: outcome.error,
        metadata: outcome.metadata,
        streamState: outcome.streamState,
        model: model.id,
        provider: model.provider,
      });

    const ladderInput: LadderRunInput = {
      request: input.request,
      role: input.role,
      model: input.model,
      ...(input.requiredEnvelope ? { requiredEnvelope: input.requiredEnvelope } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    };

    const ladderOutcome = await ladder.run(transport, ladderInput, classify);
    return {
      ok: ladderOutcome.ok,
      ...(ladderOutcome.ok && this.lastRaw?.ok ? { raw: this.lastRaw } : {}),
      ladder: ladderOutcome,
      ...(this.lastMetadata ? { metadata: this.lastMetadata } : {}),
    };
  }

  /**
   * One raw invocation + InferWeave response-metadata capture for BOTH
   * success and failure (spec §8). Never throws: a transport exception
   * becomes a failed raw result the classifier can work with.
   */
  private async sendRaw(
    model: ModelRef,
    request: ResilientRawRequest,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<ResilientRawResult> {
    let raw: ResilientRawResult;
    try {
      raw = await this.transport.send({ model, request, attempt, ...(signal ? { signal } : {}) });
    } catch (error) {
      raw = { ok: false, error, provider: model.provider, requestedModel: model.id };
    }
    this.lastRaw = raw;
    this.lastMetadata = metadataFromResponse({
      status: raw.status,
      headers: raw.headers,
      body: raw.body,
      provider: raw.provider ?? model.provider,
      requestedModel: raw.requestedModel ?? model.id,
    });
    return raw;
  }

  /**
   * Capability-based fallback (spec §12): the EXISTING RoleRouter selects
   * when the role is a known role; the envelope's hard requirements gate
   * every candidate either way. Never a string substitution.
   */
  private async selectFallback(query: {
    role: string;
    envelope?: RequiredModelEnvelope;
    exclude: ModelRef[];
  }): Promise<ModelRef | undefined> {
    const registry = this.registry;
    if (!registry) return undefined;
    const envelope: RequiredModelEnvelope = query.envelope ?? { role: query.role, requiredCapabilities: [] };
    const excluded = new Set([...query.exclude.map((m) => modelKey(m)), ...(envelope.excludedModels ?? [])]);

    // 1) The existing RoleRouter (hard filters + scoring + separation of
    //    duties). Its pool already excludes penalized/unavailable models via
    //    the registry mirror the health registry maintains.
    if (this.router && (ROLE_NAMES as readonly string[]).includes(query.role)) {
      const decision = await this.router.select({
        role: query.role as RoleName,
        exclude: [...query.exclude],
        extraRequires: envelopeCapabilities(envelope),
        ...(envelope.minimumContextTokens ? { minContext: envelope.minimumContextTokens } : {}),
        ...(envelope.localRequired ? { preferLocal: true } : {}),
      });
      const picked = decision.selected;
      if (picked && !excluded.has(modelKey(picked))) {
        const rec = registry.get(picked);
        if (!rec || envelopeSatisfied(rec, envelope)) return picked;
      }
      for (const cand of decision.candidates) {
        if (excluded.has(modelKey(cand.model))) continue;
        const rec = registry.get(cand.model);
        if (rec && envelopeSatisfied(rec, envelope)) return cand.model;
      }
    }

    // 2) Direct capability scoring over the registry (unknown roles / no
    //    router): hard gate first, spec precedence after.
    const pool = registry.all().filter((rec) => {
      const key = modelKey({ provider: rec.provider, id: rec.id });
      return rec.enabled && rec.healthy && rec.available && !excluded.has(key);
    });
    const ranked = scoreFallbackCandidates(pool, envelope, { now: this.now() });
    const best = ranked[0];
    return best ? { provider: best.record.provider, id: best.record.id } : undefined;
  }

  /** Refresh InferWeave catalog/routing state (stale route, no_workers). */
  private async refreshCatalog(): Promise<void> {
    const registry = this.registry;
    if (!registry) return;
    try {
      await registry.refresh();
    } catch {
      // A failed refresh must not block the ladder; the stale catalog stays.
    }
  }
}

/**
 * The spec's canonical entry point: `resilientInference.run({...})`. The
 * harness installs its transport + registries once at startup; every
 * inference caller then routes through the SAME instance, so retry,
 * classification, penalties, breakers, fallback, and capacity-wait behaviour
 * are identical across interactive, planner, worker, reviewer, tournament,
 * and background inference (spec §21).
 */
let defaultInstance: ResilientInference | undefined;

export function setDefaultResilientInference(instance: ResilientInference | undefined): void {
  defaultInstance = instance;
}

export const resilientInference = {
  /** Install (or clear) the process-wide resilient instance. */
  configure: (opts: ResilientInferenceOptions): ResilientInference => {
    const inst = createResilientInference(opts);
    defaultInstance = inst;
    return inst;
  },
  /** Run one logical request through the unified resilient stack. */
  run: (input: ResilientRunInput): Promise<ResilientRunResult> => {
    const inst = defaultInstance;
    if (!inst) {
      return Promise.reject(
        new Error(
          "resilientInference is not configured: call resilientInference.configure({ transport, ... }) at startup",
        ),
      );
    }
    return inst.run(input);
  },
};
