/**
 * Lifecycle-safe model fallback for gateway admission holds.
 *
 * Invariant (INV: session-bound Pi objects MUST NOT be retained for later
 * asynchronous use):
 *
 *   GATEWAY / RETRY / DETACHED CALLBACK        PI LIFECYCLE CALLBACK
 *   (admission hold — async vs. the session)   (before_agent_start — fresh ctx)
 *          │                                          ▲
 *          │  plain data only                         │ fresh, currently-valid
 *          ▼                                          │ ExtensionCommandContext
 *      PendingFallbackState ──────────────────────────┘
 *
 * A gateway hold callback fires asynchronously with respect to the Pi session
 * lifecycle. A hold observed while session A is active can be delivered after A
 * has been replaced, reloaded, forked, or shut down — by which point any
 * captured `ExtensionCommandContext` is stale, and dereferencing it
 * (e.g. `ctx.model`) raises `assertActive` and kills the process. So the
 * background path keeps ONLY plain data: a hold count and a "pending fallback"
 * flag. The actual model selection + `pi.setModel` switch happens exclusively
 * from a lifecycle callback that supplies a currently-valid context.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelHealthProvider } from "../models/health.ts";
import { type FallbackCandidate, chooseFallbackModel } from "./fallback.ts";
import type { GatewayWaitSignal } from "./signals.ts";

/** Consecutive gateway holds before a stand-in is considered. */
export const FALLBACK_AFTER_HOLDS = 3;

/** Plain, durable diagnostic state. No Pi objects may appear here. */
export interface PendingFallback {
  consecutiveHolds: number;
  requestedAt?: number;
  reason?: string;
  sourceModelId?: string;
  sourceProvider?: string;
}

/**
 * The plain-data state machine.
 *
 * Holds a consecutive-hold count and a pending-fallback flag. Every method is
 * synchronous, and none of them may be called with, or store, a Pi context —
 * that is what keeps a stale session from leaking into an async callback.
 */
export class FallbackCoordinator {
  readonly afterHolds: number;
  private consecutiveHolds = 0;
  private fallbackPending = false;
  private requestedAt: number | undefined;
  private reason: string | undefined;
  private sourceModelId: string | undefined;
  private sourceProvider: string | undefined;

  constructor(opts: { afterHolds?: number } = {}) {
    this.afterHolds = opts.afterHolds ?? FALLBACK_AFTER_HOLDS;
  }

  /**
   * A gateway hold: count it, and arm a pending fallback at the threshold.
   *
   * Idempotent past the threshold: repeated holds while a fallback is already
   * pending re-arm nothing and cannot turn one pending fallback into several.
   */
  onGatewayHold(info: { modelId?: string; provider?: string; source?: GatewayWaitSignal["source"] } = {}): void {
    // A connection problem is not a model problem: a transport drop (the
    // gateway restarting under the stream) or a link cut (retried on a fresh
    // route) says nothing about this model's capacity, so it neither counts
    // toward a switch nor ends a run of saturation holds.
    if (info.source === "transport-drop" || info.source === "link-cut") return;
    this.consecutiveHolds++;
    if (this.consecutiveHolds >= this.afterHolds && !this.fallbackPending) {
      this.fallbackPending = true;
      this.requestedAt = Date.now();
      this.reason = "gateway-admission-hold";
      this.sourceModelId = info.modelId;
      this.sourceProvider = info.provider;
    }
  }

  /** A stream produced output: the consecutive-hold run is over. */
  onProgress(): void {
    this.consecutiveHolds = 0;
  }

  /** The operator explicitly selected a model: a stale fallback intent is void. */
  onModelSelect(): void {
    this.reset();
  }

  /** Session ended: nothing should survive into the next session. */
  onSessionShutdown(): void {
    this.reset();
  }

  private reset(): void {
    this.consecutiveHolds = 0;
    this.fallbackPending = false;
    this.requestedAt = undefined;
    this.reason = undefined;
    this.sourceModelId = undefined;
    this.sourceProvider = undefined;
  }

  get hasPending(): boolean {
    return this.fallbackPending;
  }

  get holds(): number {
    return this.consecutiveHolds;
  }

  /** A read-only copy of the current state. */
  snapshot(): PendingFallback {
    return {
      consecutiveHolds: this.consecutiveHolds,
      ...(this.fallbackPending
        ? {
            requestedAt: this.requestedAt,
            reason: this.reason,
            sourceModelId: this.sourceModelId,
            sourceProvider: this.sourceProvider,
          }
        : {}),
    };
  }

  /**
   * Claim the pending fallback.
   *
   * The flag is cleared BEFORE any asynchronous work, and the claim is
   * idempotent under concurrent calls: only the first caller receives the
   * snapshot, the rest receive `undefined`. This is what stops a burst of
   * holds from turning into multiple model switches.
   */
  claimPending(): PendingFallback | undefined {
    if (!this.fallbackPending) return undefined;
    const pending = this.snapshot();
    this.fallbackPending = false;
    this.requestedAt = undefined;
    this.reason = undefined;
    this.sourceModelId = undefined;
    this.sourceProvider = undefined;
    return pending;
  }
}

/**
 * The slice of a fresh session context the fallback switch reads.
 *
 * Deliberately structural (not the full `ExtensionCommandContext`): the
 * function must never need more than these, and a test can supply a minimal
 * stand-in without importing the live Pi types.
 */
export interface FallbackContext {
  model: Model<any> | undefined;
  modelRegistry: { getAvailable?: () => Model<any>[] } | undefined;
  getContextUsage?: () => { tokens: number } | undefined;
  ui?: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

export interface FallbackApplyDeps {
  /** Set the session's model. The live `pi.setModel`, or a stand-in in tests. */
  setModel(model: Model<any>): Promise<boolean> | boolean;
  /** Resolve gateway-reported readiness for the model, or undefined. May throw. */
  healthFor?(ctx: FallbackContext): Promise<ModelHealthProvider | undefined> | ModelHealthProvider | undefined;
  /** Debug logging; must never be a substitute for a session operation. */
  log?: (message: string) => void;
}

export interface FallbackApplyResult {
  /** Whether the session actually switched models. */
  switched: boolean;
  currentId?: string;
  targetId?: string;
  reason?: string;
  /** Why no switch was made. Diagnostic only — never a reason to throw. */
  skipped?: string;
}

function toCandidate(m: Model<any>, health?: ModelHealthProvider): FallbackCandidate {
  const reading = health?.get(m.id) ?? {};
  return {
    id: m.id,
    provider: m.provider,
    api: m.api,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    reasoning: m.reasoning === true,
    input: m.input ?? ["text"],
    ...(reading.state !== undefined ? { state: reading.state } : {}),
    ...(reading.slots !== undefined ? { slots: reading.slots } : {}),
  };
}

/**
 * Run a claimed pending fallback against a FRESH, currently-valid context.
 *
 * This is the ONLY place the session is touched, and it must be called from a
 * Pi lifecycle callback (e.g. `before_agent_start`) whose `ctx` belongs to the
 * active session — never from a gateway/retry/detached callback. Any failure
 * here degrades the fallback feature; it must not propagate as an uncaught
 * rejection that terminates Pi.
 */
export async function applyPendingFallback(
  deps: FallbackApplyDeps,
  ctx: FallbackContext,
  pending: PendingFallback,
): Promise<FallbackApplyResult> {
  const current = ctx.model;
  if (!current) return { switched: false, skipped: "no-current-model" };

  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  if (available.length < 2) {
    deps.log?.(`[gateway-fallback] stay source=${pending.sourceModelId ?? current.id} (no alternatives)`);
    return { switched: false, skipped: "no-alternatives" };
  }

  const usage = ctx.getContextUsage?.();
  // Readiness is advisory and the first probe to fail under saturation; a
  // failure there must not stop the switch decision. Guarded as an async IIFE so
  // a synchronous throw AND a rejected probe both degrade to "unknown".
  const health = await (async () => {
    try {
      return await deps.healthFor?.(ctx);
    } catch {
      return undefined;
    }
  })();

  const decision = chooseFallbackModel({
    current: toCandidate(current, health),
    available: available.map((m) => toCandidate(m, health)),
    usedTokens: usage?.tokens ?? null,
  });
  if (decision.action !== "switch") {
    deps.log?.(`[gateway-fallback] stay current=${current.id} (${decision.reason})`);
    return { switched: false, skipped: "stay", reason: decision.reason };
  }

  const target = available.find((m) => m.id === decision.model.id && m.provider === decision.model.provider);
  if (!target) return { switched: false, skipped: "target-not-found" };

  deps.log?.(`[gateway-fallback] applying current=${current.id} target=${target.id}`);
  // Announced, never silent: a model swap changes output quality, and an
  // operator who cannot see it happen cannot account for what changed.
  const switched = await deps.setModel(target);
  if (switched) {
    deps.log?.(`[gateway-fallback] switched current=${current.id} target=${target.id}`);
    ctx.ui?.notify(
      `${current.id} has no workers — switched to ${target.id} (${decision.reason}). /model to change back.`,
      "info",
    );
    return { switched: true, currentId: current.id, targetId: target.id, reason: decision.reason };
  }

  deps.log?.(`[gateway-fallback] setModel declined target=${target.id}`);
  return { switched: false, skipped: "set-model-declined" };
}
