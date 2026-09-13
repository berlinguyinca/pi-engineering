#!/usr/bin/env node
/**
 * Focused re-review of the backlog-review findings after their fixes, to confirm
 * each material finding is actually resolved before recording fresh_review=pass.
 *
 *   node scripts/fresh-review-backlog-fixes.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const PRIOR_FINDINGS = [
  "1. ModelRouter.RouteResult.fallback was never set true (dead field). Fix should set fallback=true when the preferred (first-registered capable) provider is exhausted/ineligible.",
  "2. Scheduler.speculative launched unbounded copies ignoring concurrency/abort and was untested. Fix should bound copies by concurrency, accept an abort signal, and be unit-tested.",
  "3. Scheduler scheduleAll/pickFair were not a true weighted round-robin (heavy sources could dominate). Fix should be a real weighted-deficit round-robin that never starves light sources.",
  "4. tasksConflict used exact string equality so a directory scope (src/) vs a descendant file (src/foo.ts) was NOT a conflict -> parallel-wave race. Fix should detect directory-vs-descendant overlap.",
  "5. PropertyTest skeleton could emit vacuous truthiness checks giving false confidence despite machine execution. Fix should expose a vacuous flag + WARNING comment.",
].join("\n");

const worker = new PiWorkerExecutor({});
const task = `Independently verify that these five backlog-review findings were ACTUALLY fixed in the pi-engineering-runtime repo. Read the actual code and tests (do not trust commit messages):

PRIOR FINDINGS AND THE CLAIMED FIX:
${PRIOR_FINDINGS}

For each finding, check the relevant file (src/routing/ModelRouter.ts, src/sched/Scheduler.ts, src/plan/taskDag.ts, src/verify/farm/PropertyTest.ts and their unit tests) and report:
- RESOLVED (fix is correct and complete), or
- STILL-BROKEN (with why + what remains).

Also sanity-check that the fixes did not introduce regressions (e.g. the parallel-DAG and tournament integration tests still pass; single-model routing still degrades). Be skeptical and concrete.`;

const run = await worker.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "find", "ls", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 60000,
  timeoutMs: 900_000,
});
const r = run.result as WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nFINDINGS:");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
