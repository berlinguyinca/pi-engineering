#!/usr/bin/env node
/**
 * Independent fresh-context review of the tier-1 OpenViking service.
 *
 *   node scripts/fresh-review-openviking-service.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const task = `Independently review the tier-1 OpenViking service just added to pi-engineering-runtime. Read the actual code (do not trust this prompt).

Review these files:
- services/openviking/src/server.mjs (HTTP service: POST /memory, GET /memory, GET /memory/search?q=, GET /health, optional Bearer auth)
- services/openviking/src/store.mjs (MemoryStore + PostgresStore, tokenized relevance search)
- services/openviking/src/index.mjs (env-driven entrypoint)
- services/openviking/Dockerfile, docker-compose.yml, .env.example, package.json
- test/integration/openviking.test.ts (end-to-end contract test via the runtime's OpenVikingProvider)

Check specifically:
1. CONTRACT MATCH: does the service serve exactly the DurableMemoryProvider contract that src/blackhole/durable.ts OpenVikingProvider expects (paths, methods, auth header, response shapes)? Any mismatch?
2. SECURITY: is Bearer auth applied to all memory endpoints (not just some)? Is /health safely unauthenticated? Are there injection risks (SQL injection in PostgresStore, query injection)?
3. ROBUSTNESS: request body handling, JSON parsing errors, store failure handling, server error responses.
4. CORRECTNESS: does tokenized search behave correctly (empty query returns all; no false negatives)?
5. Any critical/high bugs, contract violations, or security issues. Also flag medium/low.

Report each check as RESOLVED or OPEN/REGRESSED with file+line. Be concise and concrete.`;

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
