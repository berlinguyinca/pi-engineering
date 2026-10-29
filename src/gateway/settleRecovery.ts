/**
 * Last-resort recovery for a turn that ended in a retryable failure BEFORE any
 * visible output, after every earlier layer gave up.
 *
 * Who owns what at the settle boundary (`agent_before_settle`):
 *
 *   - the gateway pump waits a failure out inside one provider call, but only
 *     for a bounded time: 8 attempts / 5 minutes for a short transient (a cut
 *     stream, a timeout), 15 minutes for an advised alternate model;
 *   - `AdvisedModelSwitch` switches models, or waits at most MAX_STAY_CONTINUES
 *     times when no stand-in fits;
 *   - `AfterOutputRetry` replays a turn cut AFTER visible output, and
 *     deliberately ignores everything before it ("the pump owns it").
 *
 * When the pump's budget is spent the turn ends with the error and nobody is
 * left to act: Pi has used its own three retries as well, and the session sits
 * until the operator types "retry". The session logs show that is the common
 * stall (runs of four or more consecutive errors, resumed by hand after hours).
 *
 * This handler is the owner of that remaining case. It runs after the others,
 * acts only when none of them asked to continue, and continues the turn on a
 * paced, escalating schedule with a hard horizon — so an outage of hours is
 * waited out, a permanent failure is not, and a loop cannot spin.
 *
 * Pacing reuses AfterOutputRetry's seam: the wait is owed to the gateway
 * wrapper, which takes it abortably (Esc stops it) before the continued request
 * is sent. A model whose calls do not pass that wrapper gets no retry at all,
 * because an unpaced retry would be a tight loop.
 */

import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { classifyError } from "../guard/transient.ts";
import { isAutomaticReplayAllowed, parseAdmissionPayload } from "../inference/admissionContract.ts";
import { isBodyTooLarge } from "../request/bodyBudget.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { carriesAlternateAdvice } from "./advisedSwitch.ts";
import { type ProjectedEntry, hasVisibleOutput, lastFailedAssistant } from "./afterOutputRetry.ts";
import { parseGatewayElapsedMs } from "./config.ts";
import { isNodeUpdating, parseGatewayWait } from "./signals.ts";
import { DEFAULT_GATEWAY_MAX_ELAPSED_MS } from "./streamRetry.ts";

interface BeforeSettleEvent {
  outcome: "completed" | "aborted" | "error";
  entries?: unknown[];
  context?: { contextEntries?: ProjectedEntry[] };
}

interface BoundaryResult {
  entries?: unknown[];
  continue?: boolean;
}

/** The slice of the settle callback's ctx this handler reads. */
export interface SettleRecoveryContext {
  model?: { provider?: string; id?: string; contextWindow?: number };
}

export interface SettleRecoveryOptions {
  baseMs: number;
  capMs: number;
  /** Fraction of the delay added at random (0..1). */
  jitter: number;
  /** Give up this long after the first failure of the episode. */
  horizonMs: number;
  /** Give up after this many continues in one episode. */
  maxAttempts: number;
  /** The longest gateway-advertised wait that is honoured as is. */
  maxAdvertisedWaitMs: number;
  random?: () => number;
  now?: () => number;
}

export const DEFAULT_SETTLE_RECOVERY: SettleRecoveryOptions = {
  baseMs: 30_000,
  capMs: 5 * 60_000,
  jitter: 0.2,
  horizonMs: DEFAULT_GATEWAY_MAX_ELAPSED_MS,
  maxAttempts: 150,
  maxAdvertisedWaitMs: 10 * 60_000,
};

/** One decision, for a sink that records rather than shows (the Herdr inspector). */
export interface RecoveryDecision {
  action: "continue" | "giveup" | "unpaced";
  attempt: number;
  elapsedMs: number;
  /** What failed, in the classifier's words. */
  kind: string;
  model?: string;
  /** The wait owed before the next request (continue only). */
  delayMs?: number;
  error?: string;
}

/** The one-line, human form of a decision. */
export function describeDecision(d: RecoveryDecision): string {
  const on = d.model ? ` on ${d.model}` : "";
  if (d.action === "continue")
    return `[recovery] turn failed before any output (${d.kind})${on}; continuing in ${formatWait(d.delayMs ?? 0)} (attempt ${d.attempt})`;
  if (d.action === "giveup")
    return `[recovery] gave up${on} after ${d.attempt} attempts over ${formatWait(d.elapsedMs)} (${d.kind}); the session needs an operator`;
  return `[recovery] not recovering${on}: requests bypass the gateway wrapper, so no backoff can be applied (${d.kind})`;
}

export interface SettleRecoveryDeps {
  /** Told of every decision. Must not throw into Pi; errors are swallowed. */
  onDecision?(decision: RecoveryDecision): void;
  /** Owe `delayMs` before the next request on the current model (abortable, taken by the wrapper). */
  owe(ctx: SettleRecoveryContext, delayMs: number, attempt: number, label: string): void;
  /** Do this model's calls pass the gateway wrapper, so a wait can be taken? */
  isPaced(ctx: SettleRecoveryContext): boolean;
  /** Is a wait already owed (a previous continue whose wait was never taken)? */
  hasPendingWait(ctx: SettleRecoveryContext): boolean;
}

function positive(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Defaults, overridable with PI_SETTLE_RECOVERY_{HORIZON,BASE,CAP}_MS and
 * PI_SETTLE_RECOVERY_MAX_ATTEMPTS. PI_SETTLE_RECOVERY=0 turns the handler off.
 */
export function resolveSettleRecovery(env: Record<string, string | undefined> = process.env): SettleRecoveryOptions {
  return {
    ...DEFAULT_SETTLE_RECOVERY,
    // Follows the shared retry window, like AfterOutputRetry, so an operator who
    // bounds PI_GATEWAY_MAX_ELAPSED_MS bounds every layer.
    horizonMs:
      positive(env.PI_SETTLE_RECOVERY_HORIZON_MS) ??
      parseGatewayElapsedMs(env.PI_GATEWAY_MAX_ELAPSED_MS) ??
      DEFAULT_SETTLE_RECOVERY.horizonMs,
    baseMs: positive(env.PI_SETTLE_RECOVERY_BASE_MS) ?? DEFAULT_SETTLE_RECOVERY.baseMs,
    capMs: positive(env.PI_SETTLE_RECOVERY_CAP_MS) ?? DEFAULT_SETTLE_RECOVERY.capMs,
    maxAttempts: Math.floor(positive(env.PI_SETTLE_RECOVERY_MAX_ATTEMPTS) ?? DEFAULT_SETTLE_RECOVERY.maxAttempts),
  };
}

export function settleRecoveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PI_SETTLE_RECOVERY !== "0";
}

export interface RecoverableFailure {
  /** The gateway's own wait, when the failure advertised one. */
  advertisedWaitMs?: number;
  kind: string;
}

interface FailedLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

/**
 * Is this failed turn worth another request after a wait? Only a failure with
 * nothing on screen (output belongs to AfterOutputRetry) that waiting can fix.
 * Never an abort, a context overflow (compaction's job), an oversize body, or a
 * refusal the gateway says is final (`do_not_retry`, `fix_request`, a missing
 * model, a permanent status).
 */
export function recoverableFailure(message: FailedLike | undefined, contextWindow = 0): RecoverableFailure | undefined {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return undefined;
  if (hasVisibleOutput(message as never)) return undefined;
  const text = message.errorMessage ?? "";
  if (isBodyTooLarge(text)) return undefined;
  if (isContextOverflow(message as never, contextWindow)) return undefined;

  // Exhausted quota, spend or usage limits do not clear by waiting minutes.
  if (EXHAUSTED_LIMIT.test(text)) return undefined;

  // `node_updating` reaching the boundary means the pump already held it for
  // its whole interactive cap (ALTERNATE_MODEL_MAX_ELAPSED_MS, 15 min, or a
  // shorter PI_GATEWAY_MAX_ELAPSED_MS), past the console's updating mark (10
  // min by default, up to 1 h): the node is most likely stuck, and continuing
  // would only wait in the same refusal for hours. End the turn.
  const updating = parseGatewayWait({ text });
  if (updating && isNodeUpdating(updating)) return undefined;

  // The pump gave up on an advised alternate and no stand-in was available.
  if (carriesAlternateAdvice(message)) return { kind: "capacity (no alternate model)" };

  // An envelope that states its own replay contract is authoritative:
  // `do_not_retry`, `fix_request`, an unsafe request state or a non-replay
  // action are final, whatever default wait a looser reading would assign.
  const info = admissionInfo(text);
  if (info?.explicitReplayContract && !isAutomaticReplayAllowed(info, false)) return undefined;
  // The same holds for a bare action with no admission marker, as the final
  // refusals in the session logs are: only a wait-shaped action may be replayed.
  const action = envelopeAction(text);
  if (action && !REPLAYABLE_ACTIONS.has(action)) return undefined;

  const wait = parseGatewayWait({ text });
  if (wait) {
    if (!wait.retryable) return undefined;
    return { advertisedWaitMs: wait.retryAfterMs, kind: "gateway capacity" };
  }

  const cls = classifyError(text);
  if (!cls.retryable) return undefined;
  if (cls.category === "permanent" || cls.category === "model_unavailable" || cls.category === "context_overflow") {
    return undefined;
  }
  return { ...(cls.retryAfterMs ? { advertisedWaitMs: cls.retryAfterMs } : {}), kind: cls.reason ?? cls.category };
}

const EXHAUSTED_LIMIT =
  /\b(usage[_ -]?limit|spend(?:ing)?[_ -]?limit|monthly[_ -](?:spend|usage)|quota|billing|payment[_ -]?required|insufficient[_ -](?:funds|credits?)|credit[_ -]?balance|out of credits)\b/i;

const REPLAYABLE_ACTIONS = new Set(["backoff", "reduce_concurrency", "retry_alternate"]);

/** The `action` named by a JSON envelope embedded in an error's text, if any. */
function envelopeAction(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as { action?: unknown };
    return typeof body.action === "string" ? body.action : undefined;
  } catch {
    return undefined;
  }
}

/** The admission envelope embedded in an error's text, if it carries one. */
function admissionInfo(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return parseAdmissionPayload(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function formatWait(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export class SettleRecovery {
  private readonly deps: SettleRecoveryDeps;
  private readonly options: SettleRecoveryOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private attempt = 0;
  private firstFailureAt: number | undefined;
  private modelKey: string | undefined;

  constructor(deps: SettleRecoveryDeps, options: Partial<SettleRecoveryOptions> = {}) {
    this.deps = deps;
    this.options = { ...resolveSettleRecovery(), ...options };
    this.now = this.options.now ?? Date.now;
    this.random = this.options.random ?? Math.random;
  }

  /**
   * Register on a Pi extension host (needs Pi ≥ 0.87.1 for agent_before_settle).
   * Register AFTER AfterOutputRetry and AdvisedModelSwitch: this handler defers
   * to any earlier one that already asked to continue.
   */
  register(pi: { on(event: string, handler: (event: never, ctx: never) => unknown): void }): void {
    pi.on("agent_before_settle", ((event: BeforeSettleEvent, ctx: SettleRecoveryContext) =>
      this.onBeforeSettle(event, ctx)) as never);
    pi.on("agent_settled", (() => this.reset()) as never);
    // Settling only happens when the whole run ends, so a recovered failure in
    // the middle of a long run would keep spending one budget. A successful
    // assistant message is the end of the episode.
    pi.on("message_end", ((event: { message?: { role?: string; stopReason?: string } }) =>
      this.onMessageEnd(event.message)) as never);
  }

  onMessageEnd(message: { role?: string; stopReason?: string } | undefined): void {
    if (message?.role === "assistant" && message.stopReason !== "error") this.reset();
  }

  /** Record a decision with the injected sink; returns it as the notice's structured detail. */
  private decide(decision: RecoveryDecision): RecoveryDecision & { type: "settle-recovery" } {
    try {
      this.deps.onDecision?.(decision);
    } catch {
      // A reporting failure must never change what recovery does.
    }
    return { type: "settle-recovery", ...decision };
  }

  reset(): void {
    this.attempt = 0;
    this.firstFailureAt = undefined;
    this.modelKey = undefined;
  }

  onBeforeSettle(event: BeforeSettleEvent, ctx: SettleRecoveryContext): BoundaryResult | undefined {
    if (event.outcome !== "error") {
      // A completed turn ends the episode; Esc (aborted) ends it too, and is
      // never resumed on the operator's behalf.
      this.reset();
      return undefined;
    }
    const failed = lastFailedAssistant(event.context?.contextEntries ?? []);
    if (!failed) return undefined;
    // An earlier handler already dropped this message to continue the turn.
    const claimed = (event.entries ?? []).some(
      (entry) =>
        (entry as { type?: string; targetId?: string })?.type === "context_edit" &&
        (entry as { targetId?: string }).targetId === failed.entryId,
    );
    if (claimed) return undefined;

    const recoverable = recoverableFailure(failed.message, ctx.model?.contextWindow ?? 0);
    if (!recoverable) {
      this.reset();
      return undefined;
    }
    const errorText = failed.message.errorMessage ?? "no error text";
    // A wait is already owed: an earlier handler continued this turn on its own.
    if (this.deps.hasPendingWait(ctx)) return undefined;
    if (!this.deps.isPaced(ctx)) {
      // Retrying now would be unpaced: a tight loop for hours. Stop instead.
      emitTelemetry({
        level: "warning",
        key: "settle-recovery:unpaced",
        text: `Not recovering the failed turn: requests to ${ctx.model?.id ?? "this model"} do not pass the pi-engineering gateway wrapper, so no backoff can be applied (${errorText}).`,
        detail: this.decide({
          action: "unpaced",
          attempt: this.attempt,
          elapsedMs: 0,
          kind: recoverable.kind,
          model: ctx.model?.id,
          error: errorText,
        }),
      });
      this.reset();
      return undefined;
    }

    // The budget belongs to one model: a switch (operator or advised) starts fresh.
    const key = `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`;
    if (this.modelKey !== undefined && this.modelKey !== key) this.reset();
    this.modelKey = key;
    const now = this.now();
    this.firstFailureAt ??= now;
    const elapsed = now - this.firstFailureAt;
    if (elapsed >= this.options.horizonMs || this.attempt >= this.options.maxAttempts) {
      emitTelemetry({
        level: "warning",
        key: "settle-recovery:giveup",
        text: `Stopped recovering after ${this.attempt} attempts over ${formatWait(elapsed)} of failures (${recoverable.kind}): ${errorText}`,
        detail: this.decide({
          action: "giveup",
          attempt: this.attempt,
          elapsedMs: elapsed,
          kind: recoverable.kind,
          model: ctx.model?.id,
          error: errorText,
        }),
      });
      this.reset();
      return undefined;
    }

    this.attempt++;
    const exponent = Math.min(Math.max(0, this.attempt - 1), 30);
    const nominal = Math.min(this.options.capMs, this.options.baseMs * 2 ** exponent);
    const paced = Math.round(nominal + nominal * this.options.jitter * this.random());
    const advertised = Math.min(recoverable.advertisedWaitMs ?? 0, this.options.maxAdvertisedWaitMs);
    const delayMs = Math.max(paced, advertised);
    this.deps.owe(ctx, delayMs, this.attempt, `Turn failed (${recoverable.kind})`);
    emitTelemetry({
      level: "info",
      key: "settle-recovery:attempt",
      text: `Turn failed before any output (${recoverable.kind}); continuing in ${formatWait(delayMs)} (attempt ${this.attempt}, for up to ${formatWait(this.options.horizonMs)}; Esc stops).`,
      detail: this.decide({
        action: "continue",
        attempt: this.attempt,
        elapsedMs: elapsed,
        kind: recoverable.kind,
        model: ctx.model?.id,
        delayMs,
        error: errorText,
      }),
    });
    return {
      entries: [...(event.entries ?? []), { type: "context_edit", targetId: failed.entryId, replacement: null }],
      continue: true,
    };
  }
}
