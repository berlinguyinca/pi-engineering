/**
 * APS Phase 1 — ProgressEvaluator: bounded history, no-progress turns,
 * repeated calls, stale results, and loop-candidate classification.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallNormalizer, semanticFingerprint } from "../../src/aps/fingerprint.ts";
import { ProgressEvaluator } from "../../src/aps/progress.ts";
import type { AgentAction } from "../../src/aps/types.ts";

const normalizer = new ToolCallNormalizer({ rootPrefix: "/home/u/proj" });
let iteration = 0;

function makeAction(
  tool: string,
  args: Record<string, unknown>,
  result: string,
  over: Partial<AgentAction> = {},
): AgentAction {
  iteration += 1;
  const norm = normalizer.normalize({ name: tool, arguments: args });
  return {
    role: "implementer",
    iteration,
    tool,
    normalizedArguments: norm.arguments,
    toolResultSummary: result,
    contentFingerprint: semanticFingerprint(
      { tool, normalizedArguments: norm.arguments, toolResultSummary: result },
      normalizer,
    ),
    phase: "execute",
    sessionId: "sess-1",
    runId: "run-1",
    workItemId: "WI-1",
    ...over,
  };
}

const READ_X = () => makeAction("read_file", { path: "src/x.ts" }, "content v1");
const READ_Y = () => makeAction("read_file", { path: "src/y.ts" }, "content ok");
const SEARCH_FOO = () => makeAction("repo_search", { query: "foo" }, "5 hits");
const SEARCH_BAR = () => makeAction("repo_search", { query: "bar" }, "0 hits");

test("distinct actions show progress: no loop, no stale results", () => {
  const ev = new ProgressEvaluator();
  const a1 = ev.classify(READ_X());
  const a2 = ev.classify(SEARCH_FOO());
  const a3 = ev.classify(READ_Y());
  const a4 = ev.classify(SEARCH_BAR());
  for (const v of [a1, a2, a3, a4]) assert.equal(v.loop_candidate, false, JSON.stringify(v));
  const vector = ev.vector();
  assert.equal(vector.totalActions, 4);
  assert.equal(vector.noProgressTurns, 0);
  assert.deepEqual(vector.repeatedCalls, {});
  assert.equal(vector.staleToolResults, 0);
});

test("repeating the identical action (no state change) classifies a loop candidate", () => {
  const ev = new ProgressEvaluator();
  assert.equal(ev.classify(READ_X()).loop_candidate, false, "1st call");
  const second = ev.classify(READ_X());
  assert.equal(second.loop_candidate, false, "2nd call below threshold");
  assert.equal(ev.vector().noProgressTurns, 1);
  const third = ev.classify(READ_X());
  assert.equal(third.loop_candidate, true, "3rd identical call reaches repeatedCalls threshold");
  assert.equal(third.reason, "repeated_call");
  const vector = ev.vector();
  const fp = vector.lastFingerprint;
  assert.notEqual(fp, null);
  assert.equal(vector.repeatedCalls[fp ?? ""], 3);
});

test("same intent+target but changing state is NOT a loop", () => {
  const ev = new ProgressEvaluator();
  let verdict = ev.classify(makeAction("read_file", { path: "src/x.ts" }, "v1"));
  verdict = ev.classify(makeAction("read_file", { path: "src/x.ts" }, "v2"));
  verdict = ev.classify(makeAction("read_file", { path: "src/x.ts" }, "v3"));
  verdict = ev.classify(makeAction("read_file", { path: "src/x.ts" }, "v4"));
  verdict = ev.classify(makeAction("read_file", { path: "src/x.ts" }, "v5"));
  assert.equal(verdict.loop_candidate, false, "state keeps changing: every call makes progress");
  assert.equal(ev.vector().noProgressTurns, 0);
  assert.deepEqual(ev.vector().repeatedCalls, {});
  assert.equal(ev.vector().staleToolResults, 0);
});

test("stale tool results (same inputs, same result again) are counted and classified", () => {
  // repeatedCalls threshold raised so the stale-results rule is the one that fires.
  const ev = new ProgressEvaluator({ thresholds: { repeatedCalls: 5 } });
  const a = () => makeAction("run_test", { command: "npm test" }, "exit 1: same failure");
  const b = () => makeAction("read_file", { path: `src/file-${Math.random()}.ts` }, "ok");
  assert.equal(ev.classify(a()).loop_candidate, false);
  assert.equal(ev.classify(b()).loop_candidate, false);
  assert.equal(ev.classify(a()).loop_candidate, false, "1st stale repeat below threshold");
  assert.equal(ev.vector().staleToolResults, 1);
  assert.equal(ev.classify(b()).loop_candidate, false);
  assert.equal(ev.classify(a()).loop_candidate, false, "2nd stale repeat below threshold");
  assert.equal(ev.vector().staleToolResults, 2);
  assert.equal(ev.classify(b()).loop_candidate, false);
  const verdict = ev.classify(a());
  assert.equal(verdict.loop_candidate, true, "3rd stale repeat reaches threshold");
  assert.equal(verdict.reason, "stale_tool_results");
});

test("a changed result for the same inputs resets staleness", () => {
  const ev = new ProgressEvaluator();
  ev.classify(makeAction("run_test", { command: "npm test" }, "exit 1"));
  ev.classify(makeAction("run_test", { command: "npm test" }, "exit 0")); // state changed
  ev.classify(makeAction("run_test", { command: "npm test" }, "exit 1")); // different from previous
  assert.equal(ev.vector().staleToolResults, 0, "results kept changing: nothing stale");
});

test("history is bounded: evicted repeats no longer count", () => {
  const ev = new ProgressEvaluator({ historySize: 4 });
  ev.classify(READ_X());
  ev.classify(READ_X());
  const third = ev.classify(READ_X());
  assert.equal(third.loop_candidate, true, "loop detected inside the window");
  // Evict all three reads with distinct actions.
  ev.classify(READ_Y());
  ev.classify(SEARCH_FOO());
  ev.classify(SEARCH_BAR());
  assert.equal(ev.size, 4);
  const again = ev.classify(READ_X());
  assert.equal(again.loop_candidate, false, "evicted repeats must not resurrect a loop");
  assert.equal(ev.vector().totalActions, 4);
  assert.deepEqual(ev.vector().repeatedCalls, {});
});

test("noProgressTurns counts only the trailing identical run", () => {
  // repeatedCalls threshold raised so the noProgressTurns rule is the one exercised.
  const ev = new ProgressEvaluator({ thresholds: { repeatedCalls: 5, staleToolResults: 5 } });
  ev.classify(READ_X());
  ev.classify(READ_X());
  ev.classify(SEARCH_FOO());
  ev.classify(SEARCH_FOO());
  assert.equal(ev.vector().noProgressTurns, 1, "only the trailing pair counts");
  assert.equal(ev.classify(SEARCH_FOO()).loop_candidate, false, "trailing run of 2 below noProgressTurns threshold");
  const verdict = ev.classify(SEARCH_FOO());
  assert.equal(verdict.loop_candidate, true, "trailing run reaches noProgressTurns threshold");
  assert.equal(verdict.reason, "no_progress_turns");
  assert.equal(ev.vector().noProgressTurns, 3);
});

test("empty history yields a neutral vector", () => {
  const ev = new ProgressEvaluator();
  const v = ev.vector();
  assert.equal(v.totalActions, 0);
  assert.equal(v.noProgressTurns, 0);
  assert.equal(v.staleToolResults, 0);
  assert.equal(v.lastFingerprint, null);
  assert.deepEqual(v.repeatedCalls, {});
  assert.deepEqual(ev.classify(READ_X()), { loop_candidate: false });
});
