#!/usr/bin/env node
/**
 * Fresh-context review of the verifiable-roadmap-completion milestone (Roadmap
 * 1.0). A brand-new reviewer session inspects the roadmap engine with no prior
 * reasoning. Excluded from CI (requires a live model).
 *
 *   node scripts/fresh-review-roadmap.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const MILESTONE = [
  "Completion is DERIVED from evidence (unit/integration/typecheck/lint/package_load/roadmap_test) + dependencies + freshness, never declared by a model.",
  "Milestone states: NOT_STARTED/IN_PROGRESS/IMPLEMENTED/VERIFIED/NEEDS_REVERIFICATION/BLOCKED/DEFERRED; impact-based invalidation via git pathspec (changedPathsSince).",
  "Roadmap 1.0 YAML schema validation (unique ids, dep cycles, required-cannot-be-deferred, unknown evidence types).",
  "pi-engineering roadmap check CLI with deterministic exit codes 0/1/2/3; /roadmap-status command.",
  "Release gate (all required milestones verified + deterministic gates + fresh_review + dogfood).",
  "Autonomous stop: engineer() refuses to invent new work when the roadmap is complete.",
].join("\n");

const CHECKLIST = [
  "evidence staleness logic (changedPathsSince correctness, path globs, self-invalidation)",
  "dependency evaluation ordering and BLOCKED/NEEDS_REVERIFICATION derivation",
  "schema validation coverage vs. the spec (exit 2 on invalid roadmap)",
  "release-gate completeness (dogfood + fresh_review resolution)",
  "exit-code determinism (0/1/2/3)",
  "autonomous-stop gate correctness",
  "test gaps",
  "unverifiable success claims",
  "unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the verifiable-roadmap-completion milestone (Roadmap 1.0) in the pi-engineering-runtime repo. Read the actual code: src/roadmap/{types,schema,evidence,checks,evaluate,releaseGate,RoadmapEngine,cli}.ts, src/git/GitRepo.ts changedPathsSince, the autonomous-stop gate in src/runtime/EngineeringRuntime.ts engineer(), docs/roadmap/roadmap.yaml, and the tests test/unit/roadmap-*.test.ts + test/integration/roadmap*.test.ts. Do not trust docs or commit messages.

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
  maxContextTokens: 130000,
  timeoutMs: 900_000,
});
const r = run.result as WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nFINDINGS:");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
