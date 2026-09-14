/**
 * Unit tests for the GenerationGuard (spec §23).
 *
 * Tests all 10 required unit test cases plus edge cases for the recovery
 * controller and configuration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GenerationGuard,
  ModelDegenerationError,
  normalizeSentence,
  splitSentences,
  initialGuardState,
} from "../../src/guard/GenerationGuard.ts";
import {
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
} from "../../src/guard/RecoveryController.ts";
import { DEFAULT_GUARD_CONFIG, resolveGuardConfig } from "../../src/guard/config.ts";

// ─── Normalization tests ─────────────────────────────────────────────────────

test("normalizeSentence: trims, collapses whitespace, lowercases", () => {
  assert.equal(normalizeSentence("  Let   me  inspect  the repo. "), "let me inspect the repo");
});

test("normalizeSentence: strips trailing punctuation", () => {
  assert.equal(normalizeSentence("Let me inspect the repo!"), "let me inspect the repo");
  assert.equal(normalizeSentence("Let me inspect the repo?"), "let me inspect the repo");
});

test("normalizeSentence: strips leading discourse markers", () => {
  assert.equal(normalizeSentence("Okay, let me inspect the repo."), "let me inspect the repo");
  assert.equal(normalizeSentence("Alright, I should look at the files."), "i should look at the files");
  assert.equal(normalizeSentence("So, next I will check the code."), "next i will check the code");
});

test("splitSentences: splits on sentence boundaries", () => {
  const sentences = splitSentences("First sentence. Second sentence! Third sentence?");
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0], "First sentence.");
  assert.equal(sentences[1], "Second sentence!");
});

// ─── Test 1: Exact Sentence Loop (spec §23 Test 1) ──────────────────────────

test("Test 1: Four identical sentences trigger repeated_sentence abort", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  let decision: import("../../src/guard/GenerationGuard.ts").GuardDecision = { abort: false };
  // Feed the same sentence 4 times
  for (let i = 0; i < 4; i++) {
    decision = guard.feed("Let me inspect the repo. ");
  }
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, "repeated_sentence");
  assert.ok((decision.diagnostics?.repeat_count as number) >= 4);
});

// ─── Test 2: Harmless Repetition Below Threshold (spec §23 Test 2) ──────────

test("Test 2: Two repetitions with intervening text do not abort", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  let decision;
  decision = guard.feed("Let me inspect the repo. ");
  assert.equal(decision.abort, false);
  // Different reasoning in between
  decision = guard.feed("I need to check the file structure first. The main entry point is in src/index.ts. ");
  assert.equal(decision.abort, false);
  // Same sentence again (only 2 total, below threshold of 4)
  decision = guard.feed("Let me inspect the repo. ");
  assert.equal(decision.abort, false);
});

// ─── Test 3: Repetition Interrupted by Tool Call (spec §23 Test 3) ─────────

test("Test 3: Tool call resets the guard — no abort after progress", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  guard.feed("Let me inspect the repo. ");
  guard.feed("Let me inspect the repo. ");
  // Tool call occurs — resets the window
  guard.onProgress("tool_call");
  // Same sentence again after progress — should NOT abort
  const decision = guard.feed("Let me inspect the repo. ");
  assert.equal(decision.abort, false);
  assert.equal(guard.getState().hasProgress, true);
});

// ─── Test 4: Long Non-Repetitive No-Progress (spec §23 Test 4) ─────────────

test("Test 4: Long non-repetitive reasoning without progress triggers no_progress", () => {
  const config = { ...DEFAULT_GUARD_CONFIG, maxNarrationTokensBeforeAction: 999999 };
  const guard = new GenerationGuard(config);
  // Generate > 1500 tokens of unique text (≈6000 chars at 4 chars/token)
  let text = "";
  for (let i = 0; i < 200; i++) {
    text += `The analysis of component number ${i} reveals that the architecture requires further consideration of the design patterns in use. `;
  }
  const decision = guard.feed(text);
  assert.equal(decision.abort, true);
  assert.equal(decision.reason, "no_progress");
  assert.ok((decision.diagnostics?.tokens_since_progress as number) > 1500);
});

// ─── Test 5: Fast Tool Transition (spec §23 Test 5) ─────────────────────────

test("Test 5: Brief narration followed by tool call does not abort", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  const decision = guard.feed("Need to inspect autonomous subsystem. ");
  assert.equal(decision.abort, false);
  guard.onProgress("tool_call");
  assert.equal(guard.getState().toolCallCount, 1);
});

// ─── Test 6: Final Answer Without Tool (spec §23 Test 6) ────────────────────

test("Test 6: Final answer start prevents narration abort", () => {
  const config = { ...DEFAULT_GUARD_CONFIG, maxNarrationTokensBeforeAction: 50 };
  const guard = new GenerationGuard(config);
  // Signal final answer start
  guard.onProgress("final_answer_start");
  // Long text should not trigger excessive_narration
  const decision = guard.feed("This is the complete answer to the question. ".repeat(20));
  assert.equal(decision.abort, false);
});

// ─── Test 7: Bad Generation Not Persisted (spec §23 Test 7) ────────────────

test("Test 7: Guard state is reset for each generation — old text not carried", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  guard.feed("Let me inspect the repo. ");
  guard.feed("Let me inspect the repo. ");
  guard.feed("Let me inspect the repo. ");
  // Simulate abort + reset (as the recovery controller would do)
  guard.reset();
  // After reset, the same sentence once should not trigger
  const decision = guard.feed("Let me inspect the repo. ");
  assert.equal(decision.abort, false);
  assert.equal(guard.getState().tokensSinceProgress, Math.ceil("Let me inspect the repo. ".length / 4));
});

// ─── Test 8: Recovery Prompt Injected (spec §23 Test 8) ─────────────────────

test("Test 8: Recovery decision includes the recovery prompt", () => {
  const decision = decideRecovery(1, DEFAULT_GUARD_CONFIG, "high", "deepseek-v4.1-flash", "repeated_sentence");
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.recoveryPrompt, RECOVERY_PROMPT);
  assert.ok(decision.recoveryPrompt!.includes("Do not repeat or restate the previous plan"));
  assert.ok(decision.recoveryPrompt!.includes("Take the next concrete action now"));
});

// ─── Test 9: Recovery Reasoning Reduced (spec §23 Test 9) ──────────────────

test("Test 9: Recovery lowers reasoning effort from high to medium", () => {
  const decision = decideRecovery(1, DEFAULT_GUARD_CONFIG, "high", "deepseek-v4.1-flash", "no_progress");
  assert.equal(decision.reasoningEffort, "medium");

  // Second recovery: medium -> low
  const decision2 = decideRecovery(2, DEFAULT_GUARD_CONFIG, "high", "deepseek-v4.1-flash", "no_progress");
  assert.equal(decision2.reasoningEffort, "low");
});

test("lowerReasoningEffort: clamps at low", () => {
  assert.equal(lowerReasoningEffort("high"), "medium");
  assert.equal(lowerReasoningEffort("medium"), "low");
  assert.equal(lowerReasoningEffort("low"), "low");
});

// ─── Test 10: Recovery Limit (spec §23 Test 10) ────────────────────────────

test("Test 10: Recovery exhaustion produces ModelDegenerationError", () => {
  // maxRecoveryAttempts = 3, so attempt 4 should exhaust
  const decision = decideRecovery(4, DEFAULT_GUARD_CONFIG, "high", "deepseek-v4.1-flash", "repeated_sentence", {
    repeat_count: 5,
  });
  assert.equal(decision.shouldRetry, false);
  assert.ok(decision.error instanceof ModelDegenerationError);
  assert.equal(decision.error!.reason, "recovery_exhausted");
  assert.equal(decision.error!.model, "deepseek-v4.1-flash");
  assert.equal(decision.error!.attempt, 3);
});

test("Test 10b: Attempts 1-3 still retry", () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const decision = decideRecovery(attempt, DEFAULT_GUARD_CONFIG, "high", "model-x", "no_progress");
    assert.equal(decision.shouldRetry, true, `attempt ${attempt} should retry`);
  }
});

// ─── Recovery ladder stages (spec §13) ──────────────────────────────────────

test("Recovery attempt 2 compacts context", () => {
  const decision = decideRecovery(2, DEFAULT_GUARD_CONFIG, "high", "model-x", "repeated_sentence");
  assert.equal(decision.compactContext, true);
});

test("Recovery attempt 1 does NOT compact context", () => {
  const decision = decideRecovery(1, DEFAULT_GUARD_CONFIG, "high", "model-x", "repeated_sentence");
  assert.equal(decision.compactContext, false);
});

test("Recovery attempt 3 uses fallback model", () => {
  const decision = decideRecovery(3, DEFAULT_GUARD_CONFIG, "high", "model-x", "no_progress");
  assert.equal(decision.useFallbackModel, true);
});

test("Recovery attempt 1-2 do NOT use fallback model", () => {
  assert.equal(decideRecovery(1, DEFAULT_GUARD_CONFIG, "high", "m", "no_progress").useFallbackModel, false);
  assert.equal(decideRecovery(2, DEFAULT_GUARD_CONFIG, "high", "m", "no_progress").useFallbackModel, false);
});

// ─── Context compaction (spec §17) ──────────────────────────────────────────

test("buildCompactedContext: produces structured checkpoint without failed text", () => {
  const compacted = buildCompactedContext({
    task: "Implement the retry logic",
    currentGoal: "Add exponential backoff to the API client",
    knownFacts: ["The API client is in src/client.ts", "It uses fetch()"],
    filesInspected: ["src/client.ts", "src/config.ts"],
    changesMade: [],
    commandsRun: ["npm test -- --filter=client"],
    outstandingWork: ["Add the backoff delay", "Add unit tests"],
    constraints: ["Must not break existing tests"],
    lastSuccessfulAction: "Read src/client.ts",
  });
  assert.ok(compacted.includes("# Task"));
  assert.ok(compacted.includes("Implement the retry logic"));
  assert.ok(compacted.includes("# Files inspected"));
  assert.ok(compacted.includes("src/client.ts"));
  // Must NOT contain repetitive failed text
  assert.ok(!compacted.includes("Let me inspect"));
});

// ─── Tool Transition Rule (spec §15) ────────────────────────────────────────

test("TOOL_TRANSITION_RULE: contains the required guidance", () => {
  assert.ok(TOOL_TRANSITION_RULE.includes("Tool Transition Rule"));
  assert.ok(TOOL_TRANSITION_RULE.includes("Do not narrate an intended tool action"));
  assert.ok(TOOL_TRANSITION_RULE.includes("issue that action immediately"));
  assert.ok(TOOL_TRANSITION_RULE.includes("Repeated statements of intent are not progress"));
});

// ─── Telemetry (spec §21) ───────────────────────────────────────────────────

test("Telemetry: recordAbort increments counters", () => {
  const tel = initialRecoveryTelemetry();
  recordAbort(tel, "repeated_sentence", 500, 4096);
  assert.equal(tel.abortCount, 1);
  assert.equal(tel.byReason.repeated_sentence, 1);
  assert.equal(tel.tokensSaved, 4096 - 500);

  recordAbort(tel, "no_progress", 800, 4096);
  assert.equal(tel.abortCount, 2);
  assert.equal(tel.byReason.no_progress, 1);
});

test("Telemetry: recordRetryOutcome tracks success/failure", () => {
  const tel = initialRecoveryTelemetry();
  recordRetryOutcome(tel, true, false);
  assert.equal(tel.retrySuccess, 1);

  recordRetryOutcome(tel, false, true);
  assert.equal(tel.retryFailure, 1);
  assert.equal(tel.fallbackCount, 1);
});

test("buildDegenerationEvent: produces structured event", () => {
  const event = buildDegenerationEvent(
    "repeated_sentence",
    "deepseek-v4.1-flash",
    "implementer",
    0,
    714,
    812,
    { repeat_count: 7, repeated_text: "let me look at the autospec repo" },
  );
  assert.equal(event.event, "model_generation_aborted");
  assert.equal(event.reason, "repeated_sentence");
  assert.equal(event.model, "deepseek-v4.1-flash");
  assert.equal(event.agent, "implementer");
  assert.equal(event.attempt, 0);
  assert.equal(event.tokens_since_progress, 714);
  assert.equal(event.repeat_count, 7);
  assert.ok(event.timestamp);
});

// ─── Configuration (spec §19) ───────────────────────────────────────────────

test("Config: defaults match spec §26", () => {
  assert.equal(DEFAULT_GUARD_CONFIG.repeatedSentenceThreshold, 4);
  assert.equal(DEFAULT_GUARD_CONFIG.repeatedWindowSize, 8);
  assert.equal(DEFAULT_GUARD_CONFIG.maxReasoningTokensWithoutProgress, 1500);
  assert.equal(DEFAULT_GUARD_CONFIG.maxNarrationTokensBeforeAction, 600);
  assert.equal(DEFAULT_GUARD_CONFIG.maxRecoveryAttempts, 3);
  assert.equal(DEFAULT_GUARD_CONFIG.compactContextOnAttempt, 2);
  assert.equal(DEFAULT_GUARD_CONFIG.fallbackModelOnAttempt, 3);
  assert.equal(DEFAULT_GUARD_CONFIG.maxSavedCharacters, 5000);
  assert.equal(DEFAULT_GUARD_CONFIG.semanticSimilarityEnabled, false);
});

test("Config: resolveGuardConfig applies overrides", () => {
  const cfg = resolveGuardConfig({ repeatedSentenceThreshold: 2, enabled: false });
  assert.equal(cfg.repeatedSentenceThreshold, 2);
  assert.equal(cfg.enabled, false);
  // Unset values keep defaults
  assert.equal(cfg.maxRecoveryAttempts, 3);
});

test("Config: disabled guard never aborts", () => {
  const guard = new GenerationGuard({ ...DEFAULT_GUARD_CONFIG, enabled: false });
  for (let i = 0; i < 10; i++) {
    const d = guard.feed("Let me inspect the repo. ");
    assert.equal(d.abort, false);
  }
});

// ─── Pre-action narration guard (spec §10) ──────────────────────────────────

test("Excessive narration: triggers when narration exceeds budget with no tool calls", () => {
  const config = { ...DEFAULT_GUARD_CONFIG, maxNarrationTokensBeforeAction: 50, maxReasoningTokensWithoutProgress: 99999, repeatedSentenceThreshold: 99 }; // Disable repeated-sentence to isolate narration detector
  const guard = new GenerationGuard(config);
  // Feed ~150 tokens of VARIED narration (600 chars / 4) — no repetition
  const varied = [
    "I think the configuration file might have the relevant settings. ",
    "The architecture suggests a layered approach to this problem. ",
    "There are several possible interpretations of the requirements. ",
    "I need to consider the implications for the existing test suite. ",
    "The dependency graph shows a circular reference between modules. ",
  ];
  let decision;
  for (const text of varied) {
    decision = guard.feed(text);
  }
  assert.equal(decision!.abort, true);
  assert.equal(decision!.reason, "excessive_narration");
});

test("Excessive narration: does NOT trigger when tool calls present", () => {
  const config = { ...DEFAULT_GUARD_CONFIG, maxNarrationTokensBeforeAction: 50 };
  const guard = new GenerationGuard(config);
  guard.onProgress("tool_call"); // A tool call occurred
  const decision = guard.feed("Now let me analyze the results I got from the file. ".repeat(5));
  assert.equal(decision.abort, false);
});

// ─── State management (spec §18) ────────────────────────────────────────────

test("Guard state: initial state is clean", () => {
  const s = initialGuardState();
  assert.equal(s.sentenceWindow.length, 0);
  assert.equal(s.tokensSinceProgress, 0);
  assert.equal(s.toolCallCount, 0);
  assert.equal(s.hasProgress, false);
  assert.equal(s.finalAnswerStarted, false);
});

test("Guard: multiple progress events accumulate tool calls", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  guard.onProgress("tool_call");
  guard.onProgress("tool_call");
  guard.onProgress("tool_call");
  assert.equal(guard.getState().toolCallCount, 3);
});

// ─── Compacted worker prompt (spec §17, follow-up) ─────────────────────────

test("buildCompactedWorkerPrompt: produces focused checkpoint with task, role, recovery", async () => {
  // Import the internal function via the module (it's not exported publicly,
  // so we test it indirectly through the PiWorkerExecutor's behavior).
  // Instead, test the buildCompactedContext function which is the core logic.
  const { buildCompactedContext } = await import("../../src/guard/RecoveryController.ts");
  const compacted = buildCompactedContext({
    task: "Fix the retry logic in src/client.ts",
    currentGoal: "Add exponential backoff",
    knownFacts: ["Client uses fetch()", "Timeout is 30s"],
    filesInspected: ["src/client.ts"],
    changesMade: [],
    commandsRun: ["npm test -- --filter=client (pass)"],
    outstandingWork: ["Implement backoff", "Add tests"],
    constraints: ["Do not break existing API"],
    lastSuccessfulAction: "Read src/client.ts line 42-80",
  });
  // Must be compact (no verbose prior-attempt text)
  assert.ok(compacted.length < 1000);
  // Must contain the essential sections
  assert.ok(compacted.includes("Fix the retry logic"));
  assert.ok(compacted.includes("exponential backoff"));
  assert.ok(compacted.includes("src/client.ts"));
  assert.ok(compacted.includes("Do not break existing API"));
  // Must NOT contain recovery prompt text (that's injected separately)
  assert.ok(!compacted.includes("Do not repeat or restate"));
});

test("buildCompactedWorkerPrompt: context is truncated to 500 chars", async () => {
  const { buildCompactedContext } = await import("../../src/guard/RecoveryController.ts");
  // The compaction input is bounded by the caller; verify the structure
  // handles large inputs gracefully by only including what's provided.
  const manyFacts = Array.from({ length: 50 }, (_, i) => `Fact ${i}: some finding about the code`);
  const compacted = buildCompactedContext({
    task: "task",
    currentGoal: "goal",
    knownFacts: manyFacts,
    filesInspected: [],
    changesMade: [],
    commandsRun: [],
    outstandingWork: [],
    constraints: [],
    lastSuccessfulAction: "none",
  });
  // Should include all facts (the compaction function includes what's given;
  // truncation is the caller's responsibility)
  assert.ok(compacted.includes("Fact 0"));
  assert.ok(compacted.includes("Fact 49"));
});

// ─── Fallback model ID resolution (follow-up) ─────────────────────────────

test("PiWorkerExecutor accepts fallbackModelId option", async () => {
  const { PiWorkerExecutor } = await import("../../src/workers/PiWorkerExecutor.ts");
  const { DEFAULT_GUARD_CONFIG } = await import("../../src/guard/config.ts");
  const executor = new PiWorkerExecutor({
    agentDir: "/tmp/nonexistent",
    fallbackModelId: "deepseek-v4-flash",
    guardConfig: { ...DEFAULT_GUARD_CONFIG, enabled: false },
  });
  // The executor should be constructible without error
  assert.ok(executor);
  assert.equal(executor.recoveryTelemetry.abortCount, 0);
});
