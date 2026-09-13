#!/usr/bin/env node
/**
 * Focused re-review of the Blackhole fix round — verifies the fresh-review
 * findings were actually resolved in the code (not just claimed).
 *
 *   node scripts/fresh-review-blackhole-fixes.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const FIXES = [
  "1. Fail-closed version drift: BlackholeManager.open must disable the manager and record a failure lifecycle event when an installed pi-blackhole version mismatches the pinned 0.5.4 (not silently run an unvalidated provider). Check src/blackhole/BlackholeManager.ts open().",
  "2. In-session recall wired into the runtime: EngineeringRuntime.runWorker must recall prior session memory (stable session identity keyed on work item/role/worker) and append it to the worker context so repeated work is context-efficient. Check src/runtime/EngineeringRuntime.ts runWorker().",
  "3. Background memory workers invoked: runWorker must trigger a lower-priority observer memory worker after a completed run (fire-and-forget, never fails the engineering task).",
  "4. Benchmark honesty: the report must explicitly label the benchmark as a deterministic model-free simulator, not a measured model claim. Check src/benchmark/Report.ts.",
  "5. Dashboard dead code removed/wired: src/blackhole/dashboard.ts panels must be exported from index.ts and used by the /blackhole extension command.",
  "6. Session TTL GC: idle sessions must be pruned so per-process memory is bounded. Check src/blackhole/BlackholeManager.ts pruneIdleSessions() + sessionTtlMs usage.",
].join("\n");

const worker = new PiWorkerExecutor({});
const task = `Verify the following Blackhole fix-round findings are RESOLVED in the actual code of the pi-engineering-runtime repo (read the code, do not trust this prompt):

${FIXES}

For each fix, report RESOLVED if the code genuinely addresses it, or OPEN/REGRESSED with file+line if not. Also flag any NEW critical/high issues you notice in the changed files. Be concise and concrete.`;

const run = await worker.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "find", "ls", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 120000,
  timeoutMs: 1_500_000,
});
const r = run.result as WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nFINDINGS:");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
