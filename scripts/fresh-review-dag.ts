import type { WorkerResult } from "../src/core/types.ts";
/**
 * Fresh-context review of the roadmap-completion milestone: task DAG planning +
 * execution, verify profile caching, /verify full, tournament strategy +
 * finalist challenger, and the biome gate. A brand-new reviewer session with no
 * inherited reasoning inspects the change.
 */
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const MILESTONE = [
  "plan(goal) decomposes a goal into a dependency-aware task DAG recorded in the ledger, with depends_on edges resolved to real task ids.",
  "executePlan(planId) runs tasks in topological order through the engineer pipeline, blocks tasks whose dependencies failed, and links each executed task to its result work item.",
  "topoSort throws on cycles and unknown dependencies; tasksConflict and blockedByFailure are correct.",
  "CommandVerifier.detect caches per-repo keyed on package.json content and invalidates on change; detect(cwd,{full}) adds lint + test:full stages.",
  "tournament supports configurable winner-selection strategies and an optional clean-room challenger pass that can promote the runner-up.",
  "Must stay model-agnostic and not depend on AutoSpec/InferWeave/GitHub.",
].join("\n");

const CHECKLIST = [
  "correctness defects in plan/executePlan/topoSort/tasksConflict/blockedByFailure",
  "task status/result linkage leaks or stale-state hazards",
  "verify-cache correctness (stale profiles, key collisions)",
  "tournament strategy/challenger edge cases (swap, eligibility, non-determinism)",
  "error-handling gaps (planner returns malformed tasks, empty plans, cycles)",
  "test gaps",
  "unverifiable success claims",
  "unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the roadmap-completion milestone in the pi-engineering-runtime repo. Focus on src/plan/taskDag.ts, the plan()/executePlan()/challengeFinalists()/selectionCompare methods in src/runtime/EngineeringRuntime.ts, the verify caching + full-suite in src/verify/Verifier.ts, and the tournament changes. Read the actual code and tests (test/unit/taskdag.test.ts, test/integration/dag.test.ts, test/unit/verifier.test.ts, test/integration/vertical-slice.test.ts). Do not trust docs or commit messages.

MILESTONE REQUIREMENTS:
${MILESTONE}

INSPECT FOR:
${CHECKLIST}

Report concrete findings as severity + file/line + why + fix. If an area is clean, say so explicitly.`;

const run = await worker.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "find", "ls", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 90000,
  timeoutMs: 900_000,
});
const r = run.result as WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nFINDINGS:");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
const details = (r.details ?? {}) as { findings?: Array<{ severity?: string; claim?: string }> };
console.log("\nDETAILS.FINDINGS:");
for (const f of details.findings ?? []) console.log(`- [${f.severity}] ${f.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
