/**
 * Temporary model-availability penalties (fault-tolerance spec §15/§16).
 *
 * Model-scoped availability failures (no_workers, worker_evicted,
 * model_unavailable, model_activating) record a TEMPORARY penalty on the
 * model so every fresh worker does not immediately reselect a model the
 * gateway cannot currently serve. The penalty expires:
 *
 *   - at the server-provided timing when one was supplied (Retry-After,
 *     retry_after_ms, InferWeave retry metadata) — never shortened;
 *   - otherwise after ~2m (PI_INFERENCE_UNAVAILABLE_PENALTY).
 *
 * A model is NEVER pinned out permanently: on expiry (or on a success) it
 * automatically becomes eligible again. No permanent blacklists.
 *
 * The registry mirrors each penalty into the EXISTING ModelCapabilityRegistry
 * (`markUnavailable` + score `penalize`) so the RoleRouter's existing health
 * filter and scoring exclude and down-weight the model without any routing
 * code changes.
 */

import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import type { ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import type { InferenceFailureClass } from "./failureClassifier.ts";
import { DEFAULT_INFERENCE_RESILIENCE, type InferenceResilienceConfig } from "./resilienceConfig.ts";

/** The failure classes that earn a temporary availability penalty (spec §15). */
export const PENALTY_FAILURE_CLASSES: ReadonlySet<InferenceFailureClass> = new Set([
  "no_workers",
  "worker_evicted",
  "model_unavailable",
  "model_activating",
]);

export interface UnavailabilityPenalty {
  model: ModelRef;
  failureClass: InferenceFailureClass;
  reason: string;
  appliedAt: number;
  /** The penalty expires at this instant and the model is eligible again. */
  until: number;
  /** True when the server supplied the timing (never shortened by us). */
  serverProvided: boolean;
}

export interface ModelHealthRegistryOptions {
  now?: () => number;
  config?: Partial<InferenceResilienceConfig>;
}

export class ModelHealthRegistry {
  private readonly entries = new Map<string, UnavailabilityPenalty>();
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  /** The capability registry penalties are mirrored into, when provided. */
  private capabilityRegistry: ModelCapabilityRegistry | undefined;

  constructor(opts: ModelHealthRegistryOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.defaultTtlMs = (opts.config?.unavailabilityPenaltyMs ?? DEFAULT_INFERENCE_RESILIENCE.unavailabilityPenaltyMs);
  }

  bindCapabilityRegistry(reg: ModelCapabilityRegistry): void {
    this.capabilityRegistry = reg;
    // Mirror anything already active (e.g. across a restart).
    for (const pen of this.all()) reg.markUnavailable(pen.model, pen.until, pen.reason);
  }

  /**
   * Record a temporary unavailability for a model-scoped failure class.
   * Non-penalty classes (rate limits, gateway outages, request errors) are
   * ignored: they do not say the model is unselectable.
   */
  penalize(
    model: ModelRef,
    failureClass: InferenceFailureClass,
    opts: { retryAfterMs?: number; reason?: string } = {},
  ): UnavailabilityPenalty | undefined {
    if (!PENALTY_FAILURE_CLASSES.has(failureClass)) return undefined;
    const nowMs = this.now();
    const serverMs =
      typeof opts.retryAfterMs === "number" && Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0
        ? opts.retryAfterMs
        : undefined;
    const until = nowMs + (serverMs ?? this.defaultTtlMs);
    const reason = opts.reason ?? `inference ${failureClass}`;
    const pen: UnavailabilityPenalty = {
      model: { provider: model.provider, id: model.id },
      failureClass,
      reason,
      appliedAt: nowMs,
      until,
      serverProvided: serverMs !== undefined,
    };
    this.entries.set(modelKey(pen.model), pen);
    this.capabilityRegistry?.markUnavailable(pen.model, until, reason);
    return pen;
  }

  /** The active (not yet expired) penalty for a model, if any. */
  active(model: ModelRef): UnavailabilityPenalty | undefined {
    const pen = this.entries.get(modelKey(model));
    if (!pen) return undefined;
    if (pen.until <= this.now()) {
      this.clear(model);
      return undefined;
    }
    return pen;
  }

  isPenalized(model: ModelRef): boolean {
    return this.active(model) !== undefined;
  }

  /** Expire every penalty past its `until`. Returns how many were cleared. */
  refresh(): number {
    const nowMs = this.now();
    let cleared = 0;
    for (const [key, pen] of [...this.entries]) {
      if (pen.until <= nowMs) {
        this.entries.delete(key);
        this.capabilityRegistry?.clearUnavailable(pen.model);
        cleared++;
      }
    }
    return cleared;
  }

  /** A success on the model clears its penalty: it is eligible immediately. */
  clear(model: ModelRef): void {
    const pen = this.entries.get(modelKey(model));
    if (!pen) return;
    this.entries.delete(modelKey(model));
    this.capabilityRegistry?.clearUnavailable(pen.model);
  }

  all(): UnavailabilityPenalty[] {
    this.refresh();
    return [...this.entries.values()];
  }
}
