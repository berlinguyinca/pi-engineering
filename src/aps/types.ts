/**
 * Agent Progress Supervisor (APS) — Phase 1: PROGRESS INSTRUMENTATION ONLY.
 *
 * Phase 1 observes agent actions, computes stable semantic fingerprints and
 * progress metrics, and classifies loop candidates. It is DETECT-ONLY: it
 * never terminates, compacts, replans, switches models, changes sampling, or
 * escalates. Enforcement belongs to later phases and is a non-goal here.
 */

/**
 * Canonical strategy families.
 *
 * A family is the INTENT of a tool call, abstracted from the concrete tool
 * name: two different tools doing the same kind of work against the same
 * target belong to the same family, which is what lets the supervisor spot
 * "the agent keeps trying the same strategy" across tool names.
 */
export type SemanticStrategyFamily =
  | "SEARCH_SYMBOL"
  | "SEARCH_TEXT"
  | "SEARCH_FILE"
  | "READ_FILE"
  | "READ_DIRECTORY"
  | "RUN_TEST"
  | "RUN_BUILD"
  | "EDIT_FILE"
  | "MODIFY_CONFIG"
  | "MODIFY_TEST"
  | "RUN_FORMAT"
  | "RUN_TYPECHECK"
  | "RUN_COMMAND"
  | "INSPECT_ARTIFACT"
  | "ASK_USER"
  | "UPDATE_PLAN"
  | "CALL_TOOL"
  | "GENERATE_TEXT";

/** Every strategy family, for validation and tooling. */
export const SEMANTIC_STRATEGY_FAMILIES: readonly SemanticStrategyFamily[] = [
  "SEARCH_SYMBOL",
  "SEARCH_TEXT",
  "SEARCH_FILE",
  "READ_FILE",
  "READ_DIRECTORY",
  "RUN_TEST",
  "RUN_BUILD",
  "EDIT_FILE",
  "MODIFY_CONFIG",
  "MODIFY_TEST",
  "RUN_FORMAT",
  "RUN_TYPECHECK",
  "RUN_COMMAND",
  "INSPECT_ARTIFACT",
  "ASK_USER",
  "UPDATE_PLAN",
  "CALL_TOOL",
  "GENERATE_TEXT",
];

/** The output of the ToolCallNormalizer: intent + target + cleaned arguments. */
export interface NormalizedToolCall {
  family: SemanticStrategyFamily;
  /** Canonical target: relative path, query, or normalized command. "" when none. */
  target: string;
  /** All arguments after normalization (volatile keys dropped, whitespace collapsed). */
  arguments: Record<string, unknown>;
}

/**
 * One observed agent action, fully normalized.
 *
 * This is the unit of progress instrumentation. Everything that can vary
 * cosmetically (timestamps, absolute path prefixes, whitespace, key order)
 * must have been normalized before the action is recorded, so that
 * `contentFingerprint` is stable for the same intent + target + state.
 */
export interface AgentAction {
  /** Role of the acting agent (e.g. "implementer", "reviewer"). */
  role: string;
  /** 0-based iteration (turn) index within the session. */
  iteration: number;
  /** Raw tool name as invoked (e.g. "repo_search"). */
  tool: string;
  /** Tool arguments after ToolCallNormalizer normalization. */
  normalizedArguments: Record<string, unknown>;
  /** Short bounded summary of the tool result (e.g. "5 hits", "exit 1", "file changed"). */
  toolResultSummary: string;
  /** `semanticFingerprint(action)`: stable under cosmetic churn, changes on real input/state change. */
  contentFingerprint: string;
  /** Pipeline phase the action belongs to (e.g. "plan", "execute", "verify"). */
  phase: string;
  /** Session that produced the action (worker/conversation instance). */
  sessionId: string;
  /** Run the session belongs to. */
  runId: string;
  /** Work item the action is scoped to, if any. */
  workItemId: string | null;
  /** Wall-clock timestamp (ISO). Kept for bookkeeping; excluded from fingerprinting. */
  occurredAt?: string;
  /** Provider of the model producing the action (e.g. "anthropic"), when known. */
  modelProvider?: string;
  /** Model id producing the action (e.g. "claude-..."), when known. */
  modelId?: string;
  /**
   * Input tokens of the latest assistant turn at the time of the action
   * (usage data), when available. Used for context-utilization reporting.
   */
  inputTokens?: number;
  /** Configured context budget in tokens for the session, when configured. */
  maxContextTokens?: number;
}

/**
 * Progress metrics computed over the bounded action history.
 *
 * All counters are windowed (bounded history), so they reflect recent
 * behavior, not the whole session.
 */
export interface ProgressVector {
  /** Number of actions currently in the window. */
  totalActions: number;
  /**
   * Length of the trailing run of actions that exactly repeat the previous
   * action (identical contentFingerprint = same intent + target + no state
   * change). 0 means the latest action made progress.
   */
  noProgressTurns: number;
  /** contentFingerprint -> in-window count, only for fingerprints seen 2+ times. */
  repeatedCalls: Record<string, number>;
  /**
   * Actions whose (tool, normalized arguments) were already invoked earlier in
   * the window and returned the SAME result summary as the most recent earlier
   * invocation — i.e. the result did not advance, it is stale.
   */
  staleToolResults: number;
  /** Fingerprint of the most recent action, or null for an empty history. */
  lastFingerprint: string | null;
}

/**
 * A strategy (family + target) that keeps failing.
 *
 * Reserved for later APS phases: Phase 1 only defines the shape so the
 * supervisor's event payload and future enforcement share one contract.
 */
export interface FailedStrategy {
  family: SemanticStrategyFamily;
  target: string;
  /** Number of consecutive failing attempts observed. */
  attempts: number;
  lastResultSummary: string;
  /** Why the strategy is considered failed (e.g. "nonzero_exit", "no_change"). */
  reason: string;
}

/** Result of loop-candidate classification. */
export interface LoopVerdict {
  loop_candidate: boolean;
  /** Present only when loop_candidate is true. */
  reason?: string;
}

/** Detection thresholds (all ">= this many" triggers). */
export interface ProgressThresholds {
  /** Trailing identical no-progress actions. */
  noProgressTurns: number;
  /** In-window repeats of one contentFingerprint. */
  repeatedCalls: number;
  /** In-window stale (unchanged) tool results. */
  staleToolResults: number;
}

export const DEFAULT_PROGRESS_THRESHOLDS: ProgressThresholds = {
  noProgressTurns: 3,
  repeatedCalls: 3,
  staleToolResults: 3,
};

/**
 * The structured event the supervisor emits when a loop is detected.
 * Detect-only: emitting this event changes nothing about the agent's run.
 */
export interface AgentLoopCandidateEvent {
  readonly type: "agent.loop_candidate";
  event_id: string;
  timestamp: string;
  sessionId: string;
  runId: string;
  workItemId: string | null;
  role: string;
  iteration: number;
  phase: string;
  /** Classification reason (e.g. "no_progress_turns", "repeated_call", "stale_tool_results"). */
  reason: string;
  /** contentFingerprint of the action that completed the loop. */
  fingerprint: string;
  /** Raw tool name of the action that completed the loop (e.g. "repo_search"). */
  tool: string;
  /** The model producing the action when the loop completed, or null when unknown. */
  model: { provider: string; id: string } | null;
  /**
   * Context utilization at loop completion: input tokens / configured
   * max_context_tokens, in [0, 1]. null when usage data or the configured
   * budget is unavailable.
   */
  contextUtilization: number | null;
  family: SemanticStrategyFamily;
  target: string;
  metrics: {
    noProgressTurns: number;
    repeatedCalls: number;
    staleToolResults: number;
  };
}
