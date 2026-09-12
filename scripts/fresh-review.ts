/**
 * Phase 5 independent fresh review: run a genuinely fresh-context
 * architecture-reviewer worker against the pi-engineering-runtime
 * implementation. The reviewer inherits NO prior reasoning; it receives only
 * the milestone requirements + a hazard checklist and inspects the repo.
 */
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";
import type { WorkerResult } from "../src/core/types.ts";

const repo = "/home/wohlgemuth/IdeaProjects/pi-engineering-runtime";

const REQUIREMENTS = [
  "Standalone Pi extension: MUST work with a normal Pi install in an ordinary git repo.",
  "MUST NOT depend on AutoSpec, InferWeave, GitHub, multiple models, or distributed infra.",
  "Durable Engineering Ledger (event-sourced, replayable), stored on disk under .pi-eng/.",
  "Fresh-context workers (scout/implementer/reviewer/challenger) that inherit NO prior reasoning.",
  "Bounded structured worker results via a terminating worker_result tool (no unbounded responses).",
  "Compact context discipline: bounded task-context packages, large output persisted as artifacts, not in prompts.",
  "Candidate isolation in git worktrees; controlled evidence-gated merge on promotion (INV-003/004/005).",
  "Deterministic verification before promotion; evidence is machine output, never agent claims.",
  "Risk-proportional orchestration; high-risk work runs a clean-room challenger (spec §12.2).",
  "Hypotheses never silently promoted to facts (INV-006).",
].join("\n");

const CHECKLIST = [
  "accidental transcript/context inheritance across workers",
  "fake rather than real fresh-context workers",
  "oversized prompts or unbounded worker responses",
  "mutable shared-state hazards (e.g. per-cwd runtime caches, ledger maps)",
  "incorrect Pi API assumptions",
  "tightly coupled provider interfaces",
  "AutoSpec/InferWeave dependencies leaking into core",
  "shell/process safety issues (command injection, path traversal, untrusted input)",
  "test gaps",
  "false claims of validation",
  "unnecessary dependencies",
  "premature complexity",
].join(", ");

const worker = new PiWorkerExecutor({});
const rt = await EngineeringRuntime.open({ cwd: repo, worker });
const wi = await rt.ledger.createWorkItem("Independent fresh review of pi-engineering-runtime", "high", [repo], { type: "system" });

const task = `Independently review the pi-engineering-runtime implementation in this repository, focusing on src/workers, src/context, src/verify, src/ledger, src/git, src/runtime, src/tools and extensions/. Read files efficiently and report findings; do not re-read the whole repo repeatedly. Keep each finding to severity + file/line + why + fix.

MILESTONE REQUIREMENTS:
${REQUIREMENTS}

INSPECT SPECIFICALLY FOR:
${CHECKLIST}

Use the read/grep/find/ls tools to inspect actual code. Do NOT trust the README or docs; verify against the code. For each material issue, report severity, the exact file/line or symbol, why it matters against the milestone requirements, and a concrete fix. If an area is clean, say so explicitly.`;

let run;
try {
  run = await worker.run({
    role: "architecture-reviewer",
    task,
    tools: ["read", "grep", "find", "ls", "bash"],
    cwd: repo,
    context: "",
    maxContextTokens: 90000,
    timeoutMs: 900_000,
  });
} catch (err) {
  console.error("REVIEW WORKER THREW:", err);
  process.exit(1);
}
if (!run) {
  console.error("REVIEW WORKER RETURNED NOTHING");
  process.exit(1);
}
const r = run.result as WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nCLAIMS (findings):");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nDETAILS:", JSON.stringify(r.details, null, 2));
console.log("USAGE:", JSON.stringify(run.usage));
