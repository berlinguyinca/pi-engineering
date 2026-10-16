/**
 * Issue #147 quarantine gate: a pure function that forces a stage red when it
 * runs a quarantined test, without any I/O or external state.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyQuarantine, type QuarantineOutcome, type QuarantineStage } from "../../src/verify/quarantineGate.ts";

function stage(name: string, passed: boolean, tests?: readonly string[]): QuarantineStage {
  return tests === undefined ? { name, passed } : { name, passed, tests };
}

function outcome(stages: readonly QuarantineStage[], passed = true): QuarantineOutcome {
  return { passed, stages };
}

describe("applyQuarantine", () => {
  it("is pure: does not mutate the outcome or the quarantined list", () => {
    const stages = [stage("lint", true), stage("test", false, ["a", "b"])];
    const input = outcome(stages, false);
    const quarantined = ["a"];
    const snapshotStages = stages.map((s) => ({ ...s }));
    const snapshotQuarantined = [...quarantined];
    const result = applyQuarantine(input, quarantined);

    assert.deepEqual(stages, snapshotStages);
    assert.equal(input.passed, false);
    assert.deepEqual(quarantined, snapshotQuarantined);
    assert.notEqual(result.stages, stages);
  });

  it("forces a stage red and lists the hit when its tests contain a quarantined name", () => {
    const stages = [stage("lint", true), stage("test", true, ["ok", "slow"])];
    const result = applyQuarantine(outcome(stages, true), ["slow"]);
    assert.equal(result.stages[1]!.passed, false);
    assert.deepEqual(result.quarantinedHits, ["slow"]);
    assert.equal(result.passed, false);
  });

  it("collects hits in stage/test encounter order across multiple stages", () => {
    const stages = [
      stage("test:a", true, ["one", "q1", "two", "q2"]),
      stage("test:b", true, ["q3", "three"]),
    ];
    const result = applyQuarantine(outcome(stages, true), ["q2", "q1", "q3", "q4"]);
    assert.deepEqual(result.quarantinedHits, ["q1", "q2", "q3"]);
    assert.equal(result.stages[0]!.passed, false);
    assert.equal(result.stages[1]!.passed, false);
    assert.equal(result.passed, false);
  });

  it("leaves stages without a quarantined test untouched (same reference and content)", () => {
    const cleanStage = stage("lint", true, ["x"]);
    const greenStage = stage("test", true, ["ok"]);
    const result = applyQuarantine(outcome([cleanStage, greenStage], true), ["other"]);
    assert.equal(result.stages[0], cleanStage);
    assert.equal(result.stages[1], greenStage);
    assert.deepEqual(result.quarantinedHits, []);
    assert.equal(result.passed, true);
  });

  it("a stage with no tests field is judged by its own passed value", () => {
    const noTestsFalse = stage("build", false);
    const noTestsTrue = stage("lint", true);
    const result = applyQuarantine(outcome([noTestsFalse, noTestsTrue], false), ["anything"]);
    assert.equal(result.stages[0], noTestsFalse);
    assert.equal(result.stages[1], noTestsTrue);
    assert.equal(result.passed, false);
  });

  it("a quarantined test in an already-red stage is still listed but the stage stays false", () => {
    const stages = [stage("test", false, ["slow"])];
    const result = applyQuarantine(outcome(stages, false), ["slow"]);
    assert.deepEqual(result.quarantinedHits, ["slow"]);
    assert.equal(result.stages[0]!.passed, false);
    assert.equal(result.passed, false);
  });

  it("absent quarantined tests leave the outcome unchanged with empty quarantinedHits", () => {
    const stages = [stage("test", true, ["a"]), stage("test", false, ["b"])];
    const result = applyQuarantine(outcome(stages, false), []);
    assert.equal(result.stages[0], stages[0]);
    assert.equal(result.stages[1], stages[1]);
    assert.deepEqual(result.quarantinedHits, []);
    assert.equal(result.passed, false);
  });

  it("empty stages gates to passed with empty hits", () => {
    const result = applyQuarantine(outcome([], false), ["q"]);
    assert.deepEqual(result.stages, []);
    assert.deepEqual(result.quarantinedHits, []);
    assert.equal(result.passed, true);
  });

  it("result passed is the AND of every stage's passed value after gating", () => {
    // A stage with no tests field (red) still forces the aggregate red.
    const mixed = applyQuarantine(outcome([stage("lint", true), stage("build", false)], false), []);
    assert.equal(mixed.passed, false);

    // A quarantined hit flips a green stage and the aggregate.
    const flipped = applyQuarantine(outcome([stage("test", true, ["slow"])], true), ["slow"]);
    assert.equal(flipped.stages[0]!.passed, false);
    assert.equal(flipped.passed, false);
  });
});
