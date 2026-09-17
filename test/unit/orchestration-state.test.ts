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
