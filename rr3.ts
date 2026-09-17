import { PiWorkerExecutor } from "./src/workers/PiWorkerExecutor.ts";
const repo = process.cwd();
const task = `Review src/orchestration/orchestrator.ts and src/orchestration/completionGate.ts in this repo. Read both files fully.

Report as RESOLVED or OPEN, with file:line:
1. Can a mission reach COMPLETE without the gates its policy required?
2. Is the repair loop bounded, and can resolveFinding hide a live blocking defect?
3. Any state-machine, null, or error-handling bug.

Label each defect critical|high|medium|low. Be concise.`;
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
