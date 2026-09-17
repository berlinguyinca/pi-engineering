import { PiWorkerExecutor } from "./src/workers/PiWorkerExecutor.ts";
const repo = process.cwd();
const task = `Independently review src/orchestration/ in this repo (read orchestrator.ts, completionGate.ts, state.ts, broker.ts fully). A previous review raised findings; verify each is genuinely FIXED in the current code, and hunt for anything remaining.

Verify RESOLVED or still OPEN (file:line):
1. Passive (conversation/research) early-return: can it still complete a mission while policy-required gates are unmet? Can it still throw an illegal transition (e.g. PLANNING -> COMPLETE)?
2. Repair loop: can it loop unboundedly, or throw REPAIRING -> REPAIRING? Can a blocking finding be cleared when the re-review did not actually run?
3. Is security_review satisfiable only by a security-role review?
4. Is git worktree allocation in broker.ts released on success, failure and cancel?
5. Any remaining critical or high correctness bug anywhere in src/orchestration/.

For each: state VERDICT (RESOLVED/OPEN) + severity if open. Be brief and concrete.`;
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
