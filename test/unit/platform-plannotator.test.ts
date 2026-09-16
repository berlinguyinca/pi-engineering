import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlannotatorAdapter, type PlannotatorTransport } from "../../src/platform/Plannotator.ts";

const plan = (runId: string, riskClass: "low" | "medium" | "high" | "critical") => ({
  runId,
  planRef: `PLAN-${runId}`,
  goal: "g",
  riskClass,
});

function fakeTransport(decision: "approved" | "rejected" | "annotated"): PlannotatorTransport {
  return {
    submitPlan: async (p) => ({
      decision,
      externalDecisionId: `EXT-${p.runId}`,
      approvedBy: "ops",
      annotations: decision === "annotated" ? ["note"] : [],
    }),
  };
}

describe("PlannotatorAdapter", () => {
  it("interactive mode consults the external transport and persists the decision", async () => {
    const adapter = new PlannotatorAdapter({ transport: fakeTransport("approved"), operator: "ops" });
    const d = await adapter.requestDecision(plan("R1", "high"), "interactive");
    assert.equal(d.decision, "approved");
    assert.equal(d.externalDecisionId, "EXT-R1");
    assert.equal(d.mode, "interactive");
    assert.equal(adapter.getDecision("R1")?.approvedBy, "ops");
  });

  it("autonomous mode bypasses explicitly and audits, never faking approval", async () => {
    const adapter = new PlannotatorAdapter();
    const d = await adapter.requestDecision(plan("R2", "critical"), "autonomous");
    assert.equal(d.decision, "bypassed");
    assert.equal(d.externalDecisionId, null);
    assert.equal(d.reason, "autonomous mode: explicit bypass, approval not faked");
  });

  it("policy mode invokes only for configured risk classes", async () => {
    const calls: string[] = [];
    const transport: PlannotatorTransport = {
      submitPlan: async (p) => {
        calls.push(p.runId);
        return { decision: "approved", externalDecisionId: `E-${p.runId}` };
      },
    };
    const adapter = new PlannotatorAdapter({ transport, policyRiskClasses: ["high", "critical"] });
    const low = await adapter.requestDecision(plan("R-low", "low"), "policy");
    assert.equal(low.decision, "approved");
    assert.equal(low.approvedBy, "policy");
    assert.equal(calls.length, 0); // not invoked
    const high = await adapter.requestDecision(plan("R-high", "high"), "policy");
    assert.equal(high.externalDecisionId, "E-R-high");
    assert.equal(calls.length, 1);
  });

  it("disabled mode never invokes and records not_required", async () => {
    const adapter = new PlannotatorAdapter();
    const d = await adapter.requestDecision(plan("R3", "high"), "disabled");
    assert.equal(d.decision, "none");
    assert.equal(d.mode, "disabled");
  });

  it("throws when interactive mode lacks a transport", async () => {
    const adapter = new PlannotatorAdapter();
    await assert.rejects(() => adapter.requestDecision(plan("R4", "high"), "interactive"), /transport/);
  });

  it("keeps pending decisions for recovery after restart", async () => {
    const adapter = new PlannotatorAdapter({ transport: fakeTransport("approved") });
    await adapter.requestDecision(plan("R5", "medium"), "interactive");
    assert.equal(adapter.pendingPlans().length, 1);
    assert.equal(adapter.pendingPlans()[0]?.runId, "R5");
  });
});
