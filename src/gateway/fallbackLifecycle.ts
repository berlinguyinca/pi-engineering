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

/** Why a fallback was armed. Drives the operator notice. */
export type FallbackReason = "gateway-admission-hold" | "gateway-advised-alternate";

/** Plain, durable diagnostic state. No Pi objects may appear here. */
export interface PendingFallback {
  consecutiveHolds: number;
  requestedAt?: number;
  reason?: FallbackReason;
  sourceModelId?: string;
  sourceProvider?: string;
  /**
   * Models this outage episode already switched away from. A stand-in that
   * is itself refused must not hand the session back to the model that was
   * just left: without this a gateway short of capacity on two models would
   * ping-pong a session between them for hours.
   */
  excludeIds?: string[];
}

/**
 * The plain-data state machine.
 *
 * Holds a consecutive-hold count and a pending-fallback flag. Every method is
 * synchronous, and none of them may be called with, or store, a Pi context —
 * that is what keeps a stale session from leaking into an async callback.
 *
 * Two triggers arm a fallback:
 *
 * - the HOLD-COUNT path (`enabled`): the runtime's own inference that a model
 *   is out, from consecutive model-scoped holds. Opt-in, because it is a
 *   guess made on the operator's behalf;
 * - the ADVISED path (`advisedSwitch`): the gateway itself says another
 *   deployment should serve this request (`IW-ACT-RETRY-ALTERNATE`). That is
 *   an instruction, not an inference, so it arms on the first such hold —
 *   but only once a lifecycle callback has recorded (`noteStandIn`) that a
 *   usable stand-in exists. With no stand-in on record the hold is waited out
 *   as before: abandoning the wait would turn a slow turn into a failed one.
 */
export class FallbackCoordinator {
  /** Disabled unless the operator explicitly opts into automatic switching. */
  readonly enabled: boolean;
  /** Act on the gateway's own "retry on an alternate" advice. */
  readonly advisedSwitch: boolean;
  readonly afterHolds: number;
  private consecutiveHolds = 0;
  private fallbackPending = false;
  private requestedAt: number | undefined;
  private reason: FallbackReason | undefined;
  private sourceModelId: string | undefined;
  private sourceProvider: string | undefined;
  /** Last lifecycle-time preview: is there a model this session could move to? */
  private standInAvailable = false;
  /** Models already left during this outage episode (plain ids). */
  private readonly switchedFrom = new Set<string>();

  constructor(opts: { enabled?: boolean; advisedSwitch?: boolean; afterHolds?: number } = {}) {
    this.enabled = opts.enabled ?? false;
    this.advisedSwitch = opts.advisedSwitch ?? false;
    this.afterHolds = opts.afterHolds ?? FALLBACK_AFTER_HOLDS;
  }

  /**
   * A gateway hold: count it, and arm a pending fallback at the threshold —
   * or at once when the gateway advises an alternate and a stand-in is known.
   *
   * Idempotent past the threshold: repeated holds while a fallback is already
   * pending re-arm nothing and cannot turn one pending fallback into several.
   */
  onGatewayHold(
    info: {
      modelId?: string;
      provider?: string;
      source?: GatewayWaitSignal["source"];
      accountWide?: boolean;
      /** The gateway's own IW-ACT-RETRY-ALTERNATE guidance on this hold. */
      advisesAlternate?: boolean;
    } = {},
  ): void {
    if (!this.enabled && !(this.advisedSwitch && info.advisesAlternate === true)) return;
    // A connection problem is not a model problem: a transport drop (the
    // gateway restarting under the stream) or a link cut (retried on a fresh
    // route) says nothing about this model's capacity, so it neither counts
    // toward a switch nor ends a run of saturation holds.
    if (info.source === "transport-drop" || info.source === "link-cut" || info.source === "empty-failure") return;
    // An account-wide refusal (a 429 / admission queue every model shares) is
    // not this model's outage either: a stand-in would wait in the same queue.
    // Only a model-scoped outage — capacity_unavailable, a reload, a GPU move —
    // makes a switch worth it, and that can last hours.
    if (info.accountWide === true) return;
    if (this.enabled) this.consecutiveHolds++;
    if (this.fallbackPending) return;
    if (this.advisedSwitch && info.advisesAlternate === true && this.standInAvailable) {
      this.arm("gateway-advised-alternate", info);
      return;
    }
    if (this.enabled && this.consecutiveHolds >= this.afterHolds) this.arm("gateway-admission-hold", info);
  }

  private arm(reason: FallbackReason, info: { modelId?: string; provider?: string }): void {
    this.fallbackPending = true;
    this.requestedAt = Date.now();
    this.reason = reason;
    this.sourceModelId = info.modelId;
    this.sourceProvider = info.provider;
  }

  /**
   * A lifecycle callback previewed the catalogue against the live session:
   * record whether a stand-in exists. Plain boolean — the preview itself ran
   * against a fresh ctx and nothing of it is retained here.
   */
  noteStandIn(available: boolean): void {
    this.standInAvailable = available;
  }

  /** Is a gateway "retry on an alternate" hold worth abandoning right now? */
  get willSwitchOnAdvice(): boolean {
    return this.advisedSwitch && this.standInAvailable;
  }

  /** A stream produced output: the consecutive-hold run is over. */
  onProgress(): void {
    this.consecutiveHolds = 0;
    this.switchedFrom.clear();
  }

  /**
   * The session moved to a stand-in. The new model starts with a clean hold
   * ledger, and the model just left stays excluded until real progress shows
   * the outage is over.
   */
  onSwitched(fromId: string | undefined): void {
    this.consecutiveHolds = 0;
    if (fromId) this.switchedFrom.add(fromId);
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
    this.switchedFrom.clear();
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
            ...(this.switchedFrom.size > 0 ? { excludeIds: [...this.switchedFrom] } : {}),
          }
        : {}),
    };
  }

  /** Models left during this outage episode, for a lifecycle-time preview. */
  get excludedModelIds(): string[] {
    return [...this.switchedFrom];
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

type FallbackChoice =
  | { action: "switch"; current: Model<any>; target: Model<any>; reason: string }
  | { action: "stay"; skipped: string; reason?: string };

/**
 * The switch decision against a FRESH context: the catalogue, the measured
 * context size and (optionally) gateway readiness, run through the chooser.
 * Pure apart from the health probe; touches nothing on the session.
 */
async function chooseFallback(
  deps: Pick<FallbackApplyDeps, "healthFor" | "log">,
  ctx: FallbackContext,
  pending: Pick<PendingFallback, "sourceModelId" | "excludeIds">,
): Promise<FallbackChoice> {
  const current = ctx.model;
  if (!current) return { action: "stay", skipped: "no-current-model" };

  const excluded = new Set(pending.excludeIds ?? []);
  const available = (ctx.modelRegistry?.getAvailable?.() ?? []).filter(
    (m) => m.id === current.id || !excluded.has(m.id),
  );
  if (available.length < 2) {
    deps.log?.(`[gateway-fallback] stay source=${pending.sourceModelId ?? current.id} (no alternatives)`);
    return { action: "stay", skipped: "no-alternatives" };
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
    return { action: "stay", skipped: "stay", reason: decision.reason };
  }

  const target = available.find((m) => m.id === decision.model.id && m.provider === decision.model.provider);
  if (!target) return { action: "stay", skipped: "target-not-found" };
  return { action: "switch", current, target, reason: decision.reason };
}

/**
 * Would a fallback switch right now? Run from a lifecycle callback with its
 * fresh ctx, so the gateway hold path can later consult a plain boolean
 * (`FallbackCoordinator.noteStandIn`) instead of a session object.
 *
 * No readiness probe: this runs on every agent start, and health only ORDERS
 * the survivors — the hard filters (context fit, modality) are what decide
 * whether a stand-in exists at all.
 */
export async function previewFallback(
  ctx: FallbackContext,
  pending: Pick<PendingFallback, "excludeIds"> = {},
): Promise<boolean> {
  const choice = await chooseFallback({}, ctx, pending);
  return choice.action === "switch";
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
  const choice = await chooseFallback(deps, ctx, pending);
  if (choice.action === "stay") {
    return { switched: false, skipped: choice.skipped, ...(choice.reason ? { reason: choice.reason } : {}) };
  }
  const { current, target, reason } = choice;

  deps.log?.(`[gateway-fallback] applying current=${current.id} target=${target.id}`);
  // Announced, never silent: a model swap changes output quality, and an
  // operator who cannot see it happen cannot account for what changed.
  const switched = await deps.setModel(target);
  if (switched) {
    deps.log?.(`[gateway-fallback] switched current=${current.id} target=${target.id}`);
    const cause =
      pending.reason === "gateway-advised-alternate"
        ? `${current.id} is out of capacity and the gateway advises another model`
        : `${current.id} has no workers`;
    ctx.ui?.notify(`${cause} — switched to ${target.id} (${reason}). /model to change back.`, "info");
    return { switched: true, currentId: current.id, targetId: target.id, reason };
  }

  deps.log?.(`[gateway-fallback] setModel declined target=${target.id}`);
  return { switched: false, skipped: "set-model-declined" };
}
