/**
 * C1 live-run evidence (issue #350, epic #345 human gate).
 *
 * Runs a REAL pi AgentSession (SDK mode) with the plannerWorker extension
 * loaded from the project's `.pi/extensions/` directory — the same loading
 * path an operator uses. It seeds the live session with ~40k tokens of real
 * session content, then performs a REAL model switch
 * (`session.setModel` → pi's `model_select` event → the C1 handler in
 * `extension.ts`). We then verify the gate's acceptance criteria:
 *
 *   1. `.pi-eng/planner-worker/session-transitions.jsonl` contains exactly
 *      ONE entry with `context: "handoff"`,
 *   2. `.pi-eng/planner-worker/session-handoffs.jsonl` contains the
 *      committed HandoffArtifact (latest user ask as the summary),
 *   3. the session file contains ZERO `compaction` entries — i.e. the
 *      switch crossed the boundary via the handoff with no
 *      `ctx.compact()` (selective_compaction never fired).
 *
 * This historical artifact-only check does not prove request transfer. Use
 * test/integration/session-handoff-request.test.ts for the deterministic real
 * transport proof, and c1-request-handoff-evidence.ts for an actual LLM proof.
 *
 * No LLM calls are made: the provider is a local stub that is never
 * requested; the context pressure comes from real session content, and the
 * context estimate is pi's own `getContextUsage()` over that content.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.argv[2] ?? "/tmp/c1-wt";

// ── 1. isolated project + agent dirs ────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), "c1-evidence-"));
const projectDir = join(root, "project");
const agentDir = join(root, "agentdir");
await mkdir(join(projectDir, ".pi", "extensions"), { recursive: true });
await mkdir(agentDir, { recursive: true });

// The extension under test — loaded by pi exactly like an operator's extension.
await writeFile(
  join(projectDir, ".pi", "extensions", "c1-evidence.ts"),
  `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlannerWorker } from "${REPO_ROOT}/src/plannerWorker/extension.ts";

export default function (pi: ExtensionAPI) {
  registerPlannerWorker(pi, {
    host: async (ctx) => ({ repoRoot: ctx.cwd, worker: null }) as never,
  });
}
`,
);

// Two models on a local stub provider: a 200k-window model and a 32k-window
// model. The provider is never requested (no LLM calls in this evidence run).
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
await writeFile(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        c1stub: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "c1-evidence-stub",
          models: [
            {
              id: "big",
              name: "C1 Big (200k)",
              input: ["text"],
              contextWindow: 200_000,
              maxTokens: 8_192,
              cost: zeroCost,
            },
            {
              id: "small",
              name: "C1 Small (32k)",
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 4_096,
              cost: zeroCost,
            },
          ],
        },
      },
    },
    null,
    2,
  ),
);

// ── 2. real session, real extension loading ─────────────────────────────────

const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
const result = await createAgentSession({ cwd: projectDir, agentDir, noTools: "all" });
const session = result.session;
const sessionFile = session.sessionManager.getSessionFile();
console.log(`session file: ${sessionFile}`);
console.log(`initial model: ${session.model?.provider}/${session.model?.id} (window ${session.model?.contextWindow})`);

// ── 3. seed ~40k tokens of real session content ─────────────────────────────

const filler = `Mission context: the gateway PR adds a /health endpoint behind the admission contract; decisions: keep the refusal guard on the terminal path, share the transient classifier with ${"the resilience layer, and gate merges on verify plus GitGuardian. ".repeat(200)}`; // one chunk
const latestAsk = "Now also add metrics for the health endpoint.";

// Seed adaptively until pi's own estimate reports > 40k tokens (well past the
// 32k target window + 4k reserve — genuine context pressure at the switch).
let seededChars = 0;
for (let i = 0; i < 30; i++) {
  session.sessionManager.appendMessage({ role: "user", content: filler } as never);
  seededChars += filler.length;
  const u = session.getContextUsage();
  if ((u?.tokens ?? 0) > 40_000) break;
}
session.sessionManager.appendMessage({ role: "user", content: latestAsk } as never);

const usage = session.getContextUsage();
console.log(`seeded ~${(seededChars / 1000).toFixed(0)}k chars of real session content`);
console.log(
  `context before switch: ${usage?.tokens} tokens / window ${usage?.contextWindow} (${usage?.percent?.toFixed(1)}%)`,
);
if (!usage || usage.tokens === null) throw new Error("expected a real context estimate");
if (usage.tokens <= 32_000 + 4_096) throw new Error(`context pressure insufficient: ${usage.tokens} tokens`);

const small = session.modelRuntime.getModel("c1stub", "small");
if (!small) throw new Error("small model not found in runtime");

// ── 4. the live model switch (fires model_select → C1 handler) ──────────────

await session.setModel(small);
console.log(
  `model after switch:  ${session.model?.provider}/${session.model?.id} (window ${session.model?.contextWindow})`,
);

// ── 5. verify the gate's acceptance criteria ────────────────────────────────

const pwDir = join(projectDir, ".pi-eng", "planner-worker");
const transitionsRaw = await readFile(join(pwDir, "session-transitions.jsonl"), "utf8").catch(() => "");
const transitions = transitionsRaw
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const handoffsRaw = await readFile(join(pwDir, "session-handoffs.jsonl"), "utf8").catch(() => "");
const handoffs = handoffsRaw
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// The live in-memory session branch is the authoritative state (pi persists
// the session file at the first assistant response; this evidence session
// has none, so the file may not exist yet). Count entry types for the record.
const sessionEntries = session.sessionManager.getEntries();
const entryCounts: Record<string, number> = {};
for (const e of sessionEntries) entryCounts[e.type] = (entryCounts[e.type] ?? 0) + 1;
const compactionEntries = sessionEntries.filter((e) => e.type === "compaction");
let sessionFileState: string;
try {
  await readFile(sessionFile, "utf8");
  sessionFileState = "persisted";
} catch {
  sessionFileState = "not yet persisted (no assistant response — pi's persistence guard)";
}

const checks: Array<[string, boolean, string]> = [
  ["exactly ONE transition entry", transitions.length === 1, `got ${transitions.length}`],
  [
    'transition entry has context: "handoff"',
    transitions[0]?.context === "handoff",
    `got ${JSON.stringify(transitions[0]?.context)}`,
  ],
  [
    "entry reason marks the handoff",
    /handoff/.test(transitions[0]?.reason ?? ""),
    `got ${JSON.stringify(transitions[0]?.reason)}`,
  ],
  ["exactly ONE persisted handoff", handoffs.length === 1, `got ${handoffs.length}`],
  [
    "handoff artifact is committed and bounded",
    (handoffs[0]?.artifact?.token_estimate ?? 0) > 0,
    `token_estimate ${handoffs[0]?.artifact?.token_estimate}`,
  ],
  [
    "handoff summary = latest user ask",
    handoffs[0]?.artifact?.mission_summary === latestAsk,
    `got ${JSON.stringify(handoffs[0]?.artifact?.mission_summary)}`,
  ],
  ["ZERO compaction entries in the session", compactionEntries.length === 0, `got ${compactionEntries.length}`],
];

let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

console.log("\n── evidence artifacts ─────────────────────────────────────────");
console.log("session-transitions.jsonl:");
console.log(transitionsRaw.trimEnd());
console.log("session-handoffs.jsonl (truncated artifact):");
for (const h of handoffs) {
  console.log(
    JSON.stringify(
      {
        at: h.at,
        session: h.session,
        token_estimate: h.token_estimate,
        artifact: {
          ...h.artifact,
          architectural_context: h.artifact?.architectural_context?.map((c: string) =>
            c.length > 80 ? `${c.slice(0, 80)}…` : c,
          ),
        },
      },
      null,
      2,
    ),
  );
}
console.log(`session entry types (live branch): ${JSON.stringify(entryCounts)}`);
console.log(`compaction entries in live session: ${compactionEntries.length}`);
console.log(`session file: ${sessionFileState}`);
console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} (project dir: ${projectDir})`);
process.exit(failed === 0 ? 0 : 1);
