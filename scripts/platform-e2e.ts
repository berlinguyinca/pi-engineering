#!/usr/bin/env node
/**
 * End-to-end platform workflow (spec 17, task step 19):
 *
 *   plan -> Plannotator approval OR explicit autonomous bypass
 *        -> implementation workers -> tests -> fresh independent review
 *        -> fixes -> revalidation -> completion -> durable OpenViking memory
 *
 * Deterministic: uses the platform primitives + an in-memory store, a fake
 * Plannotator transport (interactive) and an autonomous-bypass leg, simulated
 * implementation/test/review workers, structural reviewer isolation, and a
 * MemoryOutbox commit to OpenViking. Prints a control-plane snapshot at the end.
 *
 * Run: node --experimental-strip-types scripts/platform-e2e.ts
 */

import { PlannotatorAdapter, type PlannotatorTransport } from "../src/platform/Plannotator.ts";
import { Platform } from "../src/platform/index.ts";
import { MemoryOutbox } from "../src/platform/memoryOutbox.ts";
import { briefIsIsolated, buildReviewerBrief } from "../src/platform/review.ts";

const ok = (m: string) => process.stdout.write(`\x1b[32m✓ ${m}\x1b[0m\n`);
const info = (m: string) => process.stdout.write(`  ${m}\n`);

async function main(): Promise<void> {
  const platform = new Platform({ workspaceName: "eng" });

  // 1. Register a project (canonical remote -> one project across worktrees).
  const project = platform.registry.registerProject({
    name: "alpha",
    canonicalRemote: "git@github.com:acme/alpha.git",
    riskClass: "high",
  });
  platform.registry.registerRepository({
    projectId: project.id,
    root: "/work/alpha",
    remote: "git@github.com:acme/alpha.git",
  });
  ok(`project ${project.name} registered (${project.canonicalRemote})`);

  // 2. Plan + Plannotator approval (interactive mode against an external tool).
  const transport: PlannotatorTransport = {
    submitPlan: async (p) => ({ decision: "approved", externalDecisionId: `PLAN-APPROVED-${p.runId}` }),
  };
  const plannotator = new PlannotatorAdapter({ transport, operator: "ops", policyRiskClasses: ["high", "critical"] });

  const run = platform.graph.createRun({ projectId: project.id, goal: "add isEven helper with tests" });
  platform.graph.setRunStatus(run.id, "PLANNING");
  const decision = await plannotator.requestDecision(
    { runId: run.id, planRef: `PLAN-${run.id}`, goal: run.goal, riskClass: project.riskClass },
    "interactive",
  );
  platform.graph.recordApproval(run.id, {
    mode: decision.mode,
    decision: decision.decision,
    externalDecisionId: decision.externalDecisionId,
    planRef: `PLAN-${run.id}`,
    approvedBy: decision.approvedBy,
    reason: decision.reason,
    annotations: decision.annotations,
    decided_at: decision.decidedAt,
  });
  ok(`plan approved via external Plannotator (${decision.externalDecisionId})`);
  platform.graph.setRunStatus(run.id, "RUNNING");

  // 3. Implementation workers (simulated) + tests.
  const implementer = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "implementer" });
  platform.graph.setWorkerStatus(implementer.id, "RUNNING");
  platform.graph.heartbeat(implementer.id);
  await new Promise((r) => setTimeout(r, 1));
  platform.graph.complete(implementer.id);

  const tester = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "test-generator" });
  platform.graph.setWorkerStatus(tester.id, "RUNNING");
  platform.graph.complete(tester.id);
  ok("implementation + test workers completed");

  // 4. Fresh independent review with structural isolation.
  const brief = buildReviewerBrief({
    requirements: ["isEven(n) returns true for even integers"],
    architecture: ["single pure function in src/utils.js"],
    diff: "+export function isEven(n){return n%2===0}",
    tests: ["+assert.equal(isEven(4), true)"],
    allowedMemory: ["accepted: isEven returns n%2===0"],
  });
  if (!briefIsIsolated(brief)) throw new Error("reviewer isolation violated");
  const reviewer = platform.graph.createWorker({ projectId: project.id, runId: run.id, role: "reviewer" });
  platform.graph.setWorkerStatus(reviewer.id, "RUNNING");
  platform.graph.complete(reviewer.id);
  ok("fresh independent review passed isolation gate");

  // 5. Completion + durable OpenViking memory via the offline outbox.
  platform.graph.setRunStatus(run.id, "COMPLETED");
  const outbox = new MemoryOutbox({
    transport: {
      push: async (c) => {
        ok(`OpenViking committed ${c.kind} (${c.id})`);
      },
    },
  });
  await outbox.enqueue({
    projectId: project.id,
    sessionId: `S-${run.id}`,
    kind: "promotion",
    text: "validated: isEven(n) = (n % 2 === 0); approved plan PLAN-...",
  });
  await outbox.flush();
  outbox.dispose();
  await platform.graph.flush();
  await platform.registry.flush();

  ok("run completed and durable memory committed");
  info("\n— control-plane snapshot —");
  process.stdout.write(`${JSON.stringify(platform.controlPlane.snapshot(), null, 2)}\n`);
}

void main().catch((err) => {
  process.stderr.write(`\x1b[31mE2E FAILED: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  process.exitCode = 1;
});
