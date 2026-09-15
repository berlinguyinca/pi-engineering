/**
 * GenerationGuard — streaming degeneration detection (spec §6-§12).
 *
 * A pure, stateful detector that inspects streamed assistant output and
 * decides whether the generation is healthy or degenerate. Designed to be
 * embedded in both worker sessions (PiWorkerExecutor) and interactive sessions
 * (pi extension events).
 *
 * Detection rules:
 *   1. Exact/normalized sentence repetition (spec §7)
 *   2. No-progress token watchdog (spec §9)
 *   3. Pre-action narration budget (spec §10)
 *
 * The guard is model-agnostic: it operates on text and progress events, not
 * on provider-specific fields.
 */

import type { GenerationGuardConfig } from "./config.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GuardAbortReason =
  | "repeated_sentence"
  | "repeated_text"
  | "no_progress"
  | "excessive_narration"
  | "recovery_limit";

export interface GuardDecision {
  abort: boolean;
  reason?: GuardAbortReason;
  diagnostics?: Record<string, unknown>;
}

export type ProgressEventType = "tool_call" | "structured_action" | "final_answer_start" | "state_change";

// ─── Sentence normalization (spec §7.1) ──────────────────────────────────────

/**
 * Normalize a sentence for repetition comparison:
 * - trim whitespace
 * - collapse repeated whitespace
 * - lowercase
 * - remove trailing punctuation (.,;:!)
 * - strip leading discourse markers ("okay,", "alright,", "so,", "now,")
 */
export function normalizeSentence(text: string): string {
  let s = text.trim().replace(/\s+/g, " ").toLowerCase();
  // Strip trailing punctuation
  s = s.replace(/[.,;:!?]+$/, "");
  // Strip leading discourse markers
  s = s.replace(/^(okay|alright|so|now|well|right|ok|sure|okay then|alright then)\s*,?\s*/i, "");
  return s.trim();
}

/**
 * Split text into sentence-like units. Uses a conservative split on
 * sentence-ending punctuation followed by whitespace or end-of-string.
 */
export function splitSentences(text: string): string[] {
  // Split on sentence boundaries: . ! ? followed by space or end
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Split text into COMPLETE sentences only — the trailing fragment of a
 * still-streaming sentence is dropped.
 *
 * The guard is fed token-sized deltas, so the tail of the accumulated text is
 * almost always a half-written sentence ("Let me inspect the reposi"). Feeding
 * those fragments into the repetition window compares garbage against garbage
 * and both misses real repeats and invents false ones, so only sentences that
 * have actually been terminated are eligible for repetition detection.
 */
export function splitCompleteSentences(text: string): string[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return sentences;
  // The accumulated text ends mid-sentence unless its last non-space character
  // terminates one.
  if (!/[.!?]["')\]]?\s*$/.test(text)) sentences.pop();
  return sentences;
}

// ─── Guard state ──────────────────────────────────────────────────────────────

export interface GenerationGuardState {
  /** Normalized sentences in the rolling window. */
  sentenceWindow: string[];
  /** Raw text accumulated since the last progress event. */
  tokensSinceProgress: number;
  /** Total narration tokens in the current assistant turn. */
  narrationTokens: number;
  /** Count of tool calls seen in the current turn. */
  toolCallCount: number;
  /** Whether a final answer has started. */
  finalAnswerStarted: boolean;
  /** Whether any progress event has occurred in this turn. */
  hasProgress: boolean;
  /** Recovery attempt count (0 = initial, 1..N = retries). */
  recoveryAttempt: number;
}

export function initialGuardState(): GenerationGuardState {
  return {
    sentenceWindow: [],
    tokensSinceProgress: 0,
    narrationTokens: 0,
    toolCallCount: 0,
    finalAnswerStarted: false,
    hasProgress: false,
    recoveryAttempt: 0,
  };
}

// ─── Core guard logic ────────────────────────────────────────────────────────

/**
 * The GenerationGuard inspects streamed text and progress events, maintaining
 * internal state. Call `feed()` for each chunk of streamed text and
 * `onProgress()` when a progress event occurs. `decide()` returns the current
 * guard verdict.
 *
 * Approximate token counting: we use a simple chars/4 heuristic (close enough
 * for guard purposes; exact token counts come from usage metadata).
 */
export class GenerationGuard {
  private state: GenerationGuardState;
  private readonly config: GenerationGuardConfig;
  private readonly fullText: string[];
  /** Number of sentences already processed into the window (to avoid re-processing). */
  private processedSentenceCount: number;
  /** Length of the snapshot text already consumed by `feedSnapshot`. */
  private consumedSnapshotLength: number;

  constructor(config: GenerationGuardConfig) {
    this.config = config;
    this.state = initialGuardState();
    this.fullText = [];
    this.processedSentenceCount = 0;
    this.consumedSnapshotLength = 0;
  }

  /** Reset the guard for a new generation (new turn or retry). */
  reset(): void {
    this.state = initialGuardState();
    this.fullText.length = 0;
    this.processedSentenceCount = 0;
    this.consumedSnapshotLength = 0;
  }

  /** Set the current recovery attempt number. */
  setRecoveryAttempt(n: number): void {
    this.state.recoveryAttempt = n;
  }

  /**
   * Feed an INCREMENTAL chunk (delta) of streamed assistant text into the
   * guard. Returns a GuardDecision indicating whether to abort.
   *
   * Callers that only have the accumulated message (Pi's `message_update`
   * carries the full partial message, not the delta) MUST use `feedSnapshot`
   * instead — feeding cumulative text here counts every token once per
   * streaming event, which inflates the budgets quadratically and aborts
   * healthy generations within a few hundred real tokens.
   */
  feed(text: string): GuardDecision {
    if (!this.config.enabled) return { abort: false };

    this.state.narrationTokens += Math.ceil(text.length / 4);
    this.state.tokensSinceProgress += Math.ceil(text.length / 4);
    this.fullText.push(text);
    this.consumedSnapshotLength += text.length;

    // Process only NEW, COMPLETE sentences (since last feed).
    const accumulated = this.fullText.join("");
    const sentences = splitCompleteSentences(accumulated);
    // Only process sentences beyond what we've already seen
    const newSentences = sentences.slice(this.processedSentenceCount);
    this.processedSentenceCount = Math.max(this.processedSentenceCount, sentences.length);

    for (const raw of newSentences) {
      const normalized = normalizeSentence(raw);
      if (normalized.length < 3) continue; // skip trivial fragments
      this.state.sentenceWindow.push(normalized);
    }
    // Trim to window size
    if (this.state.sentenceWindow.length > this.config.repeatedWindowSize) {
      this.state.sentenceWindow = this.state.sentenceWindow.slice(-this.config.repeatedWindowSize);
    }

    // Check detectors in priority order
    const repeated = this.checkRepeatedSentence();
    if (repeated.abort) return repeated;

    const noProgress = this.checkNoProgress();
    if (noProgress.abort) return noProgress;

    const narration = this.checkExcessiveNarration();
    if (narration.abort) return narration;

    return { abort: false };
  }

  /**
   * Feed the CUMULATIVE assistant text seen so far (a streaming snapshot).
   *
   * Only the part that has not been fed yet is charged to the budgets, so
   * callers that receive Pi's accumulated partial message on every
   * `message_update` account each token exactly once. A snapshot that is not a
   * continuation of what we already consumed (a new assistant message in the
   * same turn) starts a fresh segment rather than being re-charged.
   */
  feedSnapshot(snapshot: string): GuardDecision {
    if (!this.config.enabled) return { abort: false };

    const consumed = this.consumedSnapshotLength;
    const isContinuation =
      snapshot.length >= consumed && snapshot.startsWith(this.fullText.join("").slice(0, consumed));
    if (!isContinuation) {
      // A different assistant message: restart snapshot accounting without
      // discarding the turn-level counters the detectors rely on.
      this.fullText.length = 0;
      this.processedSentenceCount = 0;
      this.consumedSnapshotLength = 0;
      return snapshot ? this.feed(snapshot) : { abort: false };
    }
    const delta = snapshot.slice(consumed);
    if (!delta) return { abort: false };
    return this.feed(delta);
  }

  /**
   * Record a progress event (tool call, structured action, etc.).
   * Resets the no-progress counters (spec §11).
   */
  onProgress(type: ProgressEventType): void {
    switch (type) {
      case "tool_call":
        this.state.toolCallCount++;
        break;
      case "final_answer_start":
        this.state.finalAnswerStarted = true;
        break;
      // structured_action and state_change just reset the counter
    }
    this.state.hasProgress = true;
    this.state.tokensSinceProgress = 0;
    // Clear the sentence window on progress: each detector measures the
    // segment SINCE the last progress event, so a turn that keeps acting is
    // never charged for text it already paid for.
    this.state.sentenceWindow = [];
    this.processedSentenceCount = splitCompleteSentences(this.fullText.join("")).length;
  }

  /** Get the accumulated text (for diagnostics). */
  getAccumulatedText(): string {
    return this.fullText.join("");
  }

  /** Get current state snapshot (for telemetry). */
  getState(): Readonly<GenerationGuardState> {
    return { ...this.state };
  }

  // ─── Detectors ──────────────────────────────────────────────────────────────

  /**
   * Spec §7.1: Abort when the same normalized sentence appears
   * `repeatedSentenceThreshold` times within the rolling window and no
   * progress event occurred between repetitions.
   */
  private checkRepeatedSentence(): GuardDecision {
    // NOT gated on `hasProgress`: the window is cleared by `onProgress`, so it
    // only ever holds sentences emitted since the last progress event. Gating
    // on the latch would make the guard inert for the rest of a turn after its
    // first tool call — exactly the mid-session loop it exists to catch.
    if (this.state.sentenceWindow.length < this.config.repeatedSentenceThreshold) return { abort: false };

    // Count occurrences of each sentence in the window
    const counts = new Map<string, number>();
    for (const s of this.state.sentenceWindow) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }

    for (const [sentence, count] of counts) {
      if (count >= this.config.repeatedSentenceThreshold) {
        return {
          abort: true,
          reason: "repeated_sentence",
          diagnostics: {
            repeated_text: sentence,
            repeat_count: count,
            window_size: this.state.sentenceWindow.length,
            tokens_since_progress: this.state.tokensSinceProgress,
          },
        };
      }
    }
    return { abort: false };
  }

  /**
   * Spec §9: Abort if tokens since last progress event exceeds the budget
   * and no tool/action/final-answer has occurred.
   */
  private checkNoProgress(): GuardDecision {
    // Per-segment: `tokensSinceProgress` is reset by `onProgress`, so this is
    // "tokens emitted since the last action", not "tokens in the turn".
    if (this.state.tokensSinceProgress <= this.config.maxReasoningTokensWithoutProgress) return { abort: false };

    return {
      abort: true,
      reason: "no_progress",
      diagnostics: {
        tokens_since_progress: this.state.tokensSinceProgress,
        threshold: this.config.maxReasoningTokensWithoutProgress,
        narration_tokens: this.state.narrationTokens,
      },
    };
  }

  /**
   * Spec §10: For tool-oriented turns, abort when narration exceeds the
   * pre-action budget with no tool calls, no structured actions, and no
   * final answer started.
   */
  private checkExcessiveNarration(): GuardDecision {
    // Only meaningful where prose is NOT the deliverable (worker sessions must
    // finish by calling `worker_result`). In an interactive session the final
    // answer IS prose and no stream-time signal separates it from narration,
    // so the budget is disabled there rather than aborting healthy answers.
    if (!this.config.narrationBudgetEnabled) return { abort: false };
    if (this.state.hasProgress) return { abort: false };
    if (this.state.finalAnswerStarted) return { abort: false };
    if (this.state.toolCallCount > 0) return { abort: false };
    if (this.state.narrationTokens <= this.config.maxNarrationTokensBeforeAction) return { abort: false };

    return {
      abort: true,
      reason: "excessive_narration",
      diagnostics: {
        narration_tokens: this.state.narrationTokens,
        threshold: this.config.maxNarrationTokensBeforeAction,
        tool_call_count: this.state.toolCallCount,
      },
    };
  }
}

// ─── ModelDegenerationError (spec §13) ──────────────────────────────────────

export class ModelDegenerationError extends Error {
  reason: GuardAbortReason | "recovery_exhausted";
  model: string;
  attempt: number;
  diagnostics: Record<string, unknown>;

  constructor(opts: {
    reason: GuardAbortReason | "recovery_exhausted";
    model: string;
    attempt: number;
    diagnostics?: Record<string, unknown>;
    message?: string;
  }) {
    super(opts.message ?? `Model degeneration: ${opts.reason} (model=${opts.model}, attempt=${opts.attempt})`);
    this.name = "ModelDegenerationError";
    this.reason = opts.reason;
    this.model = opts.model;
    this.attempt = opts.attempt;
    this.diagnostics = opts.diagnostics ?? {};
  }
}
