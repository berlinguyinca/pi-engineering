#!/usr/bin/env node
/** Fresh-context review of the Pi Engineering orchestration change (spec 00-14). */
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = new URL("..", import.meta.url).pathname;

const task = `Independently review the orchestration implementation in this checkout of pi-engineering-runtime. Read the ACTUAL code — do not trust this prompt's description.

Scope to review:
- src/orchestration/types.ts, state.ts (mission/task lifecycle state machines)
- src/orchestration/policies.ts (gate derivation), intentRouter.ts (Stage A semantic + Stage B deterministic policy)
- src/orchestration/missionStore.ts (event-sourced durable state, restart recovery)
- src/orchestration/broker.ts (ExecutionBroker: backends, cancel/steer, timeouts, git worktree allocation + release)
- src/orchestration/scheduler.ts (DAG, write-domain conflict serialization, retry)
- src/orchestration/completionGate.ts, integrator.ts, realBackends.ts (normalizeFindings, integration merge)
- src/orchestration/orchestrator.ts (facade, post-execution validation/review, bounded repair rounds)
- src/orchestration/missionSnapshot.ts + EngineeringRuntime.publishMissionSnapshot (PI WEB snapshot contract)
- extensions/index.ts: the before_agent_start auto-invocation hook
- src/platform/ControlPlane.ts mission surface

The governing specs are docs/specs/pi-engineering-orchestration/*.md. Check them against the code.

Answer concretely, each item RESOLVED or OPEN/REGRESSED with file+line:
1. Can a mission reach COMPLETE without the gates policy required (validation / independent_review / security_review)? Any bypass path?
2. Can a read-only workflow (investigation/research/conversation) end up mutating the repository? Trace mutates_repo from intent -> plan -> broker.
3. Is git worktree allocation for mutating tasks leak-free (allocated vs released on success, failure, cancel, and on integration)? Any path that leaves a worktree behind or removes one still in use?
4. Is the repair loop in orchestrator bounded? Can a reviewer that keeps re-raising the same defect loop forever, or can optimistic finding closure (resolveFinding) launder a real blocking issue?
5. Does the broker's timeout/cancel actually stop the backend, or just mark state? Any unhandled rejection or unawaited promise?
6. Is restart recovery real (event replay reconstructs state), and can replay double-apply or corrupt state?
7. Auto-invocation hook: can it break a normal turn, fire on slash commands, spam on retries, or throw on a prompt that trips classification? Is the pi.on guard correct?
8. Any secret/path/PII leakage into the PI WEB snapshot or ControlPlane snapshot?
9. normalizeFindings: can a malformed or hostile reviewer payload crash the gate or silently drop a blocking finding?
10. Any correctness bug, race, or spec violation not covered above.

Be concrete and skeptical. Report real defects, not style nits. For each defect label severity: critical | high | medium | low.`;

const w = new PiWorkerExecutor({});
const r = await w.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 200000,
  timeoutMs: 1_500_000,
});
console.log("REVIEW STATUS:", r.result.status);
console.log("SUMMARY:", r.result.summary);
console.log("\nFINDINGS:");
for (const c of r.result.claims) console.log(`- [${c.evidence}] ${c.claim}`);
if (r.result.new_hypotheses.length) {
  console.log("\nHYPOTHESES:");
  for (const h of r.result.new_hypotheses) console.log(`- ${h}`);
}
