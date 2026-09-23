/**
 * APS Phase 4 — recovery (replan / conservative compaction).
 *
 * When a loop has been PREVENTED (Phase 3) or flagged (detection), this decides
 * how to RECOVER the run rather than merely terminating it. Recovery is
 * conservative and bounded:
 *
 *   - `replan`: the agent kept applying ONE strategy family to ONE target
 *     without progress. Recommend switching to a genuinely different strategy
 *     family (and, where determinable, a different target) on the next attempt.
 *   - `compact`: the agent is near its context budget AND stuck in identical
 *     no-progress turns. Recommend dropping ONLY those identical repeated turns
 *     (never useful, differing tool results) and proceeding from the last
 *     meaningful change.
 *   - `none`: no safe, deterministic recovery is warranted — do not guess.
 *
 * Hard constraints (spec §-"context discipline"): never discard useful tool
 * results; never blindly truncate conversation; compaction collapses only the
 * provably-repeated identical no-progress turns and keeps everything that
 * differs.
 */

import type { AgentLoopEvent, SemanticStrategyFamily } from "./types.ts";

/** The recovery actions the controller may recommend. */
export type ApsRecoveryAction = "replan" | "compact" | "none";

export interface ApsRecoveryOptions {
  /**
   * Context utilization at/above which a no-progress loop is treated as
   * context pressure warranting compaction. Default 0.75.
   */
  compactContextUtilization?: number;
  /** No-progress turns required (with high utilization) to recommend compact. Default 2. */
  compactNoProgressTurns?: number;
}

export interface ApsRecoveryDecision {
  action: ApsRecoveryAction;
  rationale: string;
  /** (replan) The strategy family the loop was stuck on. */
  fromFamily?: SemanticStrategyFamily;
  /** (replan) A suggested different strategy family, when determinable. */
  toFamily?: SemanticStrategyFamily;
  /** (compact) Number of identical no-progress turns that would be collapsed. */
  compactedTurns?: number;
  /** Context utilization observed at the loop. */
  contextUtilization?: number | null;
}

const DEFAULT_RECOVERY_OPTIONS: Required<ApsRecoveryOptions> = {
  compactContextUtilization: 0.75,
  compactNoProgressTurns: 2,
};

/**
 * Read-like strategy families that are the classic loop shape: repeatedly
 * reading/querying the same target without advancing.
 */
const READ_LIKE: ReadonlySet<SemanticStrategyFamily> = new Set<SemanticStrategyFamily>([
  "SEARCH_SYMBOL",
  "SEARCH_TEXT",
  "SEARCH_FILE",
  "READ_FILE",
  "READ_DIRECTORY",
]);

/** A deterministic, different family to steer a stuck read-like loop toward. */
const REPLAN_MAP: Record<SemanticStrategyFamily, SemanticStrategyFamily> = {
  SEARCH_SYMBOL: "READ_DIRECTORY",
  SEARCH_TEXT: "SEARCH_FILE",
  SEARCH_FILE: "READ_DIRECTORY",
  READ_FILE: "SEARCH_SYMBOL",
  READ_DIRECTORY: "READ_FILE",
  RUN_TEST: "RUN_BUILD",
  RUN_BUILD: "RUN_TEST",
  EDIT_FILE: "READ_FILE",
  MODIFY_CONFIG: "READ_FILE",
  MODIFY_TEST: "RUN_TEST",
  RUN_FORMAT: "RUN_TYPECHECK",
  RUN_TYPECHECK: "RUN_BUILD",
  RUN_COMMAND: "READ_DIRECTORY",
  INSPECT_ARTIFACT: "READ_FILE",
  ASK_USER: "READ_DIRECTORY",
  UPDATE_PLAN: "READ_DIRECTORY",
  CALL_TOOL: "READ_DIRECTORY",
  GENERATE_TEXT: "READ_FILE",
};

/**
 * Decide how to recover from a loop. Deterministic; never guesses.
 *
 * @param loop The loop event (prevented or candidate) that triggered recovery.
 * @param options Tunable thresholds.
 */
export function decideRecovery(loop: AgentLoopEvent, options: ApsRecoveryOptions = {}): ApsRecoveryDecision {
  const opts = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
  const utilization = loop.contextUtilization ?? null;
  const noProgress = loop.metrics.noProgressTurns;
  const family = loop.family;

  // Context pressure + identical no-progress turns -> compact ONLY the
  // repeated turns; everything that differs stays. Never drop useful results.
  if (
    utilization !== null &&
    utilization >= opts.compactContextUtilization &&
    noProgress >= opts.compactNoProgressTurns
  ) {
    return {
      action: "compact",
      rationale: `context at ${Math.round(utilization * 100)}% while the last ${noProgress} actions were identical no-progress turns; collapse those repeats`,
      compactedTurns: noProgress,
      contextUtilization: utilization,
    };
  }

  // A read-like strategy stuck on one target -> replan to a different family.
  if (READ_LIKE.has(family)) {
    return {
      action: "replan",
      rationale: `stuck repeating ${family}${loop.target ? ` on "${loop.target}"` : ""} without progress; switch strategy`,
      fromFamily: family,
      toFamily: REPLAN_MAP[family],
      contextUtilization: utilization,
    };
  }

  // No deterministic, safe recovery — do not guess.
  return { action: "none", rationale: "no safe deterministic recovery; do not guess", contextUtilization: utilization };
}

/**
 * Build a recovery prompt for the next (fresh) attempt based on the decision.
 *
 * For `compact` the caller wraps this in a compacted system prompt; the prompt
 * itself only instructs dropping the identical repeated turns, never arbitrary
 * context.
 */
export function buildRecoveryPrompt(decision: ApsRecoveryDecision, loop: AgentLoopEvent): string {
  if (decision.action === "compact") {
    const n = decision.compactedTurns ?? loop.metrics.noProgressTurns;
    return `[APS recovery] The last ${n} steps were identical no-progress repeats and context is near its limit.
Do NOT repeat them. Discard only those identical repeats and proceed from the last meaningful change
(keep every result that differs). Take a genuinely different next action.`;
  }
  if (decision.action === "replan") {
    const to = decision.toFamily ?? "a different approach";
    const from = decision.fromFamily ?? loop.family;
    const target = loop.target ? ` on "${loop.target}"` : "";
    return `[APS recovery] Prior attempts repeated ${from}${target} without progress (loop prevented).
Change strategy: STOP using ${from}; instead take a genuinely different approach (e.g. ${to}).
Re-read the task and pick a different next step.`;
  }
  return "";
}

/** True when a recovery prompt should be emitted for the decision. */
export function isRecoverable(decision: ApsRecoveryDecision): boolean {
  return decision.action === "replan" || decision.action === "compact";
}
