#!/usr/bin/env node
/** Fresh-context review of the OpenViking auth-diagnostic change. */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";
const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";
const task = `Independently review the OpenViking auth-diagnostic change in pi-engineering-runtime. Read the actual code.
Review:
- src/blackhole/durable.ts (warnAuthOnce: warns once per baseUrl+status on non-OK recall/search; recall/search still return [] fail-closed)
- test/unit/blackhole.test.ts (the new test at the end)
Check:
1. Does it stay fail-closed (recall/search never throw, never fail a worker)? 
2. Is the warn-once dedup correct and thread-safe enough? Any way it spams or misses?
3. Does the diagnostic give a correct, actionable hint (401/403 -> token; other -> base URL)? 
4. Any correctness bug, edge case (e.g. 404, redirect, network error not reaching this path), or security issue?
Report each as RESOLVED or OPEN/REGRESSED with file+line. Be concise and concrete.`;
const w = new PiWorkerExecutor({});
const r = await w.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 120000,
  timeoutMs: 1_500_000,
});
console.log("REVIEW STATUS:", r.result.status);
console.log("SUMMARY:", r.result.summary);
console.log("\nFINDINGS:");
for (const c of r.result.claims) console.log(`- [${c.evidence}] ${c.claim}`);
