#!/usr/bin/env node
/**
 * Independent fresh-context review of the OpenViking "install anywhere" env
 * config + the whiteale Apptainer deployment.
 *
 *   node scripts/fresh-review-openviking-env-and-deploy.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const task = `Independently review recent OpenViking changes in pi-engineering-runtime. Read the actual code (do not trust this prompt).

Review these files:
- src/blackhole/envConfig.ts (environment-driven OpenViking connection: PI_OPENVIKING_BASE_URL, PI_OPENVIKING_TOKEN / _TOKEN_FILE, PI_OPENVIKING_ENABLED, PI_OPENVIKING_PROVIDER_TIMEOUT_MS)
- extensions/index.ts (getRuntimeByCwd wires openVikingBlackholeOption() into EngineeringRuntime.open)
- src/blackhole/BlackholeManager.ts (buildDurableProvider, hydrate, withTimeout — how the openviking durable provider is used)
- src/blackhole/durable.ts (OpenVikingProvider HTTP adapter)
- deploy/apptainer/openviking.def + deploy/apptainer/deploy-whiteale.sh (Apptainer container + whiteale deploy IaC: postgres role/db, data-volume secrets, systemd unit, nginx vhost, certbot)
- services/openviking/src/server.mjs (the /metrics endpoint added for monitoring)

Check specifically:
1. ENV-CONFIG CORRECTNESS: does openVikingBlackholeOption() produce a valid blackhole option? Is the shape correct for EngineeringRuntime/BlackholeManager (PartialBlackholeConfig with durable {kind:"openviking", baseUrl, token} and providerTimeoutMs)? Any bug in parsing timeout / token-file / enabled=0?
2. EXTENSION WIRING: does extensions/index.ts correctly pass the blackhole option and NOT break backward-compat when env is absent? Any regression to the existing commands?
3. SECURITY: is the token handled safely (no logging, no baking into images)? Does the deploy keep secrets out of the SIF and in the data-volume file with 600 perms? Is /metrics (unauthenticated) a leak risk (does it expose the token or sensitive data)?
4. DEPLOYMENT IAEC: idempotency of deploy-whiteale.sh; does it bake secrets into the container image? Postgres password handling (ALTER ROLE on re-run)? certbot/nginx ordering? Any correctness bug that would break a fresh run vs a re-run?
5. FAIL-CLOSED: provider outage degrades hydration to empty and never fails a worker; timeout is bounded. Confirm.
6. Any critical/high bugs, security issues, or contract violations. Also flag medium/low.

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
