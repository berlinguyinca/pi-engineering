/**
 * RecoveryController — bounded recovery ladder (spec §13-§17).
 *
 * Manages the recovery attempts after a degeneration abort:
 *   Attempt 1: inject recovery prompt, lower reasoning effort
 *   Attempt 2: compact context, inject recovery prompt, lower reasoning
 *   Attempt 3: switch to fallback model
 *   After 3:  fail with ModelDegenerationError
 *
 * The controller is stateless between calls (the attempt count is tracked by
 * the caller), making it easy to test and use in both worker and interactive
 * contexts.
 */

import { type GuardAbortReason, ModelDegenerationError } from "./GenerationGuard.ts";
import type { GenerationGuardConfig } from "./config.ts";

// ─── Recovery prompt (spec §14) ─────────────────────────────────────────────

export const RECOVERY_PROMPT = `The previous generation stalled while planning and was stopped by the execution harness.

Do not repeat or restate the previous plan.

Take the next concrete action now.

If repository inspection, file reading, searching, command execution, or another tool operation is required, invoke the appropriate tool immediately instead of narrating that you intend to do so.

Do not say phrases such as:
- "Let me inspect..."
- "Let me look at..."
- "I will check..."
- "Next I should..."

when the corresponding tool can be called directly.

If no tool is required, produce the requested final answer.

You must make observable progress in this turn: issue a tool/action, change structured task state, or finish the answer.`;

// ─── Tool Transition Rule (spec §15) ────────────────────────────────────────

export const TOOL_TRANSITION_RULE = `### Tool Transition Rule

Do not narrate an intended tool action when you can perform the action directly.

Bad:
"Let me inspect the autonomous subsystem."

Good:
<tool call>

Once you determine that the next step is a repository read, search, command, file operation, or other available tool action, issue that action immediately.

Brief reasoning is allowed when it changes the decision. Repeated statements of intent are not progress.

If you notice that you are restating the same intended action, stop narrating and perform the action.`;

// ─── Reasoning effort levels ─────────────────────────────────────────────────

export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Lower the reasoning effort by one level (spec §16).
 * high -> medium -> low -> low (clamped)
 */
export function lowerReasoningEffort(current: ReasoningEffort): ReasoningEffort {
  if (current === "high") return "medium";
  if (current === "medium") return "low";
  return "low";
}

/**
 * Determine the reasoning effort for a recovery attempt.
 * Each recovery attempt lowers the effort one level from the original.
 * Attempt 0: the original effort (unchanged)
 * Attempt 1: one level lower
 * Attempt 2: two levels lower (clamped at "low")
 */
export function reasoningEffortForRecovery(original: ReasoningEffort, attempt: number): ReasoningEffort {
  let effort = original;
  for (let i = 0; i < attempt; i++) {
    effort = lowerReasoningEffort(effort);
  }
  return effort;
}

// ─── Context compaction (spec §17) ──────────────────────────────────────────

export interface CompactionInput {
  task: string;
  currentGoal: string;
  knownFacts: string[];
  filesInspected: string[];
  changesMade: string[];
  commandsRun: string[];
  outstandingWork: string[];
  constraints: string[];
  lastSuccessfulAction: string;
}

/**
 * Build a compact context checkpoint for recovery attempt 2+ (spec §17).
 * Does NOT include repetitive failed generation text.
 */
export function buildCompactedContext(input: CompactionInput): string {
  const lines: string[] = [];
  lines.push("# Task");
  lines.push(input.task);
  lines.push("");
  lines.push("# Current goal");
  lines.push(input.currentGoal);
  lines.push("");
  if (input.knownFacts.length > 0) {
    lines.push("# Known facts");
    for (const f of input.knownFacts) lines.push(`- ${f}`);
    lines.push("");
  }
  if (input.filesInspected.length > 0) {
    lines.push("# Files inspected");
    for (const f of input.filesInspected) lines.push(`- ${f}`);
    lines.push("");
  }
  if (input.changesMade.length > 0) {
    lines.push("# Changes already made");
    for (const c of input.changesMade) lines.push(`- ${c}`);
    lines.push("");
  }
  if (input.commandsRun.length > 0) {
    lines.push("# Commands/tests already run");
    for (const c of input.commandsRun) lines.push(`- ${c}`);
    lines.push("");
  }
  if (input.outstandingWork.length > 0) {
    lines.push("# Outstanding work");
    for (const w of input.outstandingWork) lines.push(`- ${w}`);
    lines.push("");
  }
  if (input.constraints.length > 0) {
    lines.push("# Constraints");
    for (const c of input.constraints) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push("# Last successful action");
  lines.push(input.lastSuccessfulAction || "(none)");
  return lines.join("\n");
}

// ─── Recovery decision ──────────────────────────────────────────────────────

export interface RecoveryDecision {
  /** Whether to retry. */
  shouldRetry: boolean;
  /** The attempt number (1-based for retries). */
  attempt: number;
  /** Inject this into the retry's system/developer context. */
  recoveryPrompt: string | null;
  /** Whether to compact context for this retry. */
  compactContext: boolean;
  /** Whether to use the fallback model. */
  useFallbackModel: boolean;
  /** The reasoning effort to use for this retry. */
  reasoningEffort: ReasoningEffort;
  /** Error to throw when exhausted. */
  error: ModelDegenerationError | null;
}

/**
 * Determine the recovery action for a given attempt number and config.
 *
 * @param attempt - the NEXT attempt number (1 = first retry after initial failure)
 * @param config - the guard configuration
 * @param originalEffort - the reasoning effort used for the failed attempt
 * @param model - the model that failed
 */
export function decideRecovery(
  attempt: number,
  config: GenerationGuardConfig,
  originalEffort: ReasoningEffort,
  model: string,
  lastReason: GuardAbortReason,
  diagnostics: Record<string, unknown> = {},
): RecoveryDecision {
  // Check if we've exceeded the max recovery attempts
  if (attempt > config.maxRecoveryAttempts) {
    return {
      shouldRetry: false,
      attempt,
      recoveryPrompt: null,
      compactContext: false,
      useFallbackModel: false,
      reasoningEffort: originalEffort,
      error: new ModelDegenerationError({
        reason: "recovery_exhausted",
        model,
        attempt: attempt - 1,
        diagnostics: {
          ...diagnostics,
          max_attempts: config.maxRecoveryAttempts,
          last_reason: lastReason,
        },
      }),
    };
  }

  const compactContext = config.compactContextOnAttempt > 0 && attempt >= config.compactContextOnAttempt;
  const useFallbackModel = config.fallbackModelOnAttempt > 0 && attempt >= config.fallbackModelOnAttempt;
  const reasoningEffort = config.lowerReasoningEffortOnRetry
    ? reasoningEffortForRecovery(originalEffort, attempt)
    : originalEffort;

  return {
    shouldRetry: true,
    attempt,
    recoveryPrompt: RECOVERY_PROMPT,
    compactContext,
    useFallbackModel,
    reasoningEffort,
    error: null,
  };
}

// ─── Telemetry (spec §21) ───────────────────────────────────────────────────

export interface DegenerationEvent {
  event: "model_generation_aborted";
  reason: GuardAbortReason;
  model: string;
  agent: string;
  attempt: number;
  reasoning_tokens: number;
  output_tokens: number;
  tokens_since_progress: number;
  repeat_count?: number;
  repeated_text?: string;
  last_progress_event?: string;
  last_progress_age_tokens?: number;
  timestamp: string;
}

export interface RecoveryTelemetry {
  /** Total aborts. */
  abortCount: number;
  /** Total successful recoveries. */
  retrySuccess: number;
  /** Total failed recoveries (exhausted). */
  retryFailure: number;
  /** Total fallback model uses. */
  fallbackCount: number;
  /** Estimated tokens saved by aborting early. */
  tokensSaved: number;
  /** Per-reason abort counts. */
  byReason: Record<string, number>;
}

export function initialRecoveryTelemetry(): RecoveryTelemetry {
  return {
    abortCount: 0,
    retrySuccess: 0,
    retryFailure: 0,
    fallbackCount: 0,
    tokensSaved: 0,
    byReason: {},
  };
}

export function recordAbort(
  telemetry: RecoveryTelemetry,
  reason: GuardAbortReason,
  tokensAtAbort: number,
  maxOutputBudget: number,
): void {
  telemetry.abortCount++;
  telemetry.byReason[reason] = (telemetry.byReason[reason] ?? 0) + 1;
  // Tokens saved = what we would have consumed minus what we actually consumed
  telemetry.tokensSaved += Math.max(0, maxOutputBudget - tokensAtAbort);
}

export function recordRetryOutcome(telemetry: RecoveryTelemetry, success: boolean, usedFallback: boolean): void {
  if (success) {
    telemetry.retrySuccess++;
  } else {
    telemetry.retryFailure++;
  }
  if (usedFallback) {
    telemetry.fallbackCount++;
  }
}

export function buildDegenerationEvent(
  reason: GuardAbortReason,
  model: string,
  agent: string,
  attempt: number,
  tokensSinceProgress: number,
  outputTokens: number,
  diagnostics: Record<string, unknown>,
): DegenerationEvent {
  return {
    event: "model_generation_aborted",
    reason,
    model,
    agent,
    attempt,
    reasoning_tokens: tokensSinceProgress,
    output_tokens: outputTokens,
    tokens_since_progress: tokensSinceProgress,
    repeat_count: diagnostics.repeat_count as number | undefined,
    repeated_text: diagnostics.repeated_text as string | undefined,
    last_progress_event: diagnostics.last_progress_event as string | undefined,
    last_progress_age_tokens: diagnostics.last_progress_age_tokens as number | undefined,
    timestamp: new Date().toISOString(),
  };
}
