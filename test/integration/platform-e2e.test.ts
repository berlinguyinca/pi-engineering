import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlannotatorAdapter, type PlannotatorTransport } from "../../src/platform/Plannotator.ts";
import { Platform } from "../../src/platform/index.ts";
import { MemoryOutbox } from "../../src/platform/memoryOutbox.ts";
import { briefIsIsolated, buildReviewerBrief } from "../../src/platform/review.ts";

describe("platform end-to-end workflow", () => {
  it("plan -> Plannotator -> workers -> review -> complete -> OpenViking", async () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({
      name: "alpha",
      canonicalRemote: "git@github.com:acme/alpha.git",
      riskClass: "high",
    });

    // Plan + external Plannotator approval (interactive).
    const transport: PlannotatorTransport = {
      submitPlan: async (p) => ({ decision: "approved", externalDecisionId: `A-${p.runId}` }),
    };
    const plannotator = new PlannotatorAdapter({ transport, policyRiskClasses: ["high", "critical"] });
    const run = platform.graph.createRun({ projectId: project.id, goal: "g" });
    const decision = await plannotator.requestDecision(
      { runId: run.id, planRef: `P-${run.id}`, goal: "g", riskClass: project.riskClass },
      "interactive",
    );
    platform.graph.recordApproval(run.id, {
      mode: decision.mode,
      decision: decision.decision,
      externalDecisionId: decision.externalDecisionId,
      planRef: `P-${run.id}`,
      approvedBy: decision.approvedBy,
      reason: decision.reason,
      annotations: decision.annotations,
      decided_at: decision.decidedAt,
    });
    platform.graph.setRunStatus(run.id, "RUNNING");
    assert.equal(platform.graph.getRun(run.id)!.approval?.externalDecisionId, `A-${run.id}`);

    // Implementation + test workers.
    const impl = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "implementer" });
    platform.graph.setWorkerStatus(impl.id, "RUNNING");
    platform.graph.complete(impl.id);
    const tester = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "test-generator" });
    platform.graph.complete(tester.id);

    // Fresh independent review with isolation.
    const brief = buildReviewerBrief({
      requirements: ["r"],
      architecture: ["a"],
      diff: "+code",
      tests: ["+t"],
      allowedMemory: ["accepted decision"],
    });
    assert.ok(briefIsIsolated(brief));
    const reviewer = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "reviewer" });
    platform.graph.complete(reviewer.id);

    // Completion + durable memory via outbox.
    platform.graph.setRunStatus(run.id, "COMPLETED");
    let committed = 0;
    const outbox = new MemoryOutbox({
      transport: { push: async () => void committed++ },
    });
    await outbox.enqueue({ projectId: project.id, sessionId: "S", kind: "promotion", text: "validated fact" });
    await outbox.flush();
    outbox.dispose();
    await platform.graph.flush();
    await platform.registry.flush();

    assert.equal(committed, 1);
    assert.equal(platform.graph.getRun(run.id)!.status, "COMPLETED");
    assert.equal(platform.graph.listWorkers(project.id).length, 3);
    const snap = platform.controlPlane.snapshot();
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0]!.approval?.decision, "approved");
  });

  it("autonomous mode bypasses Plannotator explicitly and audits the decision", async () => {
    const platform = new Platform();
    const project = platform.registry.registerProject({ name: "b", canonicalRemote: "https://github.com/a/b" });
    const plannotator = new PlannotatorAdapter(); // no transport: autonomous must not need it
    const run = platform.graph.createRun({ projectId: project.id, goal: "g" });
    const decision = await plannotator.requestDecision(
      { runId: run.id, planRef: `P-${run.id}`, goal: "g", riskClass: "critical" },
      "autonomous",
    );
    assert.equal(decision.decision, "bypassed");
    assert.equal(decision.externalDecisionId, null);
    platform.graph.recordApproval(run.id, {
      mode: decision.mode,
      decision: decision.decision,
      externalDecisionId: decision.externalDecisionId,
      planRef: `P-${run.id}`,
      approvedBy: decision.approvedBy,
      reason: decision.reason,
      annotations: decision.annotations,
      decided_at: decision.decidedAt,
    });
    await platform.graph.flush();
    assert.equal(platform.graph.getRun(run.id)!.approval?.decision, "bypassed");
  });
});
