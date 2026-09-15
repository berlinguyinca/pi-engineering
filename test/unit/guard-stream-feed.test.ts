/**
 * Adapter-boundary tests for the GenerationGuard.
 *
 * The guard's own unit tests feed it deltas — the way it wants to be fed. The
 * regression that made `excessive_narration` fire constantly lived one layer
 * out, in the CALLERS: Pi's `message_update` carries the accumulated partial
 * message, and feeding that charged every token once per streaming event.
 *
 * These tests drive the guard exactly the way the extension and the worker
 * executor drive it: streaming events in, at most one abort out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationGuard, splitCompleteSentences } from "../../src/guard/GenerationGuard.ts";
import { DEFAULT_GUARD_CONFIG, resolveGuardConfig } from "../../src/guard/config.ts";
import { guardFeedFor } from "../../src/guard/streamText.ts";

/** A streamed turn, as a list of token-sized deltas. */
function deltas(text: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Pi's extension-API `message_update` shape: accumulated message + delta. */
function extensionEvent(delta: string, accumulated: string) {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: accumulated }] },
    assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
  };
}

/** The agent-core harness shape consumed by `session.subscribe`: `event`, not `assistantMessageEvent`. */
function harnessEvent(delta: string, accumulated: string) {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: accumulated }] },
    event: { type: "text_delta", delta, contentIndex: 0 },
  };
}

/** Drive a guard the way a caller does, returning the first abort (if any). */
function streamTurn(
  guard: GenerationGuard,
  text: string,
  build: (delta: string, accumulated: string) => unknown,
): { aborts: number; reason?: string } {
  let accumulated = "";
  let aborts = 0;
  let reason: string | undefined;
  for (const delta of deltas(text)) {
    accumulated += delta;
    const event = build(delta, accumulated) as { message: { content: unknown } };
    const feed = guardFeedFor(event, event.message.content);
    if (!feed) continue;
    const decision = feed.kind === "delta" ? guard.feed(feed.text) : guard.feedSnapshot(feed.text);
    if (decision.abort) {
      aborts++;
      reason ??= decision.reason;
      break;
    }
  }
  return { aborts, ...(reason ? { reason } : {}) };
}

// A healthy, tool-free answer: ~440 tokens of varied prose. Comfortably under
// the worker profile's 600-token narration budget when each token is charged
// ONCE — and far over it when the accumulated message is re-fed every update.
function healthyAnswer(): string {
  let text = "";
  for (let i = 0; i < 20; i++) {
    text += `The ledger records candidate ${i} together with the verification evidence it produced. `;
  }
  return text;
}

test("streamed deltas charge each token once (the accumulated message must not be re-fed)", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  const answer = healthyAnswer();
  const result = streamTurn(guard, answer, extensionEvent);

  assert.equal(result.aborts, 0, `healthy answer aborted with ${result.reason}`);
  // Charged tokens track the real text length (chars/4), not its square.
  const charged = guard.getState().narrationTokens;
  const expected = Math.ceil(answer.length / 4);
  assert.ok(
    Math.abs(charged - expected) <= deltas(answer).length,
    `charged ${charged} tokens for ~${expected} real tokens`,
  );
});

test("regression: feeding the ACCUMULATED message on every update aborts a healthy answer", () => {
  // This is precisely what the callers used to do. Kept as an executable
  // record of the defect: the same healthy text, fed cumulatively, dies.
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  const answer = healthyAnswer();
  let accumulated = "";
  let aborted = false;
  let reason: string | undefined;
  for (const delta of deltas(answer)) {
    accumulated += delta;
    const decision = guard.feed(accumulated); // the bug
    if (decision.abort) {
      aborted = true;
      reason = decision.reason;
      break;
    }
  }
  // The cumulative feed poisons BOTH budget accounting and the repetition
  // window (each streaming prefix re-appends the sentences before it), so
  // either detector may win the race. Both are false positives.
  assert.equal(aborted, true);
  assert.ok(reason === "excessive_narration" || reason === "repeated_sentence", `unexpected reason ${reason}`);
});

test("snapshot accounting charges only the unseen tail", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  const answer = healthyAnswer();
  let accumulated = "";
  for (const delta of deltas(answer)) {
    accumulated += delta;
    const decision = guard.feedSnapshot(accumulated);
    assert.equal(decision.abort, false);
  }
  const charged = guard.getState().narrationTokens;
  assert.ok(charged <= Math.ceil(answer.length / 4) + deltas(answer).length, `charged ${charged}`);
});

test("snapshot accounting restarts cleanly on a second assistant message", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  guard.feedSnapshot("First message text.");
  const before = guard.getState().narrationTokens;
  // A different message: not a continuation of what we consumed.
  guard.feedSnapshot("Completely different second message.");
  const after = guard.getState().narrationTokens;
  assert.ok(after > before);
  // Continuing the second message charges only the tail.
  guard.feedSnapshot("Completely different second message. Plus a tail.");
  assert.ok(guard.getState().narrationTokens - after <= Math.ceil(" Plus a tail.".length / 4) + 1);
});

test("the worker path reads the harness `event` field, not `assistantMessageEvent`", () => {
  // Reading the wrong field yields no text at all — the guard would then be
  // silently inert while every test still "passed".
  const feed = guardFeedFor(harnessEvent("hello ", "hello "), [{ type: "text", text: "hello " }]);
  assert.deepEqual(feed, { kind: "delta", text: "hello " });

  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  const result = streamTurn(guard, healthyAnswer(), harnessEvent);
  assert.equal(result.aborts, 0);
  assert.ok(guard.getState().narrationTokens > 0, "no text reached the guard");
});

test("thinking and tool-call deltas are not charged as narration", () => {
  for (const type of ["thinking_delta", "toolcall_delta", "text_start", "text_end"]) {
    const feed = guardFeedFor({ type: "message_update", assistantMessageEvent: { type, delta: "x".repeat(400) } }, [
      { type: "text", text: "" },
    ]);
    assert.equal(feed, null, `${type} should not be charged`);
  }
});

test("an event with no recognizable stream payload falls back to snapshot accounting", () => {
  const feed = guardFeedFor({ type: "message_end" }, [{ type: "text", text: "final text" }]);
  assert.deepEqual(feed, { kind: "snapshot", text: "final text" });
});

// ─── Profiles ───────────────────────────────────────────────────────────────

test("interactive profile: a long tool-free answer never aborts", () => {
  const config = resolveGuardConfig(undefined, "interactive");
  assert.equal(config.narrationBudgetEnabled, false);
  const guard = new GenerationGuard(config);

  // ~2000 tokens of varied prose: far past the worker narration budget (600)
  // and the worker no-progress budget (1500). In the user's own session this
  // is just a long answer.
  let text = "";
  for (let i = 0; i < 180; i++) {
    text += `Section ${i} explains how the candidate was verified and what evidence the ledger recorded for it. `;
  }
  const result = streamTurn(guard, text, extensionEvent);
  assert.equal(result.aborts, 0, `long answer aborted with ${result.reason}`);
});

test("interactive profile: a repeating loop is still caught", () => {
  const guard = new GenerationGuard(resolveGuardConfig(undefined, "interactive"));
  const result = streamTurn(guard, "Let me check the repository. ".repeat(6), extensionEvent);
  assert.equal(result.aborts, 1);
  assert.equal(result.reason, "repeated_sentence");
});

test("worker profile: the pre-action narration budget still fires", () => {
  const guard = new GenerationGuard(resolveGuardConfig());
  let text = "";
  for (let i = 0; i < 120; i++) {
    text += `First I will consider approach ${i} before deciding which file to open. `;
  }
  const result = streamTurn(guard, text, harnessEvent);
  assert.equal(result.aborts, 1);
  assert.equal(result.reason, "excessive_narration");
});

// ─── Segment semantics ──────────────────────────────────────────────────────

test("a mid-session loop after a tool call is caught (the guard is not inert after progress)", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  guard.feed("Reading the file now. ");
  guard.onProgress("tool_call");
  const result = streamTurn(guard, "Now I will re-read that same file. ".repeat(6), extensionEvent);
  assert.equal(result.aborts, 1);
  assert.equal(result.reason, "repeated_sentence");
});

test("budgets measure the segment since the last progress event, not the whole turn", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  // Three tool-using rounds, each with prose well inside the budget. A turn
  // that keeps acting must never be charged for text it already paid for.
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 20; i++) {
      const decision = guard.feed(`Round ${round} note ${i}: the verification output looks consistent so far. `);
      assert.equal(decision.abort, false);
    }
    guard.onProgress("tool_call");
    assert.equal(guard.getState().tokensSinceProgress, 0);
  }
});

// ─── Sentence completeness ──────────────────────────────────────────────────

test("splitCompleteSentences drops the still-streaming tail", () => {
  assert.deepEqual(splitCompleteSentences("One. Two. Thr"), ["One.", "Two."]);
  assert.deepEqual(splitCompleteSentences("One. Two."), ["One.", "Two."]);
  assert.deepEqual(splitCompleteSentences("No terminator yet"), []);
  assert.deepEqual(splitCompleteSentences('He said "go."'), ['He said "go."']);
});

test("partial sentence fragments never enter the repetition window", () => {
  const guard = new GenerationGuard(DEFAULT_GUARD_CONFIG);
  // One long sentence streamed in small pieces must contribute exactly one
  // window entry, not one per delta.
  for (const d of deltas("The implementer produced a candidate for review. ", 4)) guard.feed(d);
  assert.deepEqual(guard.getState().sentenceWindow, ["the implementer produced a candidate for review"]);
});
