import type { WorkerResult } from "../src/core/types.ts";
/**
 * Fresh-context review of the parallel-execution + multi-model-defense milestone:
 * concurrent tournament candidates, the EventStore write serialization, and the
 * optional distinct reviewer worker. A brand-new reviewer session inspects it.
 */
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const MILESTONE = [
  "tournament(goal,{parallel:true}) runs independent candidates concurrently via Promise.all, each in an isolated worktree, merging nothing into main until the winner is selected.",
  "EventStore.append serializes concurrent writes so parallel producers never corrupt or reorder the durable ledger (INV-001/INV-012).",
  "EngineeringRuntime.open({reviewerWorker}) uses the distinct worker for review + clean-room-challenger, falling back to the single worker when omitted (multiple models OPTIONAL, never required).",
  "Parallel execution is opt-in and defaults to sequential; a single serial worker gains nothing.",
].join("\n");

const CHECKLIST = [
  "data races or ordering hazards in the concurrent candidate path",
  "EventStore serialization correctness (loss, corruption, reordering)",
  "reviewerWorker fallback + tool-binding correctness",
  "branch-name uniqueness under concurrent creation",
  "error handling (a concurrent leg rejecting, git worktree failures)",
  "test gaps",
  "unverifiable success claims",
  "unnecessary complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const task = `Independently review the parallel-execution + multi-model-defense milestone in the pi-engineering-runtime repo. Focus on src/ledger/EventStore.ts (append serialization), the tournament parallel path + runTournamentCandidate + createCandidateWorktree branch naming in src/runtime/EngineeringRuntime.ts, and the reviewerWorker plumbing. Read the actual code and tests (test/unit/eventstore.test.ts, the parallel + reviewerWorker tests in test/integration/vertical-slice.test.ts). Do not trust docs or commit messages.

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
console.log("\nUSAGE:", JSON.stringify(run.usage));
