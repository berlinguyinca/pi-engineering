import type { WorkerResult } from "../src/core/types.ts";
/**
 * Fresh-context review of the artifact-backed lazy diff-retrieval milestone.
 *
 * A brand-new reviewer session (no inherited reasoning) inspects the milestone
 * change: candidate diff no longer inlined into the reviewer prompt; it is
 * stored as an artifact:// reference and read lazily via artifact_read.
 */
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const MILESTONE = [
  "Candidate diffs must be persisted as lazily-read artifact:// references (artifact-backed large-output handling).",
  "The reviewer prompt must NOT inline the full candidate diff; it should carry a compact preview + the artifact URI and instruct artifact_read.",
  "The full diff must remain fully retrievable on demand (no information loss).",
  "Must preserve: no-promote-without-completed-review (INV-007), review completion gating, and the retry-with-fresh-context path.",
  "Must stay model-agnostic (no provider-specific behavior) and not depend on AutoSpec/InferWeave/GitHub.",
].join("\n");

const CHECKLIST = [
  "correctness defects in the new review()/ensureDiffArtifact() path",
  "information loss (is the full diff really retrievable? what if the artifact is missing or stale?)",
  "context leaks / unbounded output back into the prompt",
  "accidental transcript inheritance",
  "mutable shared-state or stale-cache hazards (e.g. diff_artifact_uri vs candidate.diff divergence)",
  "error-handling gaps (artifact write failures, missing artifact)",
  "test gaps",
  "unverifiable success claims",
  "unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the artifact-backed lazy candidate-diff retrieval milestone in the pi-engineering-runtime repo. Focus on src/runtime/EngineeringRuntime.ts (review(), ensureDiffArtifact(), implementIn()), src/core/types.ts (Candidate.diff_artifact_uri), src/ledger/Ledger.ts, and the regression test in test/integration/vertical-slice.test.ts. Read the actual code; do not trust docs or commit messages. Verify the milestone requirements and inspect specifically for the hazards listed.

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
