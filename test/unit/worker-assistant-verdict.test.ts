/**
 * Which assistant-message errors are terminal for a worker run (#457).
 *
 * A gateway failure can arrive as a terminal assistant message instead of a throw. The
 * ones that say the request will not succeed as sent must end the run; the ones another
 * turn or another attempt can recover from keep their existing ladders — a stream cut
 * resumes, a gateway that quotes its own wait is held by the admission layer, a context
 * overflow compacts once. This table is that boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inbandVerdictMarker, terminalAssistantVerdict } from "../../src/workers/PiWorkerExecutor.ts";

test("a refused request is terminal: the model answers the same way to every further turn", () => {
  assert.equal(terminalAssistantVerdict("404 model_not_found: probe-model is not served"), "model_unavailable");
  // The prose shape a hosted gateway uses for the same refusal.
  assert.equal(terminalAssistantVerdict("The model does not exist or you do not have access to it."), "permanent");
  assert.equal(terminalAssistantVerdict("401 incorrect api key"), "permanent");
  assert.equal(terminalAssistantVerdict("402 billing exceeded"), "permanent");
});

/**
 * #725 — the transient marker for an in-band provider verdict. A classified verdict
 * reports the category the thrown path would; unclassifiable prose stays undefined so
 * the executor keeps it as prose instead of fabricating `transient:permanent` (trap 1).
 */
test("an identified in-band verdict maps to its category; unclassifiable prose does not", () => {
  // Identified terminal verdicts (auth / quota) — classifyError calls these permanent,
  // and the unified classifier corroborates them, so they are real markers.
  assert.equal(inbandVerdictMarker("invalid api key"), "permanent");
  assert.equal(inbandVerdictMarker("insufficient_quota: you exceeded your current quota"), "permanent");
  // Identified retryable verdicts keep their own category (never the permanent fallback).
  assert.equal(inbandVerdictMarker("429 too many requests"), "rate_limit");
  // Trap 1: classifyError's fallback is permanent, but the unified classifier cannot
  // place these, so they must stay prose (undefined), not become transient:permanent.
  assert.equal(inbandVerdictMarker("backend boom"), undefined);
  assert.equal(inbandVerdictMarker("slow down"), undefined);
  assert.equal(inbandVerdictMarker("something nobody can classify"), undefined);
  // Trap 2: context overflow has its own ladder and must not become a marker.
  assert.equal(
    inbandVerdictMarker("this model's maximum context length is 100000 tokens; prompt is too long"),
    undefined,
  );
});

test("what another attempt can fix is not terminal", () => {
  for (const text of [
    // A stream cut mid-reply: resumed in a fresh session, executed tools kept.
    "Stream ended without finish_reason",
    "model stream stalled: no data for 30000ms",
    // Rate limit and the admission controller's own wait.
    "429 too many requests",
    'upstream refused: {"error":{"code":"rate_limit","retry_after_ms":30000}}',
    "429 quota exhausted for account",
    // A 5xx is infrastructure whatever the keyword table made of the wording.
    "503 upstream unavailable",
    "502 bad gateway",
    // Context overflow compacts once and then fails structured.
    "this model's maximum context length is 100000 tokens; prompt is too long",
  ]) {
    assert.equal(terminalAssistantVerdict(text), undefined, `${text} must keep its own ladder`);
  }
});
