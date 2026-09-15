#!/usr/bin/env node
/**
 * Fresh-context review of the gateway-wait change: a brand-new reviewer
 * session, no inherited reasoning, reads the actual code and tests.
 *
 * Scope is one area per invocation so a reviewer's context stays small enough
 * to actually read the files rather than skim them:
 *
 *   node scripts/fresh-review-gateway-wait.ts gateway
 *   node scripts/fresh-review-gateway-wait.ts transient
 *   node scripts/fresh-review-gateway-wait.ts surface
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = process.cwd();
const area = process.argv[2] ?? "gateway";

const AREAS: Record<string, { files: string; requirements: string; inspect: string }> = {
  gateway: {
    files:
      "src/gateway/streamRetry.ts, src/gateway/installStreamRetry.ts, src/gateway/AdmissionController.ts, src/gateway/signals.ts, and the gateway block in extensions/index.ts. Tests: test/unit/gateway-stream-retry.test.ts, test/unit/gateway-stream-retry-install.test.ts, test/integration/gateway-stream-retry-registry.test.ts, test/unit/gateway-admission.test.ts.",
    requirements: [
      "A saturated model gateway must never fail the interactive turn. Waiting is unbounded.",
      "A retry is only legal while NOTHING has reached the transcript: pi's AssistantMessageEventStream completes on the first done/error event and drops later pushes, and re-running a stream that already emitted text would duplicate it.",
      "A gateway-advertised wait (retry_after_ms in the response body) is honoured exactly. A synthesized wait escalates and is capped.",
      "An advertised admission refusal arms the process-wide cooldown; a bare 503 'no worker for model' holds only its own caller, because it speaks for one model.",
      "The turn's abort signal (escape) must end a hold; an unbounded wait with no way out is a wedged session.",
      "Installing the wrapper must never damage the provider: models, auth and login flow must survive.",
    ].join("\n"),
    inspect: [
      "duplicated or lost transcript output across a retry",
      "recursion: the wrapper delegating to itself",
      "the sink being ended twice, or never",
      "abort/cancellation leaks and unresolved promises",
      "unbounded memory or timer growth across many retries",
      "the escalation ladder resetting or growing when it should not",
      "error paths that throw into pi's render loop instead of producing a terminal event",
      "test gaps, especially behaviour no test would catch",
      "unverifiable success claims in comments",
    ].join(", "),
  },
  transient: {
    files:
      "src/guard/transient.ts and src/workers/PiWorkerExecutor.ts, plus test/unit/gateway-transient-boundary.test.ts and the transient tests.",
    requirements: [
      "Two retry layers exist: withTransientRetry (bounded exponential backoff, per worker) and the gateway admission controller (honours an advertised wait, unbounded, process-wide).",
      "A gateway admission refusal that advertises its own wait must be handed to the admission controller, NOT retried exponentially.",
      "Every other transient failure (bare 503, network, timeout, compaction) stays with the transient layer.",
      "The admission slot must be held across the transient retry, not released and re-acquired.",
    ].join("\n"),
    inspect: [
      "errors claimed by the wrong retry layer",
      "an error retried by both layers, multiplying attempts",
      "slot leaks or double release",
      "misclassification of quota/billing exhaustion as retryable",
      "test gaps at the boundary",
    ].join(", "),
  },
  surface: {
    files: "src/status/ and src/panel/, plus their tests.",
    requirements: [
      "The status bar shows the active model, the current task, and why the runtime is waiting, including a spinner and queue position during gateway backpressure.",
      "Rendering must never run git or network calls.",
      "The panel is a read model: it must never invent facts about the session.",
      "Generated narrative text must never be recorded as machine evidence.",
    ].join("\n"),
    inspect: [
      "render-path work that blocks or does IO",
      "state that goes stale without invalidation",
      "subscription and timer leaks across sessions",
      "agent-authored text presented as a record",
      "test gaps",
    ].join(", "),
  },
};

const spec = AREAS[area];
if (!spec) {
  console.error(`unknown area '${area}'. known: ${Object.keys(AREAS).join(", ")}`);
  process.exit(2);
}

const task = `Independently review the ${area} area of the pi-engineering-runtime repo at ${repo}. Read the ACTUAL code and tests. Do not trust comments, commit messages or documentation — verify claims against the code.

FILES:
${spec.files}

REQUIREMENTS THE CODE MUST MEET:
${spec.requirements}

INSPECT FOR:
${spec.inspect}

For every finding report: severity (critical | high | medium | low), file and line, why it is wrong, and the fix. A "critical" finding means data loss, a wedged session, or a silently wrong result. A "high" finding means the stated requirement is not met. If an area is clean, say so explicitly rather than inventing findings.`;

const worker = new PiWorkerExecutor({});
const run = await worker.run({
  role: "architecture-reviewer",
  task,
  tools: ["read", "grep", "find", "ls", "bash"],
  cwd: repo,
  context: "",
  maxContextTokens: 400_000,
  timeoutMs: 1_800_000,
});

const r = run.result as WorkerResult;
console.log(`AREA: ${area}`);
console.log("STATUS:", r.status);
console.log("SUMMARY:", r.summary);
const details = (r.details ?? {}) as { findings?: Array<{ severity?: string; claim?: string; file?: string }> };
const findings = details.findings ?? [];
console.log(`\nFINDINGS (${findings.length}):`);
for (const f of findings) console.log(`- [${f.severity ?? "?"}] ${f.file ?? ""} ${f.claim ?? ""}`);
console.log("\nCLAIMS:");
for (const c of r.claims ?? []) console.log(`- [${c.evidence}] ${c.claim}`);
console.log("\nUSAGE:", JSON.stringify(run.usage));
