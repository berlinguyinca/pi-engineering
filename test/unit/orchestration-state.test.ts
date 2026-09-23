import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertMissionTransition,
  assertTaskTransition,
  canTransitionMission,
  canTransitionTask,
} from "../../src/orchestration/state.ts";

describe("orchestration state machines", () => {
  it("follows the canonical mission lifecycle", () => {
    const steps: Array<[string, string]> = [
      ["NEW", "CLASSIFYING"],
      ["CLASSIFYING", "PLANNING"],
      ["PLANNING", "READY"],
      ["READY", "EXECUTING"],
      ["EXECUTING", "INTEGRATING"],
      ["INTEGRATING", "VALIDATING"],
      ["VALIDATING", "REVIEWING"],
      ["REVIEWING", "REPAIRING"],
      ["REPAIRING", "FINAL_VALIDATION"],
      ["FINAL_VALIDATION", "COMPLETE"],
    ];
    for (const [from, to] of steps) {
      assert.ok(canTransitionMission(from as never, to as never), `${from} -> ${to}`);
    }
  });

  it("rejects illegal mission transitions (runtime owns lifecycle)", () => {
    assert.throws(() => assertMissionTransition("NEW", "COMPLETE"));
    assert.throws(() => assertMissionTransition("COMPLETE", "EXECUTING"));
    assert.throws(() => assertMissionTransition("NEW", "REVIEWING"));
  });

  it("allows cancellation and failure from active states", () => {
    assert.ok(canTransitionMission("EXECUTING", "CANCELING"));
    assert.ok(canTransitionMission("CANCELING", "CANCELED"));
    assert.ok(canTransitionMission("EXECUTING", "FAILED"));
    assert.ok(canTransitionMission("EXECUTING", "WAITING_FOR_USER"));
  });

  it("allows forward skips when a stage's gate does not apply (read-only missions)", () => {
    // A read-only investigation has no validation/review task, so it must be
    // able to settle from EXECUTING straight to FINAL_VALIDATION -> COMPLETE.
    assert.ok(canTransitionMission("EXECUTING", "FINAL_VALIDATION"));
    assert.ok(canTransitionMission("INTEGRATING", "FINAL_VALIDATION"));
    assert.ok(canTransitionMission("FINAL_VALIDATION", "COMPLETE"));
    // The bug this regression covers: completing directly from EXECUTING threw
    // `illegal mission transition EXECUTING -> COMPLETE`.
    assert.throws(() => assertMissionTransition("EXECUTING", "COMPLETE"));
    // Backwards moves are still illegal.
    assert.ok(!canTransitionMission("FINAL_VALIDATION", "EXECUTING"));
    assert.ok(!canTransitionMission("COMPLETE", "REPAIRING"));
  });

  it("resilience states: waiting missions park and resume (not fail)", () => {
    // A mission parks in a WAITING_* state on infrastructure failure.
    assert.ok(canTransitionMission("EXECUTING", "WAITING_FOR_LLM"));
    assert.ok(canTransitionMission("EXECUTING", "WAITING_FOR_CAPACITY"));
    assert.ok(canTransitionMission("EXECUTING", "WAITING_FOR_GATEWAY"));
    assert.ok(canTransitionMission("EXECUTING", "WAITING_FOR_MODEL"));
    assert.ok(canTransitionMission("EXECUTING", "RECOVERING_CONTEXT"));
    // And resumes back to execution (never dead-ends).
    assert.ok(canTransitionMission("WAITING_FOR_LLM", "EXECUTING"));
    assert.ok(canTransitionMission("WAITING_FOR_CAPACITY", "EXECUTING"));
    assert.ok(canTransitionMission("WAITING_FOR_GATEWAY", "EXECUTING"));
    assert.ok(canTransitionMission("RECOVERING_CONTEXT", "EXECUTING"));
    assert.ok(canTransitionMission("WAITING_FOR_MODEL", "EXECUTING"));
  });

  it("PAUSED_INFRASTRUCTURE is the terminal-on-exhaustion state and resumes", () => {
    assert.ok(canTransitionMission("WAITING_FOR_LLM", "PAUSED_INFRASTRUCTURE"));
    assert.ok(canTransitionMission("WAITING_FOR_CAPACITY", "PAUSED_INFRASTRUCTURE"));
    assert.ok(canTransitionMission("WAITING_FOR_GATEWAY", "PAUSED_INFRASTRUCTURE"));
    // Resume path: PAUSED -> QUEUED -> STARTING -> EXECUTING.
    assert.ok(canTransitionMission("PAUSED_INFRASTRUCTURE", "QUEUED"));
    assert.ok(canTransitionMission("QUEUED", "STARTING"));
    assert.ok(canTransitionMission("STARTING", "EXECUTING"));
  });

  it("NEEDS_ATTENTION is for auth/config errors and can be resumed", () => {
    assert.ok(canTransitionMission("EXECUTING", "NEEDS_ATTENTION"));
    assert.ok(canTransitionMission("WAITING_FOR_LLM", "NEEDS_ATTENTION"));
    assert.ok(canTransitionMission("NEEDS_ATTENTION", "EXECUTING"));
    assert.ok(canTransitionMission("NEEDS_ATTENTION", "QUEUED"));
  });

  it("task transitions: READY->RUNNING->SUCCEEDED and retry", () => {
    assert.ok(canTransitionTask("PENDING", "READY"));
    assert.ok(canTransitionTask("READY", "RUNNING"));
    assert.ok(canTransitionTask("RUNNING", "SUCCEEDED"));
    assert.ok(canTransitionTask("RUNNING", "FAILED"));
    assert.ok(canTransitionTask("FAILED", "RETRYING"));
    assert.ok(canTransitionTask("RETRYING", "READY"));
    assert.throws(() => assertTaskTransition("SUCCEEDED", "RUNNING"));
    assert.throws(() => assertTaskTransition("PENDING", "RUNNING"));
  });
});
