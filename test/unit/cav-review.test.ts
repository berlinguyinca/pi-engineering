import assert from "node:assert/strict";
import { test } from "node:test";
import { CavEvidenceLedger } from "../../src/cav/evidence.ts";
import { applyReviewPromotion, evaluateIndependentReview } from "../../src/cav/review.ts";
import type { CavStep } from "../../src/cav/types.ts";

const step: CavStep = {
  id: "CAV-00-01",
  phase: "00",
  step: "01",
  phaseName: "Root of Trust",
  objective: "define",
  spec: "docs/specs/cav/steps/CAV-00-01.md",
  kind: "define",
};

const BASE = {
  gitSha: "abc",
  workerRunId: "REV-1",
  assessment: "mechanism is deterministic and tested",
};

test("reviewer approves a step with a passing TESTED gate", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "TESTED", {
    gitSha: "abc",
    role: "implementer",
    workerRunId: "RUN-1",
    gateType: "unit",
    tool: "node",
    command: "node --test",
    exitCode: 0,
  });
  const verdict = await evaluateIndependentReview(step, { ledger, reviewRole: "reviewer", ...BASE });
  assert.equal(verdict.approved, true);
  assert.ok(verdict.inspectedEvidence.length >= 1);
  const status = await applyReviewPromotion(step, verdict, { ledger, reviewRole: "reviewer", ...BASE });
  assert.equal(status, "VERIFIED");
  assert.equal(ledger.latestStatus("CAV-00-01"), "VERIFIED");
});

test("reviewer cannot approve a step with no evidence", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const verdict = await evaluateIndependentReview(step, { ledger, reviewRole: "reviewer", ...BASE });
  assert.equal(verdict.approved, false);
  assert.ok(verdict.reasons.some((r) => /no evidence/.test(r)));
});

test("reviewer cannot approve a step with a failing (non-zero exit) gate", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "SPECIFIED", {
    gitSha: "abc",
    role: "implementer",
    workerRunId: "RUN-1",
    gateType: "unit",
    tool: "node",
    command: "node --test",
    exitCode: 1,
  });
  const verdict = await evaluateIndependentReview(step, { ledger, reviewRole: "reviewer", ...BASE });
  assert.equal(verdict.approved, false);
  assert.ok(verdict.reasons.some((r) => /non-zero/.test(r)));
});

test("applyReviewPromotion refuses to promote a non-approved verdict", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  const verdict = await evaluateIndependentReview(step, { ledger, reviewRole: "reviewer", ...BASE });
  await assert.rejects(applyReviewPromotion(step, verdict, { ledger, reviewRole: "reviewer", ...BASE }));
});

test("reviewer prose cannot waive a deterministic failure", async () => {
  const ledger = CavEvidenceLedger.inMemory();
  await ledger.record("CAV-00-01", "SPECIFIED", {
    gitSha: "abc",
    role: "implementer",
    workerRunId: "RUN-1",
    gateType: "unit",
    tool: "node",
    command: "node --test",
    exitCode: 2,
  });
  // Even a verbose positive assessment does not override the failed exit code.
  const verdict = await evaluateIndependentReview(step, {
    ledger,
    reviewRole: "reviewer",
    ...BASE,
    assessment: "This looks perfect and definitely works; approve it.",
  });
  assert.equal(verdict.approved, false);
});
