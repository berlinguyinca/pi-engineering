/**
 * APS Phase 4 — recovery controller: deterministic replan / conservative
 * compaction decisions and the recovery prompts built from them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecoveryPrompt, decideRecovery, isRecoverable } from "../../src/aps/recovery.ts";
import type { AgentLoopPreventedEvent, SemanticStrategyFamily } from "../../src/aps/types.ts";

function loopEvent(
  family: SemanticStrategyFamily,
  target: string,
  noProgressTurns: number,
  contextUtilization: number | null,
  options: {
    reason?: string;
    noMutationStall?: number;
    noMutationStallDistinct?: number;
  } = {},
): AgentLoopPreventedEvent {
  return {
    type: "agent.loop_prevented",
    prevented: true,
    event_id: "aps-x",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "sess-1",
    runId: "run-1",
    workItemId: "WI-1",
    role: "implementer",
    iteration: 9,
    phase: "execute",
    reason: options.reason ?? "no_progress_turns",
    fingerprint: "fp-x",
    tool: "read_file",
    model: { provider: "metabolomics", id: "qwen3.8-27b" },
    contextUtilization,
    family,
    target,
    metrics: {
      noProgressTurns,
      repeatedCalls: noProgressTurns,
      staleToolResults: 0,
      noMutationStall: options.noMutationStall ?? 0,
      noMutationStallDistinct: options.noMutationStallDistinct ?? 0,
    },
  };
}

test("a read-like loop with low context replans to a different strategy", () => {
  const d = decideRecovery(loopEvent("SEARCH_SYMBOL", "src/x.ts", 4, 0.2));
  assert.equal(d.action, "replan");
  assert.equal(d.fromFamily, "SEARCH_SYMBOL");
  assert.equal(d.toFamily, "READ_DIRECTORY");
  assert.match(d.rationale, /stuck repeating/);
});

test("READ_FILE loops replan to SEARCH_SYMBOL", () => {
  const d = decideRecovery(loopEvent("READ_FILE", "src/x.ts", 4, 0.2));
  assert.equal(d.action, "replan");
  assert.equal(d.toFamily, "SEARCH_SYMBOL");
});

test("high context utilization with identical no-progress turns compacts", () => {
  const d = decideRecovery(loopEvent("SEARCH_SYMBOL", "src/x.ts", 3, 0.9));
  assert.equal(d.action, "compact");
  assert.equal(d.compactedTurns, 3);
  assert.match(d.rationale, /context at 90%/);
});

test("compaction wins over replan under context pressure", () => {
  const d = decideRecovery(loopEvent("READ_FILE", "src/x.ts", 4, 0.95));
  assert.equal(d.action, "compact");
});

test("a loop with no deterministic strategy is not recovered (none)", () => {
  const d = decideRecovery(loopEvent("GENERATE_TEXT", "", 4, 0.2));
  assert.equal(d.action, "none");
  assert.equal(isRecoverable(d), false);
});

test("low context with low no-progress turns on a non-read family is none", () => {
  const d = decideRecovery(loopEvent("RUN_TEST", "a.test.ts", 1, 0.2));
  assert.equal(d.action, "none");
});

test("replan prompt directs a strategy change and forbids the stuck family", () => {
  const d = decideRecovery(loopEvent("READ_FILE", "src/x.ts", 4, 0.2));
  const p = buildRecoveryPrompt(d, loopEvent("READ_FILE", "src/x.ts", 4, 0.2));
  assert.match(p, /STOP using READ_FILE/);
  assert.match(p, /SEARCH_SYMBOL/);
  assert.match(p, /change strategy/i);
});

test("compact prompt discards only identical repeats, keeps differing results", () => {
  const d = decideRecovery(loopEvent("SEARCH_SYMBOL", "src/x.ts", 3, 0.9));
  const p = buildRecoveryPrompt(d, loopEvent("SEARCH_SYMBOL", "src/x.ts", 3, 0.9));
  assert.match(p, /Do NOT repeat/);
  assert.match(p, /keep every result that differs/);
});

test("isRecoverable is true for replan and compact, false for none", () => {
  assert.equal(isRecoverable({ action: "replan", rationale: "r" }), true);
  assert.equal(isRecoverable({ action: "compact", rationale: "r" }), true);
  assert.equal(isRecoverable({ action: "none", rationale: "r" }), false);
});

test("a no-mutation stall recovers even when its last family is not read-like", () => {
  const ev = loopEvent("RUN_COMMAND", "grep -rin case|when src/columns.py", 0, 0.3, {
    reason: "no_mutation_stall",
    noMutationStall: 40,
    noMutationStallDistinct: 3,
  });
  const d = decideRecovery(ev);
  assert.equal(d.action, "replan", "the stall has a deterministic fix regardless of family");
  assert.equal(isRecoverable(d), true);
  assert.match(d.rationale, /40 non-mutating actions over 3 distinct target/);
});

test("the stall recovery prompt sends the worker to the artifact, not another read", () => {
  const ev = loopEvent("READ_FILE", "src/columns.py", 0, 0.3, {
    reason: "no_mutation_stall",
    noMutationStall: 40,
    noMutationStallDistinct: 3,
  });
  const p = buildRecoveryPrompt(decideRecovery(ev), ev);
  assert.match(p, /40 actions over 3 distinct target/);
  assert.match(p, /without writing anything/);
  assert.match(p, /return worker_result naming exactly what blocks you/);
});

test("an ordinary read loop's recovery prompt carries no stall directive", () => {
  const ev = loopEvent("READ_FILE", "src/x.ts", 4, 0.3);
  const p = buildRecoveryPrompt(decideRecovery(ev), ev);
  assert.match(p, /STOP using READ_FILE/);
  assert.doesNotMatch(p, /without writing anything/);
});
