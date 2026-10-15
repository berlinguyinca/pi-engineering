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
  /** The gateway's declared delay on the hold that armed an advised switch. */
  retryAfterMs?: number;
  /** Models left during this episode and when each becomes eligible again (hysteresis). */
  cooldownUntil?: Record<string, number>;
  /** A tool call has started and has no recorded outcome yet, so a stand-in might issue it again. */
  toolExecutionStarted?: boolean;
  /** Every unfinished tool call is read-only, so running it again repeats no side effect. */
  replaySafe?: boolean;
}

/**
 * Tools whose re-execution cannot repeat a side effect. Anything else (bash,
 * edit, write, a mission tool, an unknown name) is treated as side-effecting:
 * replaying a request after one of those started could run it twice.
 */
export const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/**
 * How long a model left on the gateway's advice stays excluded as a stand-in.
 * Not cleared by the next output: with capacity alternating between two
 * models, clearing on progress bounced a session A→B→A on every turn, each
 * bounce moving the operator off the model they chose. Cleared by `/model`.
 */
export const SWITCHED_FROM_TTL_MS = 10 * 60_000;

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
  /** Models already left during this outage episode: id → excluded until (epoch ms). */
  private readonly switchedFrom = new Map<string, number>();
  private advisedRetryAfterMs: number | undefined;
  /** Tool calls started and not yet ended, by call id; cleared by {@link onTurnStart}. */
  private readonly unfinishedTools = new Map<string, string>();
  private readonly now: () => number;
  private readonly switchedFromTtlMs: number;

  constructor(
    opts: {
      enabled?: boolean;
      advisedSwitch?: boolean;
      afterHolds?: number;
      now?: () => number;
      switchedFromTtlMs?: number;
    } = {},
  ) {
    this.enabled = opts.enabled ?? false;
    this.advisedSwitch = opts.advisedSwitch ?? false;
    this.afterHolds = opts.afterHolds ?? FALLBACK_AFTER_HOLDS;
    this.now = opts.now ?? Date.now;
    this.switchedFromTtlMs = opts.switchedFromTtlMs ?? SWITCHED_FROM_TTL_MS;
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
      /** The declared delay on this hold, kept for a switch that cannot be made. */
      retryAfterMs?: number;
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
    const advised = info.advisesAlternate === true && this.willSwitchOnAdvice;
    // A hold the pump is about to abandon (no wait taken) is not evidence of
    // a saturated model the way a waited-out hold is; it must not inflate the
    // opt-in ledger, least of all across Pi's own retries of the same turn.
    if (this.enabled && !advised) this.consecutiveHolds++;
    if (this.fallbackPending) return;
    if (advised) {
      this.arm("gateway-advised-alternate", info);
      return;
    }
    if (this.enabled && this.consecutiveHolds >= this.afterHolds) this.arm("gateway-admission-hold", info);
  }

  private arm(reason: FallbackReason, info: { modelId?: string; provider?: string; retryAfterMs?: number }): void {
    this.fallbackPending = true;
    this.requestedAt = this.now();
    this.reason = reason;
    this.sourceModelId = info.modelId;
    this.sourceProvider = info.provider;
    this.advisedRetryAfterMs = info.retryAfterMs;
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

  /**
   * A tool call started. Until {@link noteToolEnded} records its outcome, a
   * stand-in model could issue the same call again, so while a side-effecting
   * tool is unfinished a switch is refused. A finished call has its result in
   * the session context and is not re-executed by a new model.
   */
  noteToolStarted(toolName: string, callId: string): void {
    this.unfinishedTools.set(callId, toolName);
  }

  /** The tool call finished (its result is recorded in the context). */
  noteToolEnded(callId: string): void {
    this.unfinishedTools.delete(callId);
  }

  /** A new user turn begins: nothing unfinished can be replayed into it. */
  onTurnStart(): void {
    this.unfinishedTools.clear();
  }

  /** A stream produced output: the consecutive-hold run is over. */
  onProgress(): void {
    this.consecutiveHolds = 0;
  }

  /**
   * The session moved to a stand-in. The new model starts with a clean hold
   * ledger, and the model just left stays excluded for SWITCHED_FROM_TTL_MS
   * (or until the operator picks a model), so two models short of capacity
   * cannot trade the session back and forth.
   */
  onSwitched(fromId: string | undefined): void {
    this.consecutiveHolds = 0;
    if (fromId) this.switchedFrom.set(fromId, this.now() + this.switchedFromTtlMs);
  }

  private liveExclusions(): string[] {
    const now = this.now();
    for (const [id, until] of this.switchedFrom) if (until <= now) this.switchedFrom.delete(id);
    return [...this.switchedFrom.keys()];
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
    this.unfinishedTools.clear();
    this.consecutiveHolds = 0;
    this.fallbackPending = false;
    this.requestedAt = undefined;
    this.reason = undefined;
    this.sourceModelId = undefined;
    this.sourceProvider = undefined;
    this.advisedRetryAfterMs = undefined;
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
    const excludeIds = this.liveExclusions();
    return {
      consecutiveHolds: this.consecutiveHolds,
      ...(this.fallbackPending
        ? {
            requestedAt: this.requestedAt,
            reason: this.reason,
            sourceModelId: this.sourceModelId,
            sourceProvider: this.sourceProvider,
            ...(excludeIds.length > 0 ? { excludeIds, cooldownUntil: this.liveCooldowns() } : {}),
            ...(this.advisedRetryAfterMs !== undefined ? { retryAfterMs: this.advisedRetryAfterMs } : {}),
            ...(this.unfinishedTools.size > 0
              ? {
                  toolExecutionStarted: true,
                  replaySafe: [...this.unfinishedTools.values()].every((name) => REPLAY_SAFE_TOOLS.has(name)),
                }
              : {}),
          }
        : {}),
    };
  }

  private liveCooldowns(): Record<string, number> {
    const now = this.now();
    const out: Record<string, number> = {};
    for (const [id, until] of this.switchedFrom) if (until > now) out[id] = until;
    return out;
  }

  /** Models left during this outage episode, for a lifecycle-time preview. */
  get excludedModelIds(): string[] {
    return this.liveExclusions();
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
    this.advisedRetryAfterMs = undefined;
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
  /** Clock for the cool-down check; defaults to `Date.now`. */
  now?: () => number;
  /** Jitter source for Retry-After, in [0, 1]; defaults to `Math.random`. */
  random?: () => number;
}

export interface FallbackApplyResult {
  /** Whether the session actually switched models. */
  switched: boolean;
  currentId?: string;
  targetId?: string;
  reason?: string;
  /** Why no switch was made. Diagnostic only — never a reason to throw. */
  skipped?: string;
  /** Set (with `skipped: "blocked"`) when no qualified model exists: the bounded wait to take instead. */
  blocked?: { maxWaitMs: number; retryAfterMs: number; reason: string };
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
    ...(reading.capabilities !== undefined ? { capabilities: reading.capabilities } : {}),
    ...(reading.tools !== undefined ? { tools: reading.tools } : {}),
    ...(reading.alias === true ? { alias: true } : {}),
  };
}

type FallbackChoice =
  | { action: "switch"; current: Model<any>; target: Model<any>; reason: string }
  | { action: "stay"; skipped: string; reason?: string }
  | { action: "blocked"; reason: string; maxWaitMs: number; retryAfterMs: number };

/**
 * The switch decision against a FRESH context: the catalogue, the measured
 * context size and (optionally) gateway readiness, run through the chooser.
 * Pure apart from the health probe; touches nothing on the session.
 */
async function chooseFallback(
  deps: Pick<FallbackApplyDeps, "healthFor" | "log" | "now" | "random">,
  ctx: FallbackContext,
  pending: Pick<PendingFallback, "sourceModelId" | "excludeIds" | "cooldownUntil" | "retryAfterMs">,
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
    nowMs: (deps.now ?? Date.now)(),
    ...(pending.cooldownUntil ? { cooldownUntil: pending.cooldownUntil } : {}),
    ...(pending.retryAfterMs !== undefined ? { retryAfterMs: pending.retryAfterMs } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  });
  if (decision.action === "blocked") {
    deps.log?.(`[gateway-fallback] blocked current=${current.id} (${decision.reason})`);
    return {
      action: "blocked",
      reason: decision.reason,
      maxWaitMs: decision.maxWaitMs,
      retryAfterMs: decision.retryAfterMs,
    };
  }
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
  // No blind replay: once a side-effecting tool call has started in the turn,
  // moving the request to another model could run it a second time.
  if (pending.toolExecutionStarted === true && pending.replaySafe !== true) {
    ctx.ui?.notify(
      "Model switch skipped: a tool call already started this turn and is not replay-safe. Waiting on the current model.",
      "warning",
    );
    deps.log?.("[gateway-fallback] stay (tool call started, not replay-safe)");
    return { switched: false, skipped: "tool-started-not-replay-safe" };
  }
  const choice = await chooseFallback(deps, ctx, pending);
  if (choice.action === "blocked") {
    ctx.ui?.notify(
      `${ctx.model?.id ?? "The current model"} has no capacity and ${choice.reason}. Retrying in ${choice.retryAfterMs} ms.`,
      "warning",
    );
    return {
      switched: false,
      skipped: "blocked",
      reason: choice.reason,
      blocked: { maxWaitMs: choice.maxWaitMs, retryAfterMs: choice.retryAfterMs, reason: choice.reason },
    };
  }
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
