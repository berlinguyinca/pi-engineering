import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { groupPhases, loadCavSteps, nextUnverifiedStep, stepKind } from "../../src/cav/steps.ts";

const STEPS_DIR = resolve(import.meta.dirname, "../../docs/specs/cav/steps");

test("loads all 120 CAV atomic steps in numeric order across 24 phases", () => {
  const steps = loadCavSteps(STEPS_DIR);
  assert.equal(steps.length, 120);
  assert.equal(steps[0]!.id, "CAV-00-01");
  assert.equal(steps[steps.length - 1]!.id, "CAV-23-05");
  const phases = groupPhases(steps);
  assert.equal(phases.length, 24);
  assert.equal(phases[0]!.name, "Root of Trust");
  assert.equal(phases[0]!.steps.length, 5);
  assert.deepEqual(
    steps.map((s) => s.id),
    [...steps.map((s) => s.id)].sort(),
  );
});

test("step kinds map by step number", () => {
  assert.equal(stepKind("01"), "define");
  assert.equal(stepKind("02"), "implement");
  assert.equal(stepKind("03"), "test");
  assert.equal(stepKind("04"), "sabotage");
  assert.equal(stepKind("05"), "gate");
});

test("nextUnverifiedStep returns first step not yet verified", () => {
  const steps = [
    { id: "CAV-00-01", phase: "00", step: "01" },
    { id: "CAV-00-02", phase: "00", step: "02" },
  ] as never;
  const verified = new Set(["CAV-00-01"]);
  const next = nextUnverifiedStep(steps as never, (id) => verified.has(id));
  assert.equal(next!.step.id, "CAV-00-02");
});

test("missing steps dir yields empty registry (fails open on infra)", () => {
  assert.equal(loadCavSteps("/nonexistent/path").length, 0);
});
