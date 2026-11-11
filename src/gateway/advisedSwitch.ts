/**
 * Switching models on the gateway's own advice, without losing the turn.
 *
 * An InferWeave `IW-ACT-RETRY-ALTERNATE` refusal ("Try another eligible
 * deployment after the declared delay", scope `model`) is not a wait the
 * current model will end: it is the gateway saying that another deployment
 * should serve this request. The envelope names no model — the client picks —
 * and before this module the runtime had nothing to pick with mid-turn, so it
 * waited (up to `ALTERNATE_MODEL_MAX_ELAPSED_MS`) and then ended the turn
 * with "switch with /model". The operator did the switch and re-sent.
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
import { PICKER_TIMEOUT_MS, buildPickerEntries, runModelPicker } from "./advisedPicker.ts";
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
}

type BoundaryReplay = { entries: unknown[]; continue: true };

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

  constructor(deps: AdvisedSwitchDeps) {
    this.deps = deps;
  }

  /** Register on a Pi extension host (needs Pi ≥ 0.87.1 for agent_before_settle). */
  register(pi: { on(event: string, handler: (event: never, ctx: never) => unknown): void }): void {
    pi.on("agent_before_settle", ((event: BeforeSettleEvent, ctx: FallbackContext) =>
      this.onBeforeSettle(event, ctx)) as never);
    pi.on("agent_settled", (() => {
      this.stays = 0;
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
    if (!applyChosen || !select || ctx.hasUI !== true || result.skipped === "tool-started-not-replay-safe") {
      return undefined;
    }
    const entries = buildPickerEntries({
      source: ctx.model,
      available: ctx.modelRegistry?.getAvailable?.() ?? [],
      excludeIds: pending.excludeIds,
      usedTokens: ctx.getContextUsage?.()?.tokens,
      health: await this.healthOf(ctx),
      waitMs: result.blocked?.retryAfterMs ?? pending.retryAfterMs ?? DEFAULT_STAY_WAIT_MS,
      allowKeepWaiting: oweWait !== undefined,
    });
    const source = pending.sourceModelId ?? ctx.model?.id ?? "the current model";
    const outcome = await runModelPicker(select, entries, {
      title: `${source} is out of capacity and the gateway advises another model. Choose one:`,
      timeoutMs: this.deps.pickerTimeoutMs ?? PICKER_TIMEOUT_MS,
    });
    if (outcome.kind === "keep-waiting" && oweWait) {
      oweWait(ctx, outcome.delayMs, this.stays);
      return replay;
    }
    if (outcome.kind !== "picked") return undefined;
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
