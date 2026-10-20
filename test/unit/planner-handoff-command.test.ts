/**
 * Unit tests for the manual `/handoff` driver (spec Unit B2).
 *
 * `runHandoff` builds a bounded `HandoffArtifact` (summary ≤ 1500, diff ≤ 24k,
 * clipped) and drives the fixed handoff state machine `prepared → committed` on
 * success, or transitions to `aborted` when the artifact cannot be built.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HandoffInput } from "../../src/plannerWorker/handoff.ts";
import { runHandoff } from "../../src/plannerWorker/handoffCommand.ts";
import type { MissionBrief, TaskContract } from "../../src/plannerWorker/types.ts";

function validBrief(): MissionBrief {
  return {
    mission_id: "PW-test",
    summary: "A test mission summary.",
    architectural_context: ["arch line 1"],
    acceptance_criteria: ["it works"],
    constraints: ["stay bounded"],
  };
}

function validContract(): TaskContract {
  return {
    task_id: "t1",
    objective: "Do the thing",
    depends_on: [],
    scope: { allowed: ["src/**"], forbidden: [] },
    acceptance: ["it works"],
    verification: ["npm test"],
    constraints: ["stay in scope"],
    risk: "low",
    relevant_files: ["src/foo.ts"],
    decisions: ["dec-t1"],
  };
}

function validInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    kind: "planner_to_worker",
    brief: validBrief(),
    plan: { decisions: ["dec-1"], architectural_context: ["arch-1"] },
    contract: validContract(),
    from: "planner",
    to: "implementer",
    ...overrides,
  };
}

describe("runHandoff (manual /handoff)", () => {
  it("produces a committed HandoffArtifact with bounded fields", () => {
    // A long summary + diff that exceed the bounds; buildHandoff clips them.
    const result = runHandoff(
      validInput({
        brief: { ...validBrief(), summary: "s".repeat(5000) },
        workerOutcome: {
          summary: "w".repeat(5000),
          changed_files: ["src/foo.ts"],
          diff: "d".repeat(60_000),
          verification: [{ command: "npm test", exit_code: 0, passed: true, output_tail: "ok", duration_ms: 1 }],
        },
      }),
    );
    assert.equal(result.state, "committed");
    assert.ok(result.artifact);
    assert.ok(result.rendered && result.rendered.length > 0);
    // The 5000-char summary is clipped to ~1500 (plus a short marker) and the
    // 60k-char diff to ~24000 — both far below the unclipped input.
    assert.ok(
      result.artifact.mission_summary.length <= 1600,
      `summary length ${result.artifact.mission_summary.length}`,
    );
    assert.ok(
      result.artifact.worker_outcome!.diff.length <= 24_100,
      `diff length ${result.artifact.worker_outcome!.diff.length}`,
    );
  });

  it("passes a short summary through unclipped", () => {
    const short = "A short summary.";
    const result = runHandoff(validInput({ brief: { ...validBrief(), summary: short } }));
    assert.equal(result.state, "committed");
    assert.equal(result.artifact?.mission_summary, short);
  });

  it("aborts when the artifact cannot be built", () => {
    // A malformed contract (missing depends_on) with a dependency makes
    // buildHandoff's filter callback throw, so the handoff aborts.
    const failing = {
      ...validInput(),
      contract: { ...validContract(), depends_on: undefined } as unknown as TaskContract,
      dependencies: [{ task_id: "dep1", summary: "dep summary", changed_files: [] }],
    };
    const result = runHandoff(failing);
    assert.equal(result.state, "aborted");
    assert.ok(result.error);
    assert.equal(result.artifact, undefined);
  });
});
