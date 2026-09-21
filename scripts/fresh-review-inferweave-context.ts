#!/usr/bin/env node
/**
 * Fresh-context review of the InferWeave dynamic context integration: a
 * brand-new reviewer session, no inherited reasoning, reads the actual code
 * and tests.
 *
 * Scope is one area so the reviewer's context stays small enough to actually
 * read the files rather than skim them:
 *
 *   node scripts/fresh-review-inferweave-context.ts context
 */
import type { WorkerResult } from "../src/core/types.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

const repo = process.cwd();
const area = process.argv[2] ?? "context";

const AREAS: Record<string, { files: string; requirements: string; inspect: string }> = {
  context: {
    files:
      "src/context/capability.ts, src/context/client.ts, src/context/provider.ts, src/context/usage.ts, the status-bar changes in src/status/state.ts, src/status/layout.ts, src/status/footer.ts, src/status/config.ts, the inferweave block in extensions/index.ts (registerProvider + /iw-context + model-switch guard), and the tests test/unit/context-capability.test.ts, test/unit/context-client.test.ts, test/unit/context-provider.test.ts, test/unit/context-status.test.ts. Also scripts/dogfood-inferweave-context.ts, which runs the client against a real HTTP gateway.",
    requirements: [
      "Pi's contextWindow must come from the gateway's guaranteed routable context, in this precedence: guaranteed_routable_tokens, context_window, max_model_len, an explicit safe local override, fresh last-known-good, conservative 128000 floor. Pi's maxTokens from the advertised output cap.",
      "260000 and 262144 must never appear as a fallback or default window anywhere — they are the old fixed reservation, and the whole point of this work is to stop assuming them.",
      "An expired capability may never expand the window; a stale one may only hold the last known value, marked stale.",
      "One shared client per process: concurrent callers join one in-flight refresh; one caller's abort stops that caller waiting, not the fetch (the fetch dies only when the last waiter leaves).",
      "Refresh honours ETag/304; an unchanged capability costs no document body; a gateway outage degrades to stale-if-error within staleIfErrorSeconds, then the floor.",
      "Local overrides that exceed the gateway's guarantee require the explicit unsafe flag and warn; safe overrides are honoured.",
      "Model switch to a narrower window must demand compaction before dispatch when the session no longer fits, and refuse (not silently dispatch) when the target window cannot hold the reserved output at all. Compaction itself is Pi's native engine — the harness only decides when.",
      "The base URL is the gateway root; the operator may write it with or without a trailing /v1 and both must reach the same real paths: /v1/models and /v1/models/{id}/capabilities, each with /v1 exactly once.",
      "The status bar shows ctx used/window with percent, keeps its existing segments, and drops context before model/throughput on narrow terminals.",
    ].join("\n"),
    inspect: [
      "URL construction: a path built but not served by the gateway (doubled /v1, unsanitised /models)",
      "cancellation races: a shared refresh cancelled by one caller, an unbounded waiter count, a fetch that never dies",
      "stale metadata expanding the window; an expired value being treated as fresh",
      "unsafe capability expansion: an override or a stale document silently widening Pi's window past what the gateway can route",
      "double counting or lost context accounting between the capability client and the status bar",
      "the model-switch guard compacting too late (after dispatch) or refusing a legal switch",
      "footer state leaking across sessions or models",
      "unbounded maps in the client cache or the provider's per-model bookkeeping",
      "test gaps, especially behaviour no test would catch",
      "unverifiable success claims in comments",
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
  maxContextTokens: 200_000,
  // A reviewer that reads ~10 files and their tests needs wall clock; a review
  // killed mid-flight yields nothing at all.
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
