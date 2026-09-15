/**
 * Generation Guard configuration (spec §19, §26).
 *
 * All thresholds are configurable without code changes. Defaults follow the
 * spec's recommended initial values.
 */

export interface GenerationGuardConfig {
  enabled: boolean;

  /** Repetition detection. */
  repeatedSentenceThreshold: number;
  repeatedWindowSize: number;
  semanticSimilarityEnabled: boolean;
  semanticSimilarityThreshold: number;

  /** Progress / no-progress watchdogs. */
  maxReasoningTokensWithoutProgress: number;
  maxNarrationTokensBeforeAction: number;
  /**
   * Whether the pre-action narration budget is enforced.
   *
   * True for worker sessions, whose deliverable is a `worker_result` tool call
   * — there, prose before the first action is by definition narration. False
   * for interactive sessions, where the final answer is prose and nothing in
   * the stream distinguishes it from narration until the turn is over.
   */
  narrationBudgetEnabled: boolean;

  /** Recovery ladder. */
  maxRecoveryAttempts: number;
  lowerReasoningEffortOnRetry: boolean;
  compactContextOnAttempt: number;
  fallbackModelOnAttempt: number;

  /** Diagnostics / logging. */
  saveDegenerateText: boolean;
  maxSavedCharacters: number;
}

/** Recommended initial defaults (spec §26). */
export const DEFAULT_GUARD_CONFIG: GenerationGuardConfig = {
  enabled: true,

  repeatedSentenceThreshold: 4,
  repeatedWindowSize: 8,
  semanticSimilarityEnabled: false,
  semanticSimilarityThreshold: 0.94,

  maxReasoningTokensWithoutProgress: 1500,
  maxNarrationTokensBeforeAction: 600,
  narrationBudgetEnabled: true,

  maxRecoveryAttempts: 3,
  lowerReasoningEffortOnRetry: true,
  compactContextOnAttempt: 2,
  fallbackModelOnAttempt: 3,

  saveDegenerateText: true,
  maxSavedCharacters: 5000,
};

/**
 * Which session the guard is protecting.
 *
 * `worker`   — fresh-context worker sessions (deliverable: a `worker_result`
 *              tool call). Full detector set.
 * `interactive` — the user's own Pi session (deliverable: the assistant's
 *              prose answer). Repetition detection only, plus a far wider
 *              no-progress backstop, because length alone does not
 *              distinguish a long answer from a degenerate loop.
 */
export type GuardProfile = "worker" | "interactive";

/**
 * Interactive no-progress backstop (tokens). Deliberately far above any
 * plausible single answer: it exists to stop an unbounded runaway, not to
 * budget the reply.
 */
export const DEFAULT_INTERACTIVE_MAX_NO_PROGRESS_TOKENS = 12_000;

/**
 * Resolve guard config from environment variables (for runtime tuning without
 * code changes). Falls back to defaults.
 *
 * Env vars:
 *   PI_GUARD_ENABLED              — "true"/"false"
 *   PI_GUARD_SENTENCE_THRESHOLD   — int
 *   PI_GUARD_WINDOW               — int
 *   PI_GUARD_MAX_REASONING_TOKENS — int
 *   PI_GUARD_MAX_NARRATION_TOKENS — int
 *   PI_GUARD_MAX_RECOVERY         — int
 *   PI_GUARD_NARRATION_BUDGET     — "true"/"false" (worker profile only)
 *   PI_GUARD_INTERACTIVE_MAX_NO_PROGRESS_TOKENS — int
 */
export function resolveGuardConfig(
  overrides?: Partial<GenerationGuardConfig>,
  profile: GuardProfile = "worker",
): GenerationGuardConfig {
  const cfg: GenerationGuardConfig = { ...DEFAULT_GUARD_CONFIG };

  if (profile === "interactive") {
    cfg.narrationBudgetEnabled = false;
    cfg.maxReasoningTokensWithoutProgress = DEFAULT_INTERACTIVE_MAX_NO_PROGRESS_TOKENS;
  }

  if (typeof process !== "undefined" && process.env) {
    const env = process.env;
    if (env.PI_GUARD_ENABLED !== undefined) {
      cfg.enabled = env.PI_GUARD_ENABLED !== "false" && env.PI_GUARD_ENABLED !== "0";
    }
    if (env.PI_GUARD_SENTENCE_THRESHOLD) {
      cfg.repeatedSentenceThreshold =
        Number.parseInt(env.PI_GUARD_SENTENCE_THRESHOLD, 10) || cfg.repeatedSentenceThreshold;
    }
    if (env.PI_GUARD_WINDOW) {
      cfg.repeatedWindowSize = Number.parseInt(env.PI_GUARD_WINDOW, 10) || cfg.repeatedWindowSize;
    }
    // Worker-oriented budget: the interactive profile has its own, far wider
    // backstop (PI_GUARD_INTERACTIVE_MAX_NO_PROGRESS_TOKENS below), so tuning
    // workers never tightens the user's own session.
    if (env.PI_GUARD_MAX_REASONING_TOKENS && profile === "worker") {
      cfg.maxReasoningTokensWithoutProgress =
        Number.parseInt(env.PI_GUARD_MAX_REASONING_TOKENS, 10) || cfg.maxReasoningTokensWithoutProgress;
    }
    if (env.PI_GUARD_MAX_NARRATION_TOKENS) {
      cfg.maxNarrationTokensBeforeAction =
        Number.parseInt(env.PI_GUARD_MAX_NARRATION_TOKENS, 10) || cfg.maxNarrationTokensBeforeAction;
    }
    if (env.PI_GUARD_MAX_RECOVERY) {
      cfg.maxRecoveryAttempts = Number.parseInt(env.PI_GUARD_MAX_RECOVERY, 10) || cfg.maxRecoveryAttempts;
    }
    if (env.PI_GUARD_NARRATION_BUDGET !== undefined) {
      cfg.narrationBudgetEnabled = env.PI_GUARD_NARRATION_BUDGET !== "false" && env.PI_GUARD_NARRATION_BUDGET !== "0";
    }
    // Interactive-specific override wins for the interactive profile so the
    // shared PI_GUARD_MAX_REASONING_TOKENS can still tune worker sessions.
    if (profile === "interactive" && env.PI_GUARD_INTERACTIVE_MAX_NO_PROGRESS_TOKENS) {
      cfg.maxReasoningTokensWithoutProgress =
        Number.parseInt(env.PI_GUARD_INTERACTIVE_MAX_NO_PROGRESS_TOKENS, 10) || cfg.maxReasoningTokensWithoutProgress;
    }
  }

  if (overrides) {
    Object.assign(cfg, overrides);
  }

  return cfg;
}
