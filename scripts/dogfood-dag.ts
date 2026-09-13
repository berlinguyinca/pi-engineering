/**
 * Dogfood the Task-DAG path (spec §11): plan a larger goal into ordered tasks
 * with the real model, then execute each task through the engineer pipeline.
 * Usage: node scripts/dogfood-dag.ts <repo> <goal>
 */
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const cwd = process.argv[2];
const goal =
  process.argv[3] ??
  "Add a clamp(value, min, max) function to src/math.js that clamps value into [min, max], then add a round(value, digits) function, and export both from src/index.js with passing tests in test/math.test.js.";
if (!cwd) {
  console.error("usage: node scripts/dogfood-dag.ts <repo> [goal]");
  process.exit(2);
}

const worker = new PiWorkerExecutor({});
const rt = await EngineeringRuntime.open({ cwd, worker });

const t0 = Date.now();
const plan = await rt.plan(goal);
const planSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log("\n===== PLAN =====");
console.log(`plan ${plan.plan_work_item.id} outcome=${plan.outcome} (${planSec}s)`);
for (const t of plan.tasks) {
  console.log(`  ${t.id} [${t.risk}] ${t.title} deps=${t.depends_on.join(",") || "-"}`);
}
if (plan.tasks.length === 0) {
  console.error("PLAN PRODUCED NO TASKS");
  process.exit(1);
}

const t1 = Date.now();
const dag = await rt.executePlan(plan.plan_work_item.id);
const dagSec = ((Date.now() - t1) / 1000).toFixed(1);

console.log("\n===== DAG EXECUTION =====");
console.log(`plan ${dag.plan_work_item.id} status=${dag.plan_work_item.status} outcome=${dag.outcome} (${dagSec}s)`);
for (const t of dag.order) {
  console.log(`  ${t.id} [${t.status}] ${t.title} -> ${t.result_work_item_id ?? "-"}`);
}

const t = rt.telemetry;
const pad = (s: string, n = 26) => String(s).padEnd(n);
console.log("\n--- telemetry ---");
console.log(pad("  tool calls (workers)"), t.toolCalls);
console.log(pad("  blocked/failed workers"), t.blockedOrFailedWorkers);
console.log(pad("  aggregate input tokens"), t.inputTokens);
console.log(pad("  aggregate output tokens"), t.outputTokens);
console.log(pad("  max worker context tokens"), t.contextTokens);
console.log(pad("  aggregate worker turns"), t.turns);

console.log("\n--- ledger ---");
console.log(pad("  tasks"), rt.ledger.listTasks(plan.plan_work_item.id).length);
console.log(pad("  work items"), rt.ledger.listWorkItems().length);
console.log(pad("  findings"), rt.ledger.listEntities("finding").length);
console.log(pad("  decisions"), rt.ledger.listEntities("decision").length);
console.log(pad("  artifacts"), rt.artifacts.list().length);

console.log(`\nDOGFOOD DAG OUTCOME: ${dag.outcome}`);
