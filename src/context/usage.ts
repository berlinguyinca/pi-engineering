/**
 * Context accounting and the model-switch guard (spec 02, spec 05).
 *
 * Two jobs, both pure so they are testable without a Pi session:
 *
 *  1. Turn the numbers Pi exposes (context usage, resolved window) into the
 *     status-bar reading `ctx 143k/262k 55%` and into the diagnostics view.
 *  2. Decide what a model switch means. Switching to a model whose window is
 *     smaller than the current usage must trigger compaction *before* the next
 *     request goes out; switching to a larger model is always safe. Pi's native
 *     compaction engine does the actual summarization — this module only says
 *     when it is required and refuses to let a request be dispatched into a
 *     window that cannot hold it.
 */

import { formatTokens } from "./capability.ts";

export interface ContextReading {
  usedTokens: number;
  windowTokens: number;
  /** 0..1, clamped. */
  utilization: number;
  /** Compact rendering: `143k/262k 55%`. */
  label: string;
  /** True when usage is within the window but close enough to warrant attention. */
  pressure: boolean;
}

/** Warn-before threshold as a fraction of the window (spec: Pi warns ~20% left). */
export const CONTEXT_PRESSURE_RATIO = 0.8;

export function contextReading(usedTokens: number, windowTokens: number): ContextReading {
  const used = Math.max(0, Math.round(Number.isFinite(usedTokens) ? usedTokens : 0));
  const window = Math.max(1, Math.round(Number.isFinite(windowTokens) ? windowTokens : 1));
  const utilization = Math.min(1, used / window);
  return {
    usedTokens: used,
    windowTokens: window,
    utilization,
    label: `ctx ${formatTokens(used)}/${formatTokens(window)} ${Math.round(utilization * 100)}%`,
    pressure: utilization >= CONTEXT_PRESSURE_RATIO,
  };
}

export type SwitchAction = "none" | "compact" | "reject";

export interface SwitchDecision {
  action: SwitchAction;
  fromWindow: number;
  toWindow: number;
  usedTokens: number;
  /** Tokens that must come out before the new window can hold the session. */
  overflowTokens: number;
  reason: string;
}

/**
 * Decide what a model switch requires.
 *
 * The headroom mirrors Pi's own compaction threshold so the harness does not
 * compact on a different schedule than Pi would; `hardLimit` is the point past
 * which no compaction can save the request and dispatching it would be a lie.
 */
export function planModelSwitch(
  usedTokens: number,
  fromWindow: number,
  toWindow: number,
  options: { reserveOutputTokens?: number; compactionRatio?: number } = {},
): SwitchDecision {
  const used = Math.max(0, Math.round(usedTokens));
  const reserve = Math.max(0, Math.round(options.reserveOutputTokens ?? 0));
  const ratio = options.compactionRatio ?? 0.9;
  const base: Omit<SwitchDecision, "action" | "reason"> = {
    fromWindow,
    toWindow,
    usedTokens: used,
    overflowTokens: 0,
  };

  if (toWindow <= 0) {
    return { ...base, action: "reject", reason: "the target model has no known context window" };
  }
  const usable = Math.floor(toWindow * ratio) - reserve;
  if (used <= usable) {
    return {
      ...base,
      action: toWindow < fromWindow ? "none" : "none",
      reason:
        toWindow < fromWindow
          ? `narrower window (${formatTokens(fromWindow)} -> ${formatTokens(toWindow)}) still holds the session`
          : "target window is not narrower",
    };
  }
  const overflow = used - usable;
  if (usable <= 0) {
    return { ...base, overflowTokens: used, action: "reject", reason: "no room for output in the target window" };
  }
  return {
    ...base,
    overflowTokens: overflow,
    action: "compact",
    reason: `session uses ${formatTokens(used)} tokens; the ${formatTokens(toWindow)} window needs ${formatTokens(overflow)} compacted first`,
  };
}
