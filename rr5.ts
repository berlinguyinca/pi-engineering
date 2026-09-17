import { PiWorkerExecutor } from "./src/workers/PiWorkerExecutor.ts";
const repo = process.cwd();
const task = `Independently review src/orchestration/ (read orchestrator.ts, broker.ts, scheduler.ts, completionGate.ts). Verify RESOLVED or still OPEN with file:line:

1. Constraint steering (addConstraint): does it cancel THROUGH the broker so the runner is aborted and the worktree released? Can a late runner result overwrite execution CANCELED with SUCCEEDED, or throw an illegal CANCELED -> SUCCEEDED task transition (unhandled rejection)?
2. Is mission-scoped worktree bookkeeping cleaned up at mission end (no accumulation)?
3. Passive early-return: any way to complete with unmet gates or hit an illegal transition?
4. Repair loop: unbounded, or can a blocking finding be cleared without a real re-review?
5. Any remaining CRITICAL or HIGH correctness bug in src/orchestration/.

Be concise. State VERDICT + severity.`;
const w = new PiWorkerExecutor({});
const r = await w.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep"],
  cwd: repo,
  context: "",
  maxContextTokens: 60000,
  timeoutMs: 900000,
});
console.log("STATUS:", r.result.status);
console.log("SUMMARY:", r.result.summary);
for (const c of r.result.claims) console.log(`- [${c.evidence}] ${c.claim}`);
