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
  initialGuardState,
} from "./GenerationGuard.ts";
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
export { DEFAULT_GUARD_CONFIG, resolveGuardConfig } from "./config.ts";
export type { GenerationGuardConfig } from "./config.ts";
