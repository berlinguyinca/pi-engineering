#!/usr/bin/env node
/**
 * Fresh-context review of the implemented backlog milestone code (M13-M22:
 * routing, scheduling, budget, security, merge queue, repo intel, verification
 * farm, benchmark, adapter seams + telemetry, parallel task DAG).
 *
 * A brand-new reviewer session inspects the new modules with no prior
 * reasoning. Excluded from CI (requires a live model).
 *
 *   node scripts/fresh-review-backlog.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const SCOPE = [
  "src/routing/ModelRouter.ts (capability+quota routing, separation-of-duties diversity; must degrade to single-model)",
  "src/sched/Scheduler.ts (concurrency limit, backpressure, weighted fairness, speculative execution)",
  "src/budget/BudgetManager.ts (token budget escalation + marginal-value stopping)",
  "src/security/SecurityPolicy.ts (secret redaction, tool policy, prompt-injection guardrails, fail-closed)",
  "src/merge/MergeQueue.ts (candidate->integration->main promotion, rebase, gate, serialized)",
  "src/intel/RepoIntel.ts (dependency-free symbol index, optional LspIntegration seam)",
  "src/verify/farm/*.ts (test-impact, adversarial gate, property scaffold, mutation, differential, performance)",
  "src/bench/Benchmark.ts (metrics + baseline gate)",
  "src/adapters/Adapters.ts + src/telemetry/TelemetryExport.ts (optional seams, empty-by-default)",
  "Parallel DAG execution in src/runtime/EngineeringRuntime.ts: executePlan(parallel), computeParallelWaves, withGitLock serializing promotion merges",
].join("\n");

const CHECKLIST = [
  "correctness of routing selection, fairness scheduling, budget escalation, security fail-closed",
  "merge-queue serialization (no shared-index race) and parallel-wave correctness",
  "verification-farm gates must never accept model-claimed evidence without machine execution",
  "optional adapters must never be required by core (standalone constraint)",
  "parallel DAG: dependency ordering, write-scope conflicts, git-lock correctness",
  "test coverage gaps",
  "unverifiable success claims",
  "unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the newly-implemented backlog milestone modules (M13-M22) in the pi-engineering-runtime repo. Read the ACTUAL code (do not trust docs or commit messages):

SCOPE:
${SCOPE}

INSPECT FOR:
${CHECKLIST}

Key invariant: core MUST remain usable standalone — it must not REQUIRE multiple models, AutoSpec, InferWeave, GitHub, or a distributed cluster. Optional seams must be empty by default. Verification evidence must be machine-produced, never model-claimed.

Report concrete findings as severity + file/line + why + fix. If an area is clean, say so explicitly.`;

const run = await worker.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "find", "ls", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 140000,
  timeoutMs: 1_500_000,
});
const r = run.result as WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nFINDINGS:");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
