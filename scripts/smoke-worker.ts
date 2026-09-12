/**
 * Smoke test for real fresh-context worker execution against a configured model.
 *
 * Spawns a real Pi SDK session (no interactive extension) with a role prompt and
 * restricted tools, and asks it to return a bounded structured result via the
 * `worker_result` tool. Proves the production worker path works end to end.
 *
 * Usage: node scripts/smoke-worker.ts [cwd]
 */
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const cwd = process.argv[2] ?? process.cwd();
const worker = new PiWorkerExecutor({});
const rt = await EngineeringRuntime.open({ cwd, worker });

console.log(`Repo root: ${rt.git?.root ?? "(none)"}`);
const wi = await rt.ledger.createWorkItem("Smoke test: inspect repo", "low", [cwd], { type: "system" });

const req = {
  role: "scout" as const,
  task: "Inspect this repository and report a one-sentence summary of what it contains, plus the path of the main source file.",
  tools: ["read", "grep", "find", "ls"],
  cwd,
  context: "",
  timeoutMs: 240_000,
};
console.log("Running real fresh-context scout worker...");
const run = await worker.run(req);
console.log("STATUS:", run.result.status);
console.log("SUMMARY:", run.result.summary.slice(0, 500));
console.log("USAGE:", JSON.stringify(run.usage, null, 2));
if (run.result.status !== "completed") {
  console.error("ERROR:", run.error);
  process.exit(1);
}
console.log("SMOKE OK");
