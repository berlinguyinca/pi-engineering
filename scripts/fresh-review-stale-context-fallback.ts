#!/usr/bin/env node
/**
 * Fresh-context review of the stale `ExtensionCommandContext` crash fix: a
 * brand-new reviewer session, no inherited reasoning, reads the actual code and
 * tests.
 *
 * Scope is one area so the reviewer's context stays small enough to actually
 * read the files rather than skim them:
 *
 *   node scripts/fresh-review-stale-context-fallback.ts
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = process.cwd();

const task = `Independently review the stale-context gateway-fallback area of the pi-engineering-runtime repo at ${repo}. Read the ACTUAL code and tests. Do not trust comments, commit messages or documentation — verify claims against the code.

FILES:
src/gateway/fallbackLifecycle.ts (the new plain-data state machine + fresh-ctx fallback execution), the gateway-admission block in extensions/index.ts (installStreamRetry, the onHold/onProgress wiring, applyPendingFallbackWithFreshCtx, the session_start/before_agent_start/model_select/session_shutdown handlers), src/status/footer.ts (refreshGit), and the tests test/unit/gateway-fallback-lifecycle.test.ts plus scripts/dogfood-stale-context-fallback.ts, which drives the real pump + coordinator against a scripted 429 admission gateway.

REQUIREMENTS THE CODE MUST MEET:
1. No session-bound Pi object (ExtensionCommandContext, ExtensionContext, session manager, UI, context-backed registry/getter) may be retained for later asynchronous use. Specifically the variable \`latestCtx\` must be GONE and there must be no equivalent retained Pi context replacing it.
2. A gateway hold callback (onHold) must write only plain durable data (a hold count and a pending flag). It must never read ctx.model, ctx.modelRegistry, ctx.ui, or call pi.setModel.
3. The actual fallback selection + pi.setModel switch must run only from a Pi lifecycle callback (before_agent_start) using the FRESH ctx that callback supplies.
4. An explicit operator model change (model_select) must clear both the pending fallback and the hold count, so a stale fallback intent never switches away from a model the operator just chose.
5. Session shutdown (session_shutdown) must clear the ephemeral fallback state so nothing leaks into the next session.
6. Multiple holds must arm at most ONE pending fallback, and claiming it must be idempotent (only one caller wins) so a burst cannot trigger multiple switches.
7. A pending fallback claimed before any async work must be consumed exactly once; a successful switch resets the hold ledger.
8. The detached fallback promise must be caught, so a fallback failure (e.g. setModel throwing) degrades the feature and logs, rather than escaping as an uncaught exception that terminates Pi.
9. The existing gateway retry / admission semantics must be preserved: 429 admission detection, retry-after handling, the wait, the fallback threshold (3 holds), fallback selection, model-health integration, and operator notification are all still present and functional.
10. FooterController.refreshGit must not propagate a rejecting git.resolve to its detached callers (an unhandled rejection there would terminate Pi).

INSPECT FOR:
- any remaining retained Pi context or a captured ctx dereferenced from an async/retry/detached callback
- onHold or any gateway/retry callback touching session-bound state
- a race where the pending fallback is consumed twice, or armed multiple times, or never cleared
- model_select / session_shutdown failing to reset the coordinator, leaking fallback state across a session boundary
- the detached-promise boundary missing or swallowing the error without logging
- a regression in the gateway retry / admission / fallback-threshold behaviour
- a stale ctx being read, written, or notified during the fallback
- test gaps, especially behaviour no test would catch
- unverifiable success claims in comments

For every finding report: severity (critical | high | medium | low), file and line, why it is wrong, and the fix. A "critical" finding means data loss, a wedged session, a process crash, or a silently wrong result. A "high" finding means the stated requirement is not met. If an area is clean, say so explicitly rather than inventing findings.`;

const worker = new PiWorkerExecutor({});
const run = await worker.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "find", "ls", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 200_000,
  // A reviewer that reads the fallback modules, the extension block, and their
  // tests needs wall clock; a review killed mid-flight yields nothing at all.
  timeoutMs: Number(process.env.PI_REVIEW_TIMEOUT_MS ?? 2_700_000),
});

const r = run.result as WorkerResult;
console.log("AREA: stale-context-fallback");
console.log("STATUS:", r.status);
console.log("SUMMARY:", r.summary);
const details = (r.details ?? {}) as { findings?: Array<{ severity?: string; claim?: string; file?: string }> };
const findings = details.findings ?? [];
console.log(`\nFINDINGS (${findings.length}):`);
for (const f of findings) console.log(`- [${f.severity ?? "?"}] ${f.file ?? ""} ${f.claim ?? ""}`);
console.log("\nCLAIMS:");
for (const c of r.claims ?? []) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
