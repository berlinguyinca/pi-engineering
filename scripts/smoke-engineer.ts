/**
 * Smoke test: run the full adaptive engineering pipeline (/engineer) with the
 * REAL model-backed worker executor against a real repository. Proves the
 * production path: scout -> implement (worktree) -> verify -> review -> promote.
 *
 * Usage: node scripts/smoke-engineer.ts <repo> <goal>
 */
import { EngineeringRuntime } from "../src/runtime/EngineeringRuntime.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const cwd = process.argv[2];
const goal = process.argv[3] ?? "Implement subtract(a, b) returning a - b in src/greet.js";
if (!cwd) {
  console.error("usage: node scripts/smoke-engineer.ts <repo> [goal]");
  process.exit(2);
}

const worker = new PiWorkerExecutor({});
const rt = await EngineeringRuntime.open({ cwd, worker });

const report = await rt.engineer(goal);
console.log("work_item:", report.work_item.id, report.work_item.status, "risk=", report.risk);
console.log("outcome:", report.outcome, "rounds:", report.rounds);
console.log("incumbent:", report.incumbent_candidate?.id ?? "none");
if (report.incumbent_candidate) {
  console.log("  diff head:", (report.incumbent_candidate.diff ?? "").slice(0, 300));
  console.log("  changed files:", report.incumbent_candidate.changed_files.join(", "));
}
console.log("scout:", report.scout_summary?.slice(0, 200));
console.log("review:", report.review_summary?.slice(0, 200));
console.log("evidence:", report.evidence_ids.join(", "));
console.log("verification passed:", report.verification?.passed);
if (report.outcome !== "promoted") {
  console.error("ENGINEER FAILED");
  process.exit(1);
}
console.log("ENGINEER OK");
