/**
 * C1 live-run proof (spec Unit C1, issue #350).
 *
 * A real session model switch under context pressure transfers via a bounded
 * handoff with ZERO native-compaction entries, and persists the committed
 * handoff artifact. This loads the REAL extension (`extensions/index.ts`) and
 * drives the exact `model_select` handler a live session runs, with a real
 * session branch and real context usage, then reads the ACTUAL on-disk
 * transition log and handoff artifact the handler wrote.
 *
 * Gate: this is the live-run evidence C1 requires before merge. It asserts
 * the transition log records `context: "handoff"` and contains NO
 * `context: "compact"` entry.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const SMALL = {
  provider: "metabolomics",
  id: "small-window-16k",
  contextWindow: 16_000,
  input: ["text"],
};
const BIG = {
  provider: "metabolomics",
  id: "big-context-262k",
  contextWindow: 262_144,
  input: ["text"],
};

const branch = [
  { type: "message", message: { role: "user", content: "Fix add so it returns the sum of its arguments" } },
  { type: "message", message: { role: "assistant", content: "I will edit src/add.js and add a test." } },
  { type: "message", message: { role: "user", content: "Also make it handle negative numbers" } },
];

test("C1 live run: a model switch under context pressure transfers via handoff with zero compaction", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "c1-live-"));
  try {
    const handlers = new Map<string, Handler[]>();
    const notices: string[] = [];
    const ctx = {
      cwd: repoRoot,
      mode: "tui",
      hasUI: false,
      signal: undefined,
      model: BIG,
      getContextUsage: () => ({ tokens: 15_000 }), // just over the 16k window + reserve
      isIdle: () => true,
      isProjectTrusted: () => false,
      modelRegistry: {
        getProvider: () => undefined,
        getApiKeyAndHeaders: async () => undefined,
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getSessionId: () => "sess-live-1",
        getBranch: () => branch,
      },
      ui: {
        notify: (message: string) => notices.push(message),
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
      },
    };
    const fire = async (name: string, event: unknown) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, ctx);
      }
    };
    const extension = (await import("../../extensions/index.ts")).default;
    (extension as unknown as (api: unknown) => void)({
      on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: () => {},
      registerTool: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerEntryRenderer: () => {},
      registerProvider: () => {},
      setModel: async () => true,
      events: { on: () => {}, emit: () => {} },
    });

    // The operator, watching the session near its window, switches to a
    // smaller-window model.
    await fire("model_select", {
      type: "model_select",
      model: SMALL,
      previousModel: BIG,
      source: "set",
    });

    // Read the ACTUAL transition log the handler wrote on disk.
    const logPath = join(repoRoot, ".pi-eng", "planner-worker", "session-transitions.jsonl");
    const log = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    const parsed = log.map((line) => JSON.parse(line) as { context: string; to: string });
    const contexts = parsed.map((entry) => entry.context);

    assert.ok(parsed.length > 0, "a MODEL_TRANSITION was recorded");
    assert.ok(contexts.includes("handoff"), `the switch must cross via handoff, got contexts: ${contexts.join(", ")}`);
    assert.ok(
      !contexts.includes("compact"),
      `the switch must have ZERO compaction entries, got contexts: ${contexts.join(", ")}`,
    );
    assert.equal(parsed.at(-1)!.to, `${SMALL.provider}/${SMALL.id}`);

    // The committed handoff artifact must be persisted durably.
    const handoffDir = join(repoRoot, ".pi-eng", "planner-worker");
    const files = await readdir(handoffDir);
    assert.ok(
      files.includes("session-handoffs.jsonl"),
      `the handoff artifact must be persisted, got: ${files.join(", ")}`,
    );
    const artifactLine = (await readFile(join(handoffDir, "session-handoffs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(-1)!;
    const artifact = JSON.parse(artifactLine) as { session: string; token_estimate: number };
    assert.equal(artifact.session, "session:sess-live-1");
    assert.ok(artifact.token_estimate > 0);

    // The operator-facing notice must say no compaction happened.
    assert.ok(
      notices.some((n) => /no compaction/.test(n)),
      `expected a 'no compaction' notice, got: ${notices.join("\n")}`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
