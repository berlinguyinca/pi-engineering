/**
 * Real-model dogfood of the parallel tournament path (spec §12.1): run N
 * independent candidates concurrently against a fresh fixture, with the real
 * PiWorkerExecutor and real git worktrees, and confirm the winner is promoted
 * with no leftover branches.
 *
 * Usage: node scripts/dogfood-parallel.ts <repo> <goal> [n] [--parallel]
 */
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const cwd = process.argv[2];
const goal =
  process.argv[3] ??
  "Add a clamp(value, min, max) function to src/math.js that clamps value into [min, max], and export it from src/index.js, with a passing test in test/math.test.js.";
const n = Number(process.argv[4] ?? 2);
const parallel = process.argv.includes("--parallel") || process.argv[5] === "--parallel";
if (!cwd) {
  console.error("usage: node scripts/dogfood-parallel.ts <repo> <goal> [n] [--parallel]");
  process.exit(2);
}

const worker = new PiWorkerExecutor({});
const rt = await EngineeringRuntime.open({ cwd, worker });

const t0 = Date.now();
const report = await rt.tournament(goal, { n, parallel });
const sec = ((Date.now() - t0) / 1000).toFixed(1);

console.log("\n===== PARALLEL TOURNAMENT =====");
console.log(
  `work item ${report.work_item.id} [${report.work_item.status}] risk=${report.risk} outcome=${report.outcome} (${sec}s, parallel=${parallel})`,
);
for (const e of report.entries) {
  console.log(
    `  ${e.candidate.id} [${e.candidate.status}] files=${e.candidate.changed_files?.length ?? 0} findings=${e.findings.length} reviewed=${e.reviewCompleted} winner=${e.winner}`,
  );
}
const winner = report.entries.find((e) => e.winner);
console.log(`winner: ${winner?.candidate.id ?? "none"}`);

const t = rt.telemetry;
console.log("\n--- telemetry ---");
console.log("  workers by role:", JSON.stringify(t.workers));
console.log("  tool calls (workers):", t.toolCalls);
console.log("  blocked/failed workers:", t.blockedOrFailedWorkers);
console.log("  max worker context tokens:", t.contextTokens);

console.log("\n--- ledger ---");
console.log("  work items:", rt.ledger.listWorkItems().length);
console.log("  candidates:", rt.ledger.listCandidates().length);

console.log(`\nDOGFOOD PARALLEL OUTCOME: ${report.outcome}`);
