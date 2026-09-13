/**
 * Fresh-context review of the Context Broker milestone: relevance ranking
 * (rankFiles), relevant-file content slices in assembleContext, and
 * scout-guided required files. A brand-new reviewer session with no inherited
 * reasoning inspects the change.
 */
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";
import type { WorkerResult } from "../src/core/types.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const MILESTONE = [
  "rankFiles() must rank repo files by goal relevance (path matches + distinct goal symbols) and be bounded.",
  "assembleContext() must include content slices of the most relevant files (not just symbol one-liners), within the token budget.",
  "scout() must return the concrete files it identifies (details.relevant_files) and engineer() must feed those as required context to the implementer.",
  "The context package must remain bounded (never exceed targetTokens) and path-traversal safe.",
  "Must stay model-agnostic and not depend on AutoSpec/InferWeave/GitHub.",
].join("\n");

const CHECKLIST = [
  "correctness defects in rankFiles / assembleContext / scout-guided required files",
  "context/token regressions (does relevant-file content blow the budget? is ranking stable?)",
  "path-traversal or shell-injection hazards",
  "stale-cache / shared-state hazards",
  "error-handling gaps",
  "test gaps",
  "unverifiable success claims",
  "unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the Context Broker milestone in the pi-engineering-runtime repo. Focus on src/context/ContextBroker.ts (rankFiles, assembleContext, search, readSlice) and src/runtime/EngineeringRuntime.ts (scout() and the scout-guided context re-assembly in engineer()). Read the actual code and the tests (test/unit/context.test.ts, test/integration/vertical-slice.test.ts). Do not trust docs or commit messages.

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
console.log("\nDETAILS:", JSON.stringify(r.details, null, 2));
console.log("USAGE:", JSON.stringify(run.usage));
