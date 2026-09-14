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

  maxRecoveryAttempts: 3,
  lowerReasoningEffortOnRetry: true,
  compactContextOnAttempt: 2,
  fallbackModelOnAttempt: 3,

  saveDegenerateText: true,
  maxSavedCharacters: 5000,
};

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
 */
export function resolveGuardConfig(overrides?: Partial<GenerationGuardConfig>): GenerationGuardConfig {
  const cfg: GenerationGuardConfig = { ...DEFAULT_GUARD_CONFIG };

  if (typeof process !== "undefined" && process.env) {
    const env = process.env;
    if (env.PI_GUARD_ENABLED !== undefined) {
      cfg.enabled = env.PI_GUARD_ENABLED !== "false" && env.PI_GUARD_ENABLED !== "0";
    }
    if (env.PI_GUARD_SENTENCE_THRESHOLD) {
      cfg.repeatedSentenceThreshold = parseInt(env.PI_GUARD_SENTENCE_THRESHOLD, 10) || cfg.repeatedSentenceThreshold;
    }
    if (env.PI_GUARD_WINDOW) {
      cfg.repeatedWindowSize = parseInt(env.PI_GUARD_WINDOW, 10) || cfg.repeatedWindowSize;
    }
    if (env.PI_GUARD_MAX_REASONING_TOKENS) {
      cfg.maxReasoningTokensWithoutProgress =
        parseInt(env.PI_GUARD_MAX_REASONING_TOKENS, 10) || cfg.maxReasoningTokensWithoutProgress;
    }
    if (env.PI_GUARD_MAX_NARRATION_TOKENS) {
      cfg.maxNarrationTokensBeforeAction =
        parseInt(env.PI_GUARD_MAX_NARRATION_TOKENS, 10) || cfg.maxNarrationTokensBeforeAction;
    }
    if (env.PI_GUARD_MAX_RECOVERY) {
      cfg.maxRecoveryAttempts = parseInt(env.PI_GUARD_MAX_RECOVERY, 10) || cfg.maxRecoveryAttempts;
    }
  }

  if (overrides) {
    Object.assign(cfg, overrides);
  }

  return cfg;
}
