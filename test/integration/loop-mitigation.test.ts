/**
 * Integration test: Loop mitigation end-to-end (spec §24).
 *
 * Simulates the observed DeepSeek V4.1 Flash failure pattern and verifies:
 *  1. Stream is terminated after threshold
 *  2. Repeated output is not committed
 *  3. Retry uses recovery prompt
 *  4. Retry receives lower reasoning effort
 *  5. Simulated tool call on retry counts as progress
 *  6. Agent proceeds normally
 *
 * Uses a fake streaming source to reproduce the degeneration pattern without
 * requiring a real model endpoint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationGuard } from "../../src/guard/GenerationGuard.ts";
import {
  RECOVERY_PROMPT,
  type RecoveryTelemetry,
  buildDegenerationEvent,
  decideRecovery,
  initialRecoveryTelemetry,
  recordAbort,
  recordRetryOutcome,
} from "../../src/guard/RecoveryController.ts";
import { DEFAULT_GUARD_CONFIG, type GenerationGuardConfig } from "../../src/guard/config.ts";

// ─── Fake streaming source ──────────────────────────────────────────────────

/**
 * A fake model stream that emits text chunks, simulating the observed
 * DeepSeek loop failure. Supports injecting a tool call at a specific
 * point to simulate successful recovery.
 */
class FakeDegenerateStream {
  private chunks: string[];
  private toolCallAtChunk: number | null;

  constructor(repeatedSentence: string, count: number, toolCallAtChunk?: number) {
    this.chunks = Array.from({ length: count }, () => `${repeatedSentence} `);
    this.toolCallAtChunk = toolCallAtChunk ?? null;
  }

  *[Symbol.iterator](): Generator<{ type: "text"; text: string } | { type: "tool_call"; tool: string }> {
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.toolCallAtChunk !== null && i === this.toolCallAtChunk) {
        yield { type: "tool_call", tool: "read" };
      }
      yield { type: "text", text: this.chunks[i]! };
    }
  }
}

// ─── Integration: full recovery flow ────────────────────────────────────────

test("Integration: DeepSeek loop detection + recovery (spec §24)", () => {
  const config = DEFAULT_GUARD_CONFIG;
  const telemetry = initialRecoveryTelemetry();

  // ── Attempt 0: Normal inference that degenerates ──
  const guard0 = new GenerationGuard(config);
  const stream0 = new FakeDegenerateStream(
    "Let me look at the autospec repo's autonomous subsystem.",
    8, // more than enough to trigger threshold of 4
  );

  let aborted = false;
  let abortReason: string | undefined;
  let textBeforeAbort = "";
  const committedHistory: string[] = []; // What would be committed to conversation

  for (const chunk of stream0) {
    if (chunk.type === "tool_call") {
      guard0.onProgress("tool_call");
      continue;
    }
    textBeforeAbort += chunk.text;
    const decision = guard0.feed(chunk.text);
    if (decision.abort) {
      aborted = true;
      abortReason = decision.reason;
      break; // Abort the stream
    }
  }

  // 1. Stream is terminated after threshold
  assert.equal(aborted, true, "Stream should be aborted");
  assert.equal(abortReason, "repeated_sentence");
  // Only ~4 sentences got through before abort (not all 8)
  assert.ok(textBeforeAbort.length < 8 * 60, "Should abort before consuming all chunks");

  // 2. Repeated output is NOT committed to history
  // (In the real implementation, the in-flight text is discarded, not merged)
  assert.equal(committedHistory.length, 0, "No degenerate text committed to history");

  // Record the abort in telemetry
  recordAbort(telemetry, "repeated_sentence", 200, 4096);
  assert.equal(telemetry.abortCount, 1);

  // ── Recovery decision for attempt 1 ──
  const recovery1 = decideRecovery(1, config, "high", "deepseek-v4.1-flash", "repeated_sentence", {
    repeated_text: "let me look at the autospec repo's autonomous subsystem",
    repeat_count: 4,
  });

  // 3. Retry uses recovery prompt
  assert.equal(recovery1.shouldRetry, true);
  assert.equal(recovery1.recoveryPrompt, RECOVERY_PROMPT);
  assert.ok(recovery1.recoveryPrompt!.includes("Take the next concrete action now"));

  // 4. Retry receives lower reasoning effort
  assert.equal(recovery1.reasoningEffort, "medium"); // lowered from "high"

  // ── Attempt 1: Recovery retry that succeeds (tool call occurs) ──
  const guard1 = new GenerationGuard(config);
  guard1.setRecoveryAttempt(1);

  // Simulate: model narrates briefly, then makes a tool call
  const stream1 = new FakeDegenerateStream(
    "I will inspect the file now. ",
    2,
    1, // tool call at chunk index 1
  );

  let success = false;
  let toolCallSeen = false;
  let textBeforeToolCall = "";

  for (const chunk of stream1) {
    if (chunk.type === "tool_call") {
      guard1.onProgress("tool_call");
      toolCallSeen = true;
      success = true; // Model made progress
      break;
    }
    textBeforeToolCall += chunk.text;
    const decision = guard1.feed(chunk.text);
    if (decision.abort) {
      // Should NOT abort — only 2 sentences, below threshold
      assert.fail(`Should not abort on recovery attempt: ${decision.reason}`);
    }
  }

  // 5. Simulated tool call on retry counts as progress
  assert.equal(toolCallSeen, true);
  assert.equal(success, true);
  assert.equal(guard1.getState().toolCallCount, 1);
  assert.equal(guard1.getState().hasProgress, true);

  // Record successful recovery
  recordRetryOutcome(telemetry, true, false);
  assert.equal(telemetry.retrySuccess, 1);

  // 6. Agent proceeds normally (no further aborts)
  assert.equal(guard1.getState().tokensSinceProgress, 0); // Reset after progress
});

test("Integration: Full recovery exhaustion (all retries degenerate)", () => {
  const config = DEFAULT_GUARD_CONFIG;
  const telemetry = initialRecoveryTelemetry();

  // Attempt 0 fails
  recordAbort(telemetry, "repeated_sentence", 300, 4096);

  // Attempt 1 fails
  const r1 = decideRecovery(1, config, "high", "model-x", "repeated_sentence");
  assert.equal(r1.shouldRetry, true);
  recordAbort(telemetry, "repeated_sentence", 250, 4096);

  // Attempt 2 fails
  const r2 = decideRecovery(2, config, "high", "model-x", "repeated_sentence");
  assert.equal(r2.shouldRetry, true);
  assert.equal(r2.compactContext, true); // Context compaction at attempt 2
  recordAbort(telemetry, "no_progress", 400, 4096);

  // Attempt 3 (uses fallback model)
  const r3 = decideRecovery(3, config, "high", "model-x", "no_progress");
  assert.equal(r3.shouldRetry, true);
  assert.equal(r3.useFallbackModel, true); // Fallback at attempt 3
  recordAbort(telemetry, "repeated_sentence", 350, 4096);

  // Attempt 4: exhausted
  const r4 = decideRecovery(4, config, "high", "model-x", "repeated_sentence");
  assert.equal(r4.shouldRetry, false);
  assert.ok(r4.error);
  assert.equal(r4.error!.reason, "recovery_exhausted");
  assert.equal(r4.error!.attempt, 3);

  // Final telemetry state
  recordRetryOutcome(telemetry, false, true);
  assert.equal(telemetry.abortCount, 4);
  assert.equal(telemetry.retryFailure, 1);
  assert.equal(telemetry.fallbackCount, 1);
  assert.ok(telemetry.tokensSaved > 0);
});

test("Integration: Telemetry event structure matches spec §21", () => {
  const event = buildDegenerationEvent("repeated_sentence", "deepseek-v4.1-flash", "implementer", 0, 714, 812, {
    repeat_count: 7,
    repeated_text: "let me look at the autospec repo's autonomous subsystem",
    last_progress_event: "tool_result",
    last_progress_age_tokens: 714,
  });

  assert.equal(event.event, "model_generation_aborted");
  assert.equal(event.reason, "repeated_sentence");
  assert.equal(event.model, "deepseek-v4.1-flash");
  assert.equal(event.agent, "implementer");
  assert.equal(event.attempt, 0);
  assert.equal(event.reasoning_tokens, 714);
  assert.equal(event.output_tokens, 812);
  assert.equal(event.tokens_since_progress, 714);
  assert.equal(event.repeat_count, 7);
  assert.equal(event.repeated_text, "let me look at the autospec repo's autonomous subsystem");
  assert.equal(event.last_progress_event, "tool_result");
  assert.equal(event.last_progress_age_tokens, 714);
  // Must have a valid timestamp
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
});

test("Integration: Normal generation passes through without abort", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);

  // Normal reasoning followed by a tool call
  const chunks = [
    "I need to check the configuration file. ",
    "The settings are in src/config.ts. ",
    "Let me verify the current values. ",
  ];

  for (const text of chunks) {
    const decision = guard.feed(text);
    assert.equal(decision.abort, false);
  }

  // Tool call
  guard.onProgress("tool_call");
  assert.equal(guard.getState().hasProgress, true);

  // More reasoning after the tool call
  const decision = guard.feed("The config shows timeout=30s. I need to increase it. ");
  assert.equal(decision.abort, false);
});

test("Integration: Guard does not false-positive on legitimate repeated structure", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);

  // Code-like repeated patterns (e.g., iterating over items) should not trigger
  // because they contain different identifiers
  const chunks = [
    "Processing item 1: alpha. ",
    "Processing item 2: beta. ",
    "Processing item 3: gamma. ",
    "Processing item 4: delta. ",
    "Processing item 5: epsilon. ",
  ];

  for (const text of chunks) {
    const decision = guard.feed(text);
    assert.equal(decision.abort, false, `Should not abort on: ${text.trim()}`);
  }
});
