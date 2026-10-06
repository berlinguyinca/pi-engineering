/**
 * The real extension's before_agent_start auto-invoke hook (session review):
 * no mission directive in --print mode, for bare retries, or after the mission
 * tool already reported it cannot run in this session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../../extensions/index.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function loadExtension(): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  (extension as unknown as (pi: unknown) => void)({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  });
  return handlers;
}

function autoInvokeHandler(handlers: Map<string, Handler[]>): Handler {
  const h = (handlers.get("before_agent_start") ?? []).find((f) => f.toString().includes("decideAutoInvoke"));
  assert.ok(h, "auto-invoke before_agent_start handler is registered");
  return h;
}

const PROMPT = "Add a health endpoint to the API server";

test("auto-invoke injects in the TUI but not in --print mode or for bare retries", async () => {
  const handlers = loadExtension();
  const hook = autoInvokeHandler(handlers);
  const injected = (await hook({ type: "before_agent_start", prompt: PROMPT }, { mode: "tui" })) as
    | { message?: { customType?: string } }
    | undefined;
  assert.equal(injected?.message?.customType, "pi-engineering:auto-invoke");
  assert.equal(await hook({ type: "before_agent_start", prompt: `${PROMPT} now` }, { mode: "print" }), undefined);
  assert.equal(await hook({ type: "before_agent_start", prompt: "retry" }, { mode: "tui" }), undefined);
});

test("auto-invoke stops after the mission tool reported not initialized", async () => {
  const handlers = loadExtension();
  const hook = autoInvokeHandler(handlers);
  const toolResult = (handlers.get("tool_result") ?? []).find((f) =>
    f.toString().includes("missionToolReportedUnavailable"),
  );
  assert.ok(toolResult, "mission tool_result watcher is registered");
  await toolResult(
    {
      type: "tool_result",
      toolName: "mission",
      toolCallId: "c1",
      input: {},
      isError: false,
      content: [{ type: "text", text: "Orchestrator not initialized for this directory." }],
    },
    { mode: "tui" },
  );
  assert.equal(await hook({ type: "before_agent_start", prompt: PROMPT }, { mode: "tui" }), undefined);
});
