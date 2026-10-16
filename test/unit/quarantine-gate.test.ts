/**
 * Issue #276 quarantine gate: a pure function that forces a stage red when it
 * runs a quarantined test, without any I/O or external state.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type QuarantineOutcome,
  type QuarantineStage,
  type QuarantineTest,
  applyQuarantine,
} from "../../src/verify/quarantineGate.ts";

function test(name: string, status: QuarantineTest["status"]): QuarantineTest {
  return { name, status };
}

function stage(name: string, passed: boolean, tests?: QuarantineTest[]): QuarantineStage {
  return tests === undefined ? { name, passed } : { name, passed, tests };
}

function outcome(stages: QuarantineStage[]): QuarantineOutcome {
  return { stages };
}

describe("applyQuarantine", () => {
  it("is pure: does not mutate the outcome or the quarantined set", () => {
    const stages = [stage("lint", true), stage("test", false, [test("a", "pass"), test("b", "fail")])];
    const input = outcome(stages);
    const quarantined = new Set(["a"]);
    const snapshotStages = stages.map((s) => ({
      ...s,
      ...(s.tests !== undefined ? { tests: s.tests.map((t) => ({ ...t })) } : {}),
    }));
    const snapshotQuarantined = new Set(quarantined);
    const result = applyQuarantine(input, quarantined);

    assert.deepEqual(stages, snapshotStages);
    assert.deepEqual(quarantined, snapshotQuarantined);
    assert.notEqual(result.stages, stages);
  });

  it("forces a stage red and lists the hit when its tests contain a quarantined pass", () => {
    const stages = [stage("lint", true), stage("test", true, [test("ok", "pass"), test("slow", "pass")])];
    const result = applyQuarantine(outcome(stages), new Set(["slow"]));
    assert.equal(result.stages[1]!.passed, false);
    assert.deepEqual(result.quarantinedHits, ["slow"]);
    assert.equal(result.passed, false);
  });

  it("a quarantined skip test is also a hit", () => {
    const stages = [stage("test", true, [test("ok", "pass"), test("skipped", "skip")])];
    const result = applyQuarantine(outcome(stages), new Set(["skipped"]));
    assert.equal(result.stages[0]!.passed, false);
    assert.deepEqual(result.quarantinedHits, ["skipped"]);
    assert.equal(result.passed, false);
  });

  it("collects hits in stage/test encounter order across multiple stages", () => {
    const stages = [
      stage("test:a", true, [test("one", "pass"), test("q1", "pass"), test("two", "fail"), test("q2", "skip")]),
      stage("test:b", true, [test("q3", "pass"), test("three", "pass")]),
    ];
    const result = applyQuarantine(outcome(stages), new Set(["q2", "q1", "q3", "q4"]));
    assert.deepEqual(result.quarantinedHits, ["q1", "q2", "q3"]);
    assert.equal(result.stages[0]!.passed, false);
    assert.equal(result.stages[1]!.passed, false);
    assert.equal(result.passed, false);
  });

  it("leaves stages without a quarantined test untouched (same reference and content)", () => {
    const cleanStage = stage("lint", true, [test("x", "pass")]);
    const greenStage = stage("test", true, [test("ok", "pass")]);
    const result = applyQuarantine(outcome([cleanStage, greenStage]), new Set(["other"]));
    assert.equal(result.stages[0], cleanStage);
    assert.equal(result.stages[1], greenStage);
    assert.deepEqual(result.quarantinedHits, []);
    assert.equal(result.passed, true);
  });

  it("a stage with no tests field is judged by its own passed value", () => {
    const noTestsFalse = stage("build", false);
    const noTestsTrue = stage("lint", true);
    const result = applyQuarantine(outcome([noTestsFalse, noTestsTrue]), new Set(["anything"]));
    assert.equal(result.stages[0], noTestsFalse);
    assert.equal(result.stages[1], noTestsTrue);
    assert.equal(result.passed, false);
  });

  it("absent quarantined names leave the outcome unchanged with empty quarantinedHits", () => {
    const stages = [stage("test", true, [test("a", "pass")]), stage("test", false, [test("b", "fail")])];
    const result = applyQuarantine(outcome(stages), new Set());
    assert.equal(result.stages[0], stages[0]);
    assert.equal(result.stages[1], stages[1]);
    assert.deepEqual(result.quarantinedHits, []);
    assert.equal(result.passed, false);
  });

  it("empty stages gates to passed with empty hits", () => {
    const result = applyQuarantine(outcome([]), new Set(["q"]));
    assert.deepEqual(result.stages, []);
    assert.deepEqual(result.quarantinedHits, []);
    assert.equal(result.passed, true);
  });

  it("deduplicates quarantinedHits keeping first-seen order", () => {
    const stages = [
      stage("test:a", true, [test("q", "pass"), test("q", "fail"), test("q", "skip")]),
      stage("test:b", true, [test("q", "pass"), test("r", "pass")]),
    ];
    const result = applyQuarantine(outcome(stages), new Set(["q", "r"]));
    assert.deepEqual(result.quarantinedHits, ["q", "r"]);
    assert.equal(result.stages[0]!.passed, false);
    assert.equal(result.stages[1]!.passed, false);
    assert.equal(result.passed, false);
  });

  it("result passed is the AND of every stage's passed value after gating", () => {
    // A stage with no tests field (red) still forces the aggregate red.
    const mixed = applyQuarantine(outcome([stage("lint", true), stage("build", false)]), new Set());
    assert.equal(mixed.passed, false);

    // A quarantined hit flips a green stage and the aggregate.
    const flipped = applyQuarantine(outcome([stage("test", true, [test("slow", "pass")])]), new Set(["slow"]));
    assert.equal(flipped.stages[0]!.passed, false);
    assert.equal(flipped.passed, false);
  });
});
