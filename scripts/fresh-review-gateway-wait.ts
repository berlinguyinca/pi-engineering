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
  models: {
    files:
      "src/models/gatewayCatalog.ts, src/models/catalogPlan.ts, src/models/modelsConfig.ts, src/models/health.ts, src/models/refresh.ts, and the /refresh-models command in extensions/index.ts. Tests: test/unit/models-catalog.test.ts, test/unit/models-config.test.ts, test/unit/models-health.test.ts, test/integration/models-refresh.test.ts.",
    requirements: [
      "models.json holds the operator's API key. A refresh must never widen its file mode, never lose the key, and never leave a truncated file.",
      "Only providers.<id>.models may be replaced. Every other field, including keys this code does not model, must survive untouched.",
      "The per-request context limit (ctx_per_request) is what bounds a single call; ctx_total is the gateway's aggregate across slots and must never be written as the context window.",
      "A failed fetch, an empty catalogue, or a malformed config must leave the configuration exactly as it was.",
      "Values the gateway does not report (modality, output limits) may be inferred but must be declared as inferred.",
      "A model the gateway stopped listing is kept unless pruning is explicitly requested.",
      "Re-running with nothing to change must not rewrite the file.",
    ].join("\n"),
    inspect: [
      "any path that can lose or expose the API key",
      "non-atomic or partial writes",
      "file mode or ownership changes",
      "silent loss of configuration fields",
      "incorrect context sizes written to disk",
      "unbounded or uncached network calls on hot paths",
      "error handling that destroys configuration on failure",
      "test gaps, especially behaviour no test would catch",
      "unverifiable claims in comments",
    ].join(", "),
  },
  update: {
    files:
      "src/update/versionCheck.ts, src/update/selfUpdate.ts, and the /update command plus session_start check in extensions/index.ts. Tests: test/unit/update-version-check.test.ts, test/unit/update-self-update.test.ts, test/integration/extension-gateway-wiring.test.ts.",
    requirements: [
      "An update must NEVER be applied over uncommitted work, onto a detached HEAD, onto a branch with no upstream, or onto a diverged branch.",
      "Only a strict fast-forward is ever performed; a merge or rebase must never be invented by a background task.",
      "A session must never be delayed by the check: the network call is not awaited on the startup path.",
      "A session must never fail because of the check: no git, no remote, no network, or a non-repository directory are all silence.",
      "After applying an update the operator must be told the running process still has the OLD code loaded.",
      "The check is throttled so session start is not a network round trip every time.",
    ].join("\n"),
    inspect: [
      "any path that can destroy or stash uncommitted work",
      "any path that can produce a merge commit or rebase",
      "blocking or awaited network calls on session start",
      "unhandled rejections escaping into the session",
      "command injection or unsafe argument construction in git invocation",
      "incorrect parsing of git porcelain output",
      "throttle logic that can lock out checking permanently",
      "test gaps, especially behaviour no test would catch",
      "unverifiable claims in comments",
    ].join(", "),
  },
  telemetry: {
    files:
      "src/telemetry/sink.ts, src/telemetry/throttle.ts, src/gateway/admissionNotice.ts, and every call site that emits through them: src/gateway/config.ts, src/workers/PiWorkerExecutor.ts, src/workers/localProviders.ts, src/blackhole/durable.ts, src/runtime/EngineeringRuntime.ts, and the sink installation in extensions/index.ts. Tests: test/unit/telemetry-sink.test.ts, test/unit/telemetry-throttle.test.ts.",
    requirements: [
      "Nothing may write to the terminal directly while a surface is installed. A raw stdout/stderr write lands under the frame pi's TUI drew, does not wrap, and scrolls the screen by a row the TUI does not know about.",
      "With NO surface installed the diagnostic must still reach stderr: a worker, script or CI run has no TUI to corrupt and its stderr is the only record there is.",
      "The sink is process-global mutable state. Installing, uninstalling out of order, or a session tearing down must never leave a later session silent or pointed at a dead UI.",
      "A sink that throws must not fail the work it was reporting on, and must not swallow the line.",
      "Repeat suppression keys on what a notice is ABOUT, not on its wording: the text carries live numbers, so two notices for one condition are different strings.",
      "Human-facing text must carry no JSON and must fit a panelled terminal without wrapping into a wall.",
    ].join("\n"),
    inspect: [
      "any remaining direct stdout/stderr/console write on a path that can run inside a session",
      "the sink leaking across sessions, or a stale sink surviving shutdown",
      "unbounded growth in the throttle's key map",
      "a throttle that can suppress a condition permanently",
      "structured detail reaching a human-facing line",
      "secrets, tokens or paths leaking into a notice",
      "call sites whose severity is wrong: routine news coloured as failure, or a stalled session reported as info",
      "test gaps, especially behaviour no test would catch",
      "unverifiable claims in comments",
    ].join(", "),
  },
  surface: {
    files:
      "src/status/ and src/panel/, plus their tests. Pay particular attention to the newest work: src/panel/rowPaint.ts (colour), src/panel/gutter.ts, src/panel/highlight.ts, and the render pipeline in src/panel/PanelComponent.ts and src/panel/PanelController.ts.",
    requirements: [
      "The status bar shows the active model, the current task, and why the runtime is waiting, including a spinner and queue position during gateway backpressure.",
      "Rendering must never run git or network calls.",
      "The panel is a read model: it must never invent facts about the session.",
      "Generated narrative text must never be recorded as machine evidence.",
      "Every line returned by render(width) is at most `width` VISIBLE columns. Colour must never change the text: escape sequences cost no columns, and a painter that inserted or dropped a visible character corrupts the frame.",
      "Text is truncated BEFORE it is painted. Truncating painted text cuts an escape sequence in half and stains the rest of the frame with whatever colour happened to be open.",
      "Colours come from the operator's theme by semantic name. A hardcoded colour is wrong the moment they switch to a light theme.",
      "The panel is registered nonCapturing and must never take the keyboard: an always-on panel that captures input makes pi accept no typing at all.",
    ].join("\n"),
    inspect: [
      "render-path work that blocks or does IO",
      "state that goes stale without invalidation",
      "subscription and timer leaks across sessions",
      "agent-authored text presented as a record",
      "any render path that can exceed the width contract, especially where colour and truncation meet",
      "a theme call that can throw into pi's render loop",
      "background escapes that are not re-armed after a reset, or never closed",
      "overlay geometry that leaves a gutter the transcript beneath can show through",
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
  // Generous on purpose: under gateway saturation a reviewer spends most of its
  // wall clock waiting out advertised 30s holds rather than thinking, and a
  // review killed mid-flight yields nothing at all.
  timeoutMs: Number(process.env.PI_REVIEW_TIMEOUT_MS ?? 2_700_000),
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
