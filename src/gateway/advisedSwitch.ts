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

import { emitTelemetry } from "../telemetry/sink.ts";
import { type ProjectedEntry, hasVisibleOutput, lastFailedAssistant } from "./afterOutputRetry.ts";
import type { FallbackApplyResult, FallbackContext, PendingFallback } from "./fallbackLifecycle.ts";
import { ALTERNATE_MODEL_ADVICE, advisesAlternateModel, parseGatewayWait } from "./signals.ts";

interface BeforeSettleEvent {
  outcome: "completed" | "aborted" | "error";
  entries?: unknown[];
  context: { contextEntries: ProjectedEntry[] };
}

interface BoundaryResult {
  entries?: unknown[];
  continue?: boolean;
}

export interface AdvisedSwitchDeps {
  /** Take the armed fallback, if any. Plain data; clears the flag. */
  claimPending(): PendingFallback | undefined;
  /**
   * Apply a claimed fallback against the settle callback's fresh ctx. This is
   * the one call that touches the session (`pi.setModel`), and it is the
   * caller's: the extension owns the live `pi` handle and its bookkeeping.
   */
  apply(ctx: FallbackContext, pending: PendingFallback): Promise<FallbackApplyResult>;
}

/** Did this failed assistant message carry the gateway's alternate-model advice? */
export function carriesAlternateAdvice(message: { errorMessage?: string } | undefined): boolean {
  const text = message?.errorMessage ?? "";
  if (!text) return false;
  if (text.includes(ALTERNATE_MODEL_ADVICE)) return true;
  const parsed = parseGatewayWait({ text });
  return parsed ? advisesAlternateModel(parsed) : false;
}

export class AdvisedModelSwitch {
  private readonly deps: AdvisedSwitchDeps;

  constructor(deps: AdvisedSwitchDeps) {
    this.deps = deps;
  }

  /** Register on a Pi extension host (needs Pi ≥ 0.87.1 for agent_before_settle). */
  register(pi: { on(event: string, handler: (event: never, ctx: never) => unknown): void }): void {
    pi.on("agent_before_settle", ((event: BeforeSettleEvent, ctx: FallbackContext) =>
      this.onBeforeSettle(event, ctx)) as never);
  }

  async onBeforeSettle(event: BeforeSettleEvent, ctx: FallbackContext): Promise<BoundaryResult | undefined> {
    if (event.outcome !== "error") return undefined;
    const failed = lastFailedAssistant(event.context.contextEntries);
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
    if (!result.switched) {
      emitTelemetry({
        level: "warning",
        key: "advised-model-switch:stay",
        text: `The gateway advises another model for ${pending.sourceModelId ?? "the current model"}, but no stand-in fits this session (${result.reason ?? result.skipped ?? "unknown"}). Switch with /model.`,
      });
      return undefined;
    }
    emitTelemetry({
      level: "info",
      key: "advised-model-switch:continue",
      text: `${result.currentId} is out of capacity — the gateway advised another model; continuing on ${result.targetId}.`,
    });
    // Omit the failed (empty) message from the model's context, as Pi's own
    // retry would, and ask for one more provider request. Boundary results
    // REPLACE the accumulated drafts, so keep other handlers' entries.
    return {
      entries: [...(event.entries ?? []), { type: "context_edit", targetId: failed.entryId, replacement: null }],
      continue: true,
    };
  }
}
