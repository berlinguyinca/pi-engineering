/**
 * APS Phase 6 — observability aggregation (Grafana-ready) and rollout gate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApsObservability, apsNotice, emptySnapshot } from "../../src/aps/observability.ts";
import { resolveRollout } from "../../src/aps/rollout.ts";
import type { AgentLoopPreventedEvent, SemanticStrategyFamily } from "../../src/aps/types.ts";

function prevented(
  model: string,
  tool: string,
  turns: number,
  utilization: number,
  family: SemanticStrategyFamily = "SEARCH_SYMBOL",
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
    reason: "no_progress_turns",
    fingerprint: "fp",
    tool,
    model: { provider: "metabolomics", id: model },
    contextUtilization: utilization,
    family,
    target: "x.ts",
    metrics: { noProgressTurns: turns, repeatedCalls: turns, staleToolResults: 0 },
  };
}

test("empty snapshot has zeroed totals and buckets", () => {
  const s = emptySnapshot();
  assert.equal(s.totals.loopCandidates, 0);
  assert.equal(s.recoverySuccessRate, null);
  assert.deepEqual(s.loopsByContextUtilizationBucket, {
    "<0.5": 0,
    "0.5-0.75": 0,
    "0.75-0.9": 0,
    ">=0.9": 0,
    unknown: 0,
  });
});

test("missing utilization lands in the unknown bucket", () => {
  const obs = new ApsObservability();
  obs.recordPrevented(prevented("m1", "read_file", 4, 0.9));
  obs.recordPrevented(prevented("m1", "read_file", 4, Number.NaN));
  const s = obs.snapshot();
  assert.equal(s.loopsByContextUtilizationBucket[">=0.9"], 1);
  assert.equal(s.loopsByContextUtilizationBucket.unknown, 1);
});

test("snapshot returns a copy, not mutable internal state", () => {
  const obs = new ApsObservability();
  obs.recordPrevented(prevented("m1", "read_file", 4, 0.5));
  const s = obs.snapshot();
  s.totals.loopCandidates = 999;
  assert.equal(obs.snapshot().totals.loopCandidates, 1);
});

test("loop rate is bucketed by model, tool, and context utilization", () => {
  const obs = new ApsObservability();
  obs.recordPrevented(prevented("m1", "read_file", 4, 0.9));
  obs.recordPrevented(prevented("m1", "read_file", 4, 0.9));
  obs.recordPrevented(prevented("m2", "search_text", 3, 0.4));
  const s = obs.snapshot();
  assert.equal(s.totals.loopsPrevented, 3);
  assert.equal(s.loopRateByModel.m1, 2);
  assert.equal(s.loopRateByModel.m2, 1);
  assert.equal(s.loopsByTool.read_file, 2);
  assert.equal(s.loopsByContextUtilizationBucket[">=0.9"], 2);
  assert.equal(s.loopsByContextUtilizationBucket["<0.5"], 1);
  assert.equal(s.noProgressTurnsBySession["sess-1"], 4);
});

test("recovery is tallied by action (compact vs replan)", () => {
  const obs = new ApsObservability();
  obs.recordRecovery("compact");
  obs.recordRecovery("replan");
  const s = obs.snapshot();
  assert.equal(s.totals.recoveries, 2);
  assert.equal(s.totals.compactions, 1);
  assert.equal(s.totals.replans, 1);
  assert.equal(s.compactionFrequency, 1);
});

test("recovery success rate is null until prevented, then a ratio", () => {
  const obs = new ApsObservability();
  assert.equal(obs.snapshot().recoverySuccessRate, null);
  obs.recordPrevented(prevented("m1", "read_file", 4, 0.5));
  obs.recordRecoveryOutcome(true);
  obs.recordPrevented(prevented("m1", "read_file", 4, 0.5));
  obs.recordRecoveryOutcome(false);
  const s = obs.snapshot();
  assert.equal(s.recoverySuccessRate, 0.5);
});

test("escalation is tallied as model vs human", () => {
  const obs = new ApsObservability();
  obs.recordEscalation({
    type: "agent.escalation",
    event_id: "e1",
    timestamp: "t",
    sessionId: "s",
    runId: "r",
    workItemId: "WI-1",
    role: "implementer",
    tier: 1,
    fromModel: "m1",
    toModel: "m2",
    reason: "loop_prevented_after_recovery",
    attempt: 1,
    escalatedToHuman: false,
    humanReviewRequested: false,
  });
  obs.recordEscalation({
    type: "agent.escalation",
    event_id: "e2",
    timestamp: "t",
    sessionId: "s",
    runId: "r",
    workItemId: "WI-1",
    role: "implementer",
    tier: 1,
    fromModel: "m1",
    toModel: null,
    reason: "loop_prevented_after_recovery",
    attempt: 2,
    escalatedToHuman: true,
    humanReviewRequested: true,
  });
  const s = obs.snapshot();
  assert.equal(s.escalationFrequency, 2);
  assert.equal(s.totals.modelEscalations, 1);
  assert.equal(s.totals.humanEscalations, 1);
});

test("apsNotice renders compact human-readable TUI lines", () => {
  assert.match(apsNotice(prevented("m1", "read_file", 4, 0.5)), /loop prevented.*SEARCH_SYMBOL/);
  assert.match(
    apsNotice({
      type: "agent.escalation",
      event_id: "e",
      timestamp: "t",
      sessionId: "s",
      runId: "r",
      workItemId: "WI-1",
      role: "implementer",
      tier: 1,
      fromModel: "m1",
      toModel: null,
      reason: "r",
      attempt: 1,
      escalatedToHuman: true,
      humanReviewRequested: true,
    }),
    /→ human/,
  );
});

test("rollout progressively enables enforcement by phase", () => {
  assert.equal(resolveRollout(1).detection, true);
  assert.equal(resolveRollout(1).prevention, false);
  assert.equal(resolveRollout(2).prevention, false);
  assert.equal(resolveRollout(3).prevention, true);
  assert.equal(resolveRollout(3).recovery, false);
  assert.equal(resolveRollout(4).recovery, true);
  assert.equal(resolveRollout(4).escalation, false);
  assert.equal(resolveRollout(5).escalation, true);
  assert.equal(resolveRollout(6).observability, true);
});
