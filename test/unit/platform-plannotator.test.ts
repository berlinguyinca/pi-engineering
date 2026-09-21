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

describe("PlannotatorAdapter external boundary (found by a fresh-context review)", () => {
  const proposal = { runId: "RX", planRef: "PLAN-RX", goal: "g", riskClass: "high" as const };

  it("a gate that never answers is a rejection, not an eternal wait", async () => {
    // `await this.transport.submitPlan(plan)` had no deadline, so a hung
    // external Plannotator parked the run indefinitely.
    const adapter = new PlannotatorAdapter({
      transport: { submitPlan: () => new Promise<never>(() => {}) },
      decisionTimeoutMs: 20,
    });
    const decision = await adapter.requestDecision(proposal, "interactive");
    assert.equal(decision.decision, "rejected", "silence is never approval");
    assert.match(String(decision.reason), /did not answer/);
  });

  it("an arbitrary decision string does not become an approval", async () => {
    // The reply was written straight into the persisted record, so any string
    // passed — including one that is not a decision this model defines.
    const adapter = new PlannotatorAdapter({
      transport: { submitPlan: async () => ({ decision: "approved-ish" }) as never },
    });
    const decision = await adapter.requestDecision(proposal, "interactive");
    assert.equal(decision.decision, "rejected");
  });

  it("annotations and ids from the gate are bounded", async () => {
    const adapter = new PlannotatorAdapter({
      transport: {
        submitPlan: async () =>
          ({
            decision: "annotated",
            externalDecisionId: "x".repeat(10_000),
            annotations: Array.from({ length: 5_000 }, () => "y".repeat(50_000)),
          }) as never,
      },
    });
    const decision = await adapter.requestDecision(proposal, "interactive");
    assert.ok((decision.externalDecisionId ?? "").length <= 256, "an id from a remote is capped");
    assert.ok(decision.annotations.length <= 100, "and so is the number of annotations");
    assert.ok(
      decision.annotations.every((a) => a.length <= 4096),
      "and the size of each",
    );
  });

  it("a non-array annotations field is ignored rather than stored", async () => {
    const adapter = new PlannotatorAdapter({
      transport: { submitPlan: async () => ({ decision: "approved", annotations: "not an array" }) as never },
    });
    const decision = await adapter.requestDecision(proposal, "interactive");
    assert.deepEqual(decision.annotations, []);
  });
});
