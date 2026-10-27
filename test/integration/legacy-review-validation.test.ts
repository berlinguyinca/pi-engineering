import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

for (const [name, details] of [
  ["missing findings", {}],
  ["null details", null],
  ["non-array findings", { findings: "serious defect" }],
  ["null finding", { findings: [null] }],
  ["missing claim", { findings: [{ severity: "high", evidence: "diff://a" }] }],
  ["blank claim", { findings: [{ severity: "high", claim: "  ", evidence: "diff://a" }] }],
  ["unknown severity", { findings: [{ severity: "major", claim: "defect", evidence: "diff://a" }] }],
  ["malformed evidence", { findings: [{ severity: "high", claim: "defect", evidence: {} }] }],
  ["partly malformed findings", { findings: [{ severity: "high", claim: "defect", evidence: "diff://a" }, {}] }],
] as const) {
  test(`legacy review fails closed for ${name}`, async () => {
    const fixture = await makeFixtureRepo();
    try {
      const worker = new FakeWorkerExecutor({
        reviewer: () => ({
          status: "completed",
          summary: "Changes required",
          details: details as unknown as Record<string, unknown>,
        }),
      });
      const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
      const wi = await rt.ledger.createWorkItem("review", "medium", [fixture.root], { type: "system" });
      const candidate = await rt.ledger.createCandidate(wi.id, "base", "branch", null, "implementer", "run", null, {
        type: "system",
      });
      const result = await rt.review(wi, candidate, "must be correct");
      assert.equal(result.completed, false);
      assert.match(result.summary, /invalid|malformed|findings/i);
      assert.deepEqual(result.findingIds, [], "a partly invalid review must not be recorded as a completed review");
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const findings of [[], [{ severity: "high", claim: "defect", evidence: "diff://a" }]]) {
  test(`legacy review accepts an explicit valid findings array (${findings.length} findings)`, async () => {
    const fixture = await makeFixtureRepo();
    try {
      const worker = new FakeWorkerExecutor({
        reviewer: () => ({ status: "completed", summary: "reviewed", details: { findings } }),
      });
      const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
      const wi = await rt.ledger.createWorkItem("review", "medium", [fixture.root], { type: "system" });
      const candidate = await rt.ledger.createCandidate(wi.id, "base", "branch", null, "implementer", "run", null, {
        type: "system",
      });
      const result = await rt.review(wi, candidate, "must be correct");
      assert.equal(result.completed, true);
      assert.equal(result.findingIds.length, findings.length);
    } finally {
      await fixture.cleanup();
    }
  });
}
