/**
 * Phase 4 dogfood runner: run a real engineering task against a realistic
 * fixture project with the real model-backed workers, and report context /
 * autonomy telemetry. Usage: node scripts/dogfood.ts <repo> <goal>
 */
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const cwd = process.argv[2];
const goal = process.argv[3] ?? "Add a clamp(value, min, max) function to src/math.js that clamps value into [min, max], export it from src/index.js, and add a passing test in test/math.test.js";
if (!cwd) {
  console.error("usage: node scripts/dogfood.ts <repo> [goal]");
  process.exit(2);
}

const worker = new PiWorkerExecutor({});
const rt = await EngineeringRuntime.open({ cwd, worker });

const t0 = Date.now();
const report = await rt.engineer(goal);
const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

const t = report.telemetry;
const pad = (s: string, n = 26) => String(s).padEnd(n);
console.log("\n================ DOGFOOD REPORT ================");
console.log(pad("work_item"), report.work_item.id, `[${report.work_item.status}] risk=${report.risk}`);
console.log(pad("outcome"), report.outcome, `(${report.rounds} round(s), ${elapsedSec}s)`);
console.log(pad("incumbent"), report.incumbent_candidate?.id ?? "none");
console.log(pad("changed files"), report.incumbent_candidate?.changed_files.join(", ") ?? "none");
console.log(pad("evidence"), report.evidence_ids.join(", ") || "none");
console.log(pad("verification passed"), String(report.verification?.passed));

console.log("\n--- worker invocations ---");
const roles = Object.keys(t.workers).sort();
if (roles.length) {
  for (const r of roles) console.log(pad(`  ${r}`), t.workers[r]);
} else {
  console.log("  none");
}

console.log("\n--- context/autonomy telemetry ---");
console.log(pad("  tool calls (workers)"), t.toolCalls);
console.log(pad("  verification stages"), t.verifyStages);
console.log(pad("  evidence records"), t.evidence);
console.log(pad("  blocked/failed workers"), t.blockedOrFailedWorkers);
console.log(pad("  aggregate input tokens"), t.inputTokens);
console.log(pad("  aggregate output tokens"), t.outputTokens);
console.log(pad("  max worker context tokens"), t.contextTokens);
console.log(pad("  aggregate worker turns"), t.turns);

console.log("\n--- ledger entities ---");
console.log(pad("  findings"), rt.ledger.listEntities("finding").length);
console.log(pad("  hypotheses"), rt.ledger.listEntities("hypothesis").length);
console.log(pad("  decisions"), rt.ledger.listEntities("decision").length);
console.log(pad("  evidence total"), rt.ledger.listEvidence().length);
console.log(pad("  artifacts"), rt.artifacts.list().length);

console.log("\n--- summaries ---");
if (report.scout_summary) console.log(`scout:   ${report.scout_summary.slice(0, 300)}`);
if (report.challenge_summary) console.log(`challenge: ${report.challenge_summary.slice(0, 300)}`);
if (report.review_summary) console.log(`review:  ${report.review_summary.slice(0, 300)}`);
console.log("\n================ END ================\n");

if (report.outcome !== "promoted") {
  console.error("DOGFOOD FAILED");
  process.exit(1);
}
console.log("DOGFOOD OK");
