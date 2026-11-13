/**
 * Switching models on the gateway's own advice, without losing the turn.
 *
 * An InferWeave `IW-ACT-RETRY-ALTERNATE` refusal ("Try another eligible
 * deployment after the declared delay", scope `model`) is not a wait the
 * current model will end: it is the gateway saying that another deployment
 * should serve this request. The envelope names no model — the client picks —
 * and before this module the runtime had nothing to pick with mid-turn, so it
 * waited (up to `ALTERNATE_MODEL_MAX_ELAPSED_MS`) and then ended the turn
 * with "switch with /model". The operator did the switch and re-sent. With a
 * live UI and no stand-in the pump now abandons at the FIRST refusal and the
 * settle handler opens the picker at once (`pickerFirst`).
 *
 * Now the pieces fit together across the three places they have to live:
 *
 * 1. a lifecycle callback (`before_agent_start`, `model_select`) previews the
 *    catalogue against the live session and records a plain boolean on the
 *    `FallbackCoordinator`: "a stand-in exists";
 * 2. the gateway pump (`streamRetry.ts`), on an advised hold, arms the
 *    coordinator and — when that boolean is set — settles at once instead of
 *    waiting (`abandonForAlternate`), with the advice on the error message;
 * 3. this module, on `agent_before_settle`, claims the armed fallback, applies
 *    it against THAT callback's fresh ctx (`pi.setModel`), omits the failed
 *    empty message from context and asks Pi for one more provider request
 *    (`continue: true`), which the agent loop sends on the new model.
 *
 * Ownership stays disjoint with `AfterOutputRetry`, which also listens at the
 * settle boundary: that one replays a turn cut AFTER visible output; this one
 * acts only on a failure with NO visible output that carries the alternate
 * advice. When nothing is armed — the switch is off, no stand-in fits, the
 * hold was waited out and the budget spent — the turn ends with the advice
 * exactly as before.
 *
 * Lifecycle (INV: session-bound Pi objects MUST NOT be retained): the only
 * session touch is inside the settle handler, through `deps.apply`, with the
 * ctx that handler was given. Nothing here stores a ctx.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelHealthProvider } from "../models/health.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { PICKER_TIMEOUT_MS, type PickerOutcome, buildPickerEntries, runModelPicker } from "./advisedPicker.ts";
import { type ProjectedEntry, hasVisibleOutput, lastFailedAssistant } from "./afterOutputRetry.ts";
import type { FallbackApplyResult, FallbackContext, PendingFallback } from "./fallbackLifecycle.ts";
import {
  ALTERNATE_MODEL_ADVICE,
  ALTERNATE_MODEL_SWITCHING,
  advisesAlternateModel,
  parseGatewayWait,
} from "./signals.ts";

interface BeforeSettleEvent {
  outcome: "completed" | "aborted" | "error";
  entries?: unknown[];
  context?: { contextEntries?: ProjectedEntry[] };
}

interface BoundaryResult {
  entries?: unknown[];
  continue?: boolean;
}

/**
 * Why the settle boundary and not `turn_end`: Pi's agent loop calls
 * `finishTurn` for an errored turn but IGNORES its decision and ends the run
 * (pi-agent-core agent-loop.js: `stopReason === "error"` → finishTurn →
 * agent_end → return), so a `continue` from `turn_end` cannot resume an
 * errored turn. `agent_before_settle` can. It runs after Pi's own auto-retry,
 * which is why the abandoned attempt's text (ALTERNATE_MODEL_SWITCHING)
 * carries nothing Pi's retry classifier would act on.
 */

/** Consecutive "no stand-in fits, wait instead" continues before the turn is let go. */
export const MAX_STAY_CONTINUES = 3;
/**
 * Consecutive picker timeouts (nobody answered) before the episode stops
 * prompting and just waits. Each replay is a NEW request, so the pump's 15
 * minute chain budget restarts every time; this bound (20 x ~45 s) keeps an
 * unattended turn from being re-prompted for ever.
 */
export const MAX_PICKER_TIMEOUTS = 20;
/** The wait owed on a stay when the hold carried no delay of its own. */
export const DEFAULT_STAY_WAIT_MS = 20_000;

export interface AdvisedSwitchDeps {
  /** Take the armed fallback, if any. Plain data; clears the flag. */
  claimPending(): PendingFallback | undefined;
  /**
   * Apply a claimed fallback against the settle callback's fresh ctx. This is
   * the one call that touches the session (`pi.setModel`), and it is the
   * caller's: the extension owns the live `pi` handle and its bookkeeping.
   */
  apply(ctx: FallbackContext, pending: PendingFallback): Promise<FallbackApplyResult>;
  /**
   * Owe `delayMs` before the next request on the CURRENT model (the gateway
   * wrapper takes it, abortably, before sending). Used when the stand-in on
   * record is gone by the time the turn settles: the pump already gave up the
   * hold, so the wait it skipped is taken here and the turn continues on the
   * same model — never worse than having waited in the first place.
   */
  oweWait?(ctx: FallbackContext, delayMs: number, attempt: number): void;
  /**
   * Switch to the model the operator picked (the interactive picker offered
   * when no stand-in fits). Same ownership as `apply`: the caller holds the
   * live `pi`. Without it the picker is never offered.
   */
  applyChosen?(ctx: FallbackContext, model: Model<any>, pending: PendingFallback): Promise<FallbackApplyResult>;
  /** Gateway readiness for the picker's rows; optional and allowed to throw. */
  healthFor?(ctx: FallbackContext): Promise<ModelHealthProvider | undefined> | ModelHealthProvider | undefined;
  /** How long the picker waits for an answer; defaults to {@link PICKER_TIMEOUT_MS}. */
  pickerTimeoutMs?: number;
  /** The operator explicitly chose "Keep waiting" (or the timeout bound is spent): the pump must not abandon for the picker again this episode. */
  noteKeepWaiting?(): void;
  /** The operator chose Cancel: later settle handlers must leave the turn ended. */
  noteOperatorDeclined?(): void;
  /** The agent run settled (`agent_settled`): the episode is over. */
  onSettled?(): void;
}

type BoundaryReplay = { entries: unknown[]; continue: true };

/** Is the settle ctx still bound to a live session? Reading `model` asserts it. */
function isCtxLive(ctx: FallbackContext): boolean {
  try {
    void ctx.model;
    return true;
  } catch {
    return false;
  }
}

/** Did this failed assistant message carry the gateway's alternate-model advice? */
export function carriesAlternateAdvice(message: { errorMessage?: string } | undefined): boolean {
  const text = message?.errorMessage ?? "";
  if (!text) return false;
  if (text.includes(ALTERNATE_MODEL_ADVICE) || text.includes(ALTERNATE_MODEL_SWITCHING)) return true;
  const parsed = parseGatewayWait({ text });
  return parsed ? advisesAlternateModel(parsed) : false;
}

export class AdvisedModelSwitch {
  private readonly deps: AdvisedSwitchDeps;
  private stays = 0;
  /** Consecutive picker timeouts; reset by any answer and by agent_settled. */
  private timeouts = 0;

  constructor(deps: AdvisedSwitchDeps) {
    this.deps = deps;
  }

  /** Register on a Pi extension host (needs Pi ≥ 0.87.1 for agent_before_settle). */
  register(pi: { on(event: string, handler: (event: never, ctx: never) => unknown): void }): void {
    pi.on("agent_before_settle", ((event: BeforeSettleEvent, ctx: FallbackContext) =>
      this.onBeforeSettle(event, ctx)) as never);
    pi.on("agent_settled", (() => {
      this.stays = 0;
      this.timeouts = 0;
      this.deps.onSettled?.();
    }) as never);
  }

  async onBeforeSettle(event: BeforeSettleEvent, ctx: FallbackContext): Promise<BoundaryResult | undefined> {
    if (event.outcome !== "error") {
      this.stays = 0;
      return undefined;
    }
    const failed = lastFailedAssistant(event.context?.contextEntries ?? []);
    // After visible output the replay belongs to AfterOutputRetry; a failure
    // without the advice is somebody else's (or nobody's) to act on.
    if (!failed || hasVisibleOutput(failed.message) || !carriesAlternateAdvice(failed.message)) return undefined;
    const pending = this.deps.claimPending();
    // Nothing armed: the hold was waited out or the switch is off. The turn
    // ends with the advice on it, as it always did.
    if (!pending) return undefined;

    // The pump abandoned this hold at the FIRST refusal because no stand-in
    // fits but an operator can be asked: go straight to the picker, no
    // automatic attempt and no stay-waits first.
    if (pending.pickerFirst === true) return this.onPickerFirst(event, ctx, pending, failed);

    let result: FallbackApplyResult;
    try {
      result = await this.deps.apply(ctx, pending);
    } catch (error) {
      emitTelemetry({
        level: "warning",
        key: "advised-model-switch:failed",
        text: `Could not switch models on the gateway's advice: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
    // Omit the failed (empty) message from the model's context, as Pi's own
    // retry would, and ask for one more provider request. Boundary results
    // REPLACE the accumulated drafts, so keep other handlers' entries.
    const replay: BoundaryReplay = {
      entries: [...(event.entries ?? []), { type: "context_edit", targetId: failed.entryId, replacement: null }],
      continue: true,
    };
    if (!result.switched) {
      // The stand-in recorded at turn start no longer fits (the context grew,
      // or compaction left its size unknown). The pump skipped the hold on
      // the strength of that record, so take the declared delay now and go on
      // with the same model — bounded, so a record that keeps lying cannot
      // keep a turn in this loop.
      const why = result.reason ?? result.skipped ?? "unknown";
      if (!this.deps.oweWait || ++this.stays > MAX_STAY_CONTINUES) {
        const chosen = await this.offerPicker(ctx, pending, result, replay);
        if (chosen) return chosen;
        emitTelemetry({
          level: "warning",
          key: "advised-model-switch:stay",
          text: `The gateway advises another model for ${pending.sourceModelId ?? "the current model"}, but no stand-in fits this session (${why}). Switch with /model.`,
        });
        return undefined;
      }
      // A BLOCKED result carries its own bounded, jittered delay (autospec #158).
      const delayMs = result.blocked?.retryAfterMs ?? pending.retryAfterMs ?? DEFAULT_STAY_WAIT_MS;
      this.deps.oweWait(ctx, delayMs, this.stays);
      emitTelemetry({
        level: "info",
        key: "advised-model-switch:wait",
        text: `The gateway advises another model for ${pending.sourceModelId ?? "the current model"}, but no stand-in fits this session (${why}); waiting ${Math.round(delayMs / 1000)}s and retrying on it (${this.stays}/${MAX_STAY_CONTINUES}).`,
      });
      return replay;
    }
    this.stays = 0;
    emitTelemetry({
      level: "info",
      key: "advised-model-switch:continue",
      text: `${result.currentId} is out of capacity — the gateway advised another model; continuing on ${result.targetId}.`,
    });
    return replay;
  }

  private async onPickerFirst(
    event: BeforeSettleEvent,
    ctx: FallbackContext,
    pending: PendingFallback,
    failed: { entryId: string },
  ): Promise<BoundaryResult | undefined> {
    const replay: BoundaryReplay = {
      entries: [...(event.entries ?? []), { type: "context_edit", targetId: failed.entryId, replacement: null }],
      continue: true,
    };
    const none: FallbackApplyResult = { switched: false, skipped: "stay", reason: "no stand-in fits this session" };
    if (this.canOffer(ctx, none)) {
      const chosen = await this.offerPicker(ctx, pending, none, replay);
      if (chosen) return chosen;
      emitTelemetry({
        level: "warning",
        key: "advised-model-switch:stay",
        text: `The gateway advises another model for ${pending.sourceModelId ?? "the current model"} and no stand-in fits this session. Switch with /model.`,
      });
      return undefined;
    }
    // The UI went away between the hold and the settle (or the replay is
    // unsafe): the pump skipped the wait, so owe it here, on the same model.
    if (!this.deps.oweWait || pending.toolExecutionStarted === true) return undefined;
    this.deps.noteKeepWaiting?.();
    this.deps.oweWait(ctx, pending.retryAfterMs ?? DEFAULT_STAY_WAIT_MS, 1);
    return replay;
  }

  private canOffer(ctx: FallbackContext, result: FallbackApplyResult): boolean {
    return (
      this.deps.applyChosen !== undefined &&
      ctx.ui?.select !== undefined &&
      ctx.hasUI === true &&
      result.skipped !== "tool-started-not-replay-safe"
    );
  }

  /**
   * No stand-in fits and the automatic waits are spent: let an operator at a
   * live UI choose. Anything but an applied choice or an explicit "keep
   * waiting" returns undefined, and the caller ends the turn as it always did.
   */
  private async offerPicker(
    ctx: FallbackContext,
    pending: PendingFallback,
    result: FallbackApplyResult,
    replay: BoundaryReplay,
  ): Promise<BoundaryReplay | undefined> {
    const { applyChosen, oweWait } = this.deps;
    const select = ctx.ui?.select;
    // A refusal for an unsafe replay would refuse the pick too; do not ask.
    if (!applyChosen || !select || !this.canOffer(ctx, result)) return undefined;
    const waitMs = result.blocked?.retryAfterMs ?? pending.retryAfterMs ?? DEFAULT_STAY_WAIT_MS;
    const entries = buildPickerEntries({
      source: ctx.model,
      available: ctx.modelRegistry?.getAvailable?.() ?? [],
      excludeIds: pending.excludeIds,
      usedTokens: ctx.getContextUsage?.()?.tokens,
      health: await this.healthOf(ctx),
      waitMs,
      allowKeepWaiting: oweWait !== undefined,
    });
    const source = pending.sourceModelId ?? ctx.model?.id ?? "the current model";
    const answered = await runModelPicker(select, entries, {
      title: `${source} is out of capacity and the gateway advises another model. Choose one:`,
      timeoutMs: this.deps.pickerTimeoutMs ?? PICKER_TIMEOUT_MS,
    });
    // Nobody answered in time: take the owed wait once and replay, as for
    // "Keep waiting", but WITHOUT suppressing the picker: an operator who
    // looked away for a moment must still be able to pick at the next refusal,
    // so an unattended session waits in picker-timeout slices plus the
    // declared delay. Not Cancel either: a dialog nobody saw must not end the
    // turn. Bounded: each replay is a new request (the pump's chain budget
    // restarts), so after MAX_PICKER_TIMEOUTS in a row the picker is
    // suppressed and the normal hold applies. (Needs the wait seam; without
    // it the turn ends.)
    const timedOut = answered.kind === "cancelled" && answered.reason === "timeout" && oweWait !== undefined;
    const outcome: PickerOutcome = timedOut ? { kind: "keep-waiting", delayMs: waitMs } : answered;
    const suppress = outcome.kind === "keep-waiting" && (!timedOut || ++this.timeouts > MAX_PICKER_TIMEOUTS);
    if (outcome.kind !== "keep-waiting") this.timeouts = 0;
    if (suppress) this.timeouts = 0;
    // The dialog may have outlived the session (reload, /new): Pi's ctx getters
    // throw once the extension instance is invalidated (runner.js createContext
    // -> assertActive), and a stale `pi`/ctx must not be driven. Probe first.
    if (outcome.kind === "cancelled" && outcome.reason === "cancel") this.deps.noteOperatorDeclined?.();
    if (outcome.kind !== "keep-waiting" && outcome.kind !== "picked") return undefined;
    if (!isCtxLive(ctx)) {
      emitTelemetry({
        level: "warning",
        key: "advised-model-switch:failed",
        text: "The session changed while the model picker was open; leaving the turn as it ended.",
      });
      return undefined;
    }
    if (outcome.kind === "keep-waiting") {
      if (!oweWait) return undefined;
      // The operator chose to wait: grant the automatic waits again before the
      // next prompt; the wait itself is attempt 1, as for any first stay.
      this.stays = 0;
      if (suppress) this.deps.noteKeepWaiting?.();
      try {
        oweWait(ctx, outcome.delayMs, 1);
      } catch {
        return undefined;
      }
      return replay;
    }
    let applied: FallbackApplyResult;
    try {
      applied = await applyChosen(ctx, outcome.model, pending);
    } catch (error) {
      emitTelemetry({
        level: "warning",
        key: "advised-model-switch:failed",
        text: `Could not switch to ${outcome.model.id}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
    if (!applied.switched) return undefined;
    this.stays = 0;
    emitTelemetry({
      level: "info",
      key: "advised-model-switch:picked",
      text: `${source} is out of capacity — you picked ${outcome.model.id}; continuing on it.`,
    });
    return replay;
  }

  private async healthOf(ctx: FallbackContext): Promise<ModelHealthProvider | undefined> {
    try {
      return await this.deps.healthFor?.(ctx);
    } catch {
      return undefined;
    }
  }
}
