#!/usr/bin/env node
/**
 * Fresh-context review of the pi-engineering repo at current HEAD, used to
 * produce genuine `fresh_review` evidence for the release gate. A brand-new
 * architecture-reviewer session inspects real code excerpts with no prior
 * reasoning and NO file-reading (bounded, so it cannot blow the context budget
 * by re-reading the repo). Requires a live model/gateway. Excluded from CI.
 *
 *   node scripts/fresh-review-pi-engineering.ts
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = join(homedir(), "IdeaProjects", "pi-engineering");

/** { file, from, to } inclusive line ranges of the code to review. */
const EXCERPTS: Array<{ file: string; from: number; to: number }> = [
  { file: "src/orchestration/orchestrator.ts", from: 2690, to: 2760 },
  { file: "src/orchestration/scheduler.ts", from: 420, to: 430 },
  { file: "src/orchestration/scheduler.ts", from: 545, to: 710 },
  { file: "src/plannerWorker/executor.ts", from: 1395, to: 1425 },
  { file: "src/orchestration/realBackends.ts", from: 100, to: 125 },
  { file: "src/orchestration/realBackends.ts", from: 350, to: 380 },
  { file: "src/orchestration/realBackends.ts", from: 430, to: 460 },
  { file: "src/orchestration/realBackends.ts", from: 455, to: 485 },
  { file: "src/orchestration/realBackends.ts", from: 695, to: 770 },
  { file: "src/capability/router.ts", from: 160, to: 195 },
  { file: "src/runtime/modelRouting.ts", from: 104, to: 140 },
  { file: "src/workers/PiWorkerExecutor.ts", from: 405, to: 420 },
  { file: "src/runtime/herdr/ensureHerdr.ts", from: 35, to: 50 },
];

async function buildExcerpt(): Promise<string> {
  const parts: string[] = [];
  for (const e of EXCERPTS) {
    const raw = await readFile(join(repo, e.file), "utf8");
    const lines = raw.split("\n");
    const slice = lines.slice(e.from - 1, e.to).map((l, i) => `${e.from + i}: ${l}`);
    parts.push(`\n===== ${e.file} (lines ${e.from}-${e.to}) =====\n${slice.join("\n")}`);
  }
  return parts.join("\n");
}

const QUESTIONS = `Focus ONLY on these questions; verify each against the code excerpts provided. Do not speculate about code you cannot see.

(a) orchestrator.ts runSingleTask catch path: when an errored execution is SUPERSEDED (task.assigned_execution_id no longer equals the errored execution's id), does the code avoid failing the task its successor is settling (guard: status RUNNING && !superseded)? Can a task be stranded non-terminal, or double-transitioned (SUCCEEDED->FAILED)? Is the real exception surfaced into failure_reason instead of swallowed?
(b) scheduler.ts taskAlreadyTerminal (lines 423-426): does guarding terminal transitions (SUCCEEDED/FAILED/CANCELED/BLOCKED/SKIPPED) at the ~8 call sites prevent illegal transitions AND still let a failure thrown before RUNNING settle the task FAILED (not strand it READY)?
(c) plannerWorker/executor.ts persist (1395-1425): is state.json written to a sibling temp file then renamed (atomic on POSIX) so a mid-write crash cannot truncate it?
(d) realBackends.ts review evidence (695-770): model/provider come from takeover.route via withModel / modelRoute. If a host has NO model config (empty role router), routeModel returns undefined -> modelRoute is undefined -> evidence carries model:"" / provider:"" (malformed). Is that a real hazard for the missionStore review-evidence validation? Is outputValid gated on !!modelRoute?
(e) realBackends.ts capacity (455-485): the takeover plan routes to a replacement model (exclude tried + replacement:true). Is capacity exhaustion treated as transient (not marking the model unavailable long-term)?
(f) capability/router.ts (160-195): does select() exclude already-tried models (role_policy) so a capacity-takeover can move to a comparable model, while account-wide refusals/operator pins are not force-switched?
(g) herdr/ensureHerdr.ts (35-50): is binary detection injectable (opts.detect) so tests are hermetic (not depending on the host having herdr)?

Output EXACTLY this format in your final message:
SEVERITY: critical|high|medium|low|info
FILE/LINE:
WHY (against the CI-green/release-gate goals):
FIX:
...repeat per finding...
FINAL LINE: CLEAN AREAS: <list of (a)-(g) you explicitly verified clean>
If no material issues: NO MATERIAL ISSUES FOUND.`;

const excerpt = await buildExcerpt();
const context = `You are a fresh-context architecture reviewer. Below are real code excerpts from the pi-engineering repo (file + line numbers). Review them against the questions. You have NO file-reading tools; base findings ONLY on these excerpts. Do not pad or invent findings — only report material, verified issues.

${QUESTIONS}

${excerpt}`;

const worker = new PiWorkerExecutor({});
let run;
try {
  run = await worker.run({
    role: "architecture-reviewer",
    task: "Review the provided code excerpts against the questions and output findings in the required format.",
    tools: [],
    cwd: repo,
    context,
    // The reviewer produces a prose findings report; a 30k cap is exceeded by
    // a verbose-but-finished run (4 turns, ~19k output). The model's real
    // window is far larger, so allow headroom for the report to complete.
    maxContextTokens: 80_000,
    timeoutMs: 1_800_000,
    // Force the flash_next model that is actually served by the gateway (16
    // slots, warm) rather than the engineering.yaml pin (q4, not deployed) or
    // the congested deepseek_v4-flash lane.
    modelOverride: {
      provider: "metabolomics",
      id: "qwen3.8-flash_next-modality-vision-quant-mxfp4_fp8_gptq",
    },
  });
} catch (err) {
  console.error("REVIEW WORKER THREW:", err);
  process.exit(1);
}
if (!run) {
  console.error("REVIEW WORKER RETURNED NOTHING");
  process.exit(1);
}
const r = run.result as import("../src/core/types.ts").WorkerResult;
console.log("REVIEW STATUS:", r.status);
console.log("SUMMARY:", r.summary);
console.log("\nCLAIMS (findings):");
for (const c of r.claims) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
