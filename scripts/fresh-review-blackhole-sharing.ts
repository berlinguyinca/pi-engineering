#!/usr/bin/env node
/**
 * Independent fresh-context review of the cross-worker shared-memory feature.
 *
 *   node scripts/fresh-review-blackhole-sharing.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const task = `Independently review the cross-worker shared-memory feature just added to pi-engineering-runtime. Read the actual code (do not trust this prompt).

Files to review:
- src/blackhole/durable.ts (SharedFileDurableMemory, OpenVikingProvider, buildDurableProvider)
- src/blackhole/BlackholeManager.ts (hydrate(), durable construction, state().durableKind)
- src/blackhole/config.ts + types.ts (DurableStoreConfig, durable.kind)
- src/runtime/EngineeringRuntime.ts runWorker() (durable hydration into worker context)
- src/blackhole/telemetry.ts, src/index.ts (exports)

Check specifically:
1. CORRECTNESS: does a later/other worker actually consume evidence-promoted memory from a shared store (the read path)? Is session-local working memory still strictly isolated from shared durable memory?
2. SAFETY: can a worker write to shared durable memory directly (bypassing the evidence-gated promotion pipeline)? Shared memory must be read-only for workers.
3. FAIL-CLOSED: does an OpenViking provider fail closed when unconfigured? Does a provider outage degrade hydration to empty without failing the worker?
4. CONCURRENCY: is SharedFileDurableMemory.store safe for concurrent appends (atomic per line)?
5. Any new critical/high bugs, regressions, or isolation violations.

Report each check as RESOLVED or OPEN/REGRESSED with file+line. Also list any NEW critical/high findings. Be concise and concrete.`;

const worker = new PiWorkerExecutor({});
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
