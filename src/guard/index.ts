/**
 * Generation Guard module — loop mitigation for degenerate model generations.
 *
 * Exports the detection logic, recovery controller, configuration, and
 * telemetry types.
 */

export {
  GenerationGuard,
  ModelDegenerationError,
  normalizeSentence,
  splitSentences,
  splitCompleteSentences,
  initialGuardState,
} from "./GenerationGuard.ts";
export { assistantMessageText, guardFeedFor } from "./streamText.ts";
export type { GuardFeed } from "./streamText.ts";
export type { GuardDecision, GuardAbortReason, ProgressEventType, GenerationGuardState } from "./GenerationGuard.ts";
export {
  RECOVERY_PROMPT,
  TOOL_TRANSITION_RULE,
  lowerReasoningEffort,
  reasoningEffortForRecovery,
  buildCompactedContext,
  decideRecovery,
  buildDegenerationEvent,
  recordAbort,
  recordRetryOutcome,
  initialRecoveryTelemetry,
} from "./RecoveryController.ts";
export type {
  ReasoningEffort,
  CompactionInput,
  RecoveryDecision,
  DegenerationEvent,
  RecoveryTelemetry,
} from "./RecoveryController.ts";
export {
  DEFAULT_GUARD_CONFIG,
  DEFAULT_INTERACTIVE_MAX_NO_PROGRESS_TOKENS,
  resolveGuardConfig,
} from "./config.ts";
export type { GenerationGuardConfig, GuardProfile } from "./config.ts";
export {
  TransientError,
  classifyError,
  backoffDelayMs,
  withTransientRetry,
  resolveTransientRetryConfig,
  DEFAULT_TRANSIENT_RETRY_CONFIG,
  initialTransientTelemetry,
  recordTransientError,
  recordTransientOutcome,
} from "./transient.ts";
export type {
  TransientErrorCategory,
  ErrorClass,
  BackoffConfig,
  RetryOutcome,
  RetryOptions,
  TransientTelemetry,
} from "./transient.ts";
