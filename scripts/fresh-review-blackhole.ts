#!/usr/bin/env node
/**
 * Fresh-context review of the Blackhole session-memory + benchmark modules
 * (M23). A brand-new reviewer session inspects the actual code with no prior
 * reasoning. Excluded from CI (requires a live model).
 *
 *   node scripts/fresh-review-blackhole.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const SCOPE = [
  "src/blackhole/config.ts (pinned version 0.5.4, allowlist, backward-compatible disabled default)",
  "src/blackhole/versioning.ts (package validation, builtin fallback, fail-closed on drifted version)",
  "src/blackhole/SessionStore.ts + MemoryStore.ts (strict session isolation, recall, compaction)",
  "src/blackhole/BlackholeAdapter.ts (provider seam, builtin default, optional pi-blackhole)",
  "src/blackhole/OpenViking.ts + promotion.ts (durable memory abstraction, evidence-gated promotion, no auto-promotion)",
  "src/blackhole/memoryWorkers.ts (Observer/Reflector/Dropper at P3/P4 via ModelRouter + Scheduler backpressure)",
  "src/blackhole/BlackholeManager.ts (lifecycle orchestration, EventStore-authoritative events)",
  "src/blackhole/telemetry.ts + dashboard.ts (telemetry + dashboard panels)",
  "src/benchmark/Metrics.ts, ExperimentRunner.ts, Plots.ts, Report.ts (A/B metrics, 12 SVG plots, raw data)",
  "Integration: session isolation in EngineeringRuntime.runWorker + blackhole lifecycle in EngineeringRuntime.open",
  "EventStore must remain the authoritative system of record (Blackhole memory is ephemeral working memory only)",
].join("\n");

const CHECKLIST = [
  "strict isolation: no two candidate/reviewer/challenger sessions may share working memory",
  "EventStore/PostgreSQL stays authoritative; Blackhole is never the system of record",
  "no auto-promotion of speculative memory; promotion is evidence-gated and audited",
  "pinned version is not 'latest'; drift fails closed; optional package absence never breaks core (standalone)",
  "background memory workers must never preempt/starve P0-P2 engineering work",
  "disabled behavior is fully backward compatible (no sessions, no events)",
  "benchmark plots/reports/raw data are deterministic and reproducible",
  "test coverage gaps, unverifiable success claims, unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the newly-implemented Blackhole session-memory + benchmark modules (M23) in the pi-engineering-runtime repo. Read the ACTUAL code (do not trust docs or commit messages):

SCOPE:
${SCOPE}

INSPECT FOR:
${CHECKLIST}

Key invariants: (1) EventStore/PostgreSQL remains the authoritative system of record — Blackhole memory is ephemeral working memory and must never be the source of truth; (2) strict memory isolation between tournament candidates/reviewers/challengers; (3) core must remain standalone and must not REQUIRE the optional pi-blackhole package or multiple models; (4) no auto-promotion of speculative candidate memory.

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
