/**
 * The real extension's before_agent_start auto-invoke hook (session review):
 * no mission directive in --print mode, for bare retries, or after the mission
 * tool already reported it cannot run in this session.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import extension from "../../extensions/index.ts";
import { MISSION_UNAVAILABLE_RETRY_TURNS } from "../../src/orchestration/autoInvoke.ts";

const execFileAsync = promisify(execFile);

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

function missionResultWatcher(handlers: Map<string, Handler[]>): Handler {
  const watcher = (handlers.get("tool_result") ?? []).find((f) =>
    f.toString().includes("missionToolReportedUnavailable"),
  );
  assert.ok(watcher, "mission tool_result watcher is registered");
  return watcher;
}

function missionResult(text: string, isError = false) {
  return {
    type: "tool_result",
    toolName: "mission",
    toolCallId: "c",
    input: {},
    isError,
    content: [{ type: "text", text }],
  };
}

test("a BLOCKED mission report mentioning 'unavailable' does not turn auto-invoke off (PR #106 review)", async () => {
  const handlers = loadExtension();
  const hook = autoInvokeHandler(handlers);
  await missionResultWatcher(handlers)(
    missionResult("Mission MSN-1 BLOCKED: current validation evidence is unavailable"),
    { mode: "tui" },
  );
  const injected = (await hook({ type: "before_agent_start", prompt: PROMPT }, { mode: "tui" })) as
    | { message?: { customType?: string } }
    | undefined;
  assert.equal(injected?.message?.customType, "pi-engineering:auto-invoke");
});

test("a later successful mission call re-enables auto-invoke after a transient not-initialized (PR #106 review)", async () => {
  const handlers = loadExtension();
  const hook = autoInvokeHandler(handlers);
  const watcher = missionResultWatcher(handlers);
  await watcher(missionResult("Orchestrator not initialized for this directory."), { mode: "tui" });
  assert.equal(await hook({ type: "before_agent_start", prompt: PROMPT }, { mode: "tui" }), undefined);
  await watcher(missionResult("Mission MSN-9 started for request: add a health endpoint"), { mode: "tui" });
  const injected = (await hook({ type: "before_agent_start", prompt: `${PROMPT} again please` }, { mode: "tui" })) as
    | { message?: { customType?: string } }
    | undefined;
  assert.equal(injected?.message?.customType, "pi-engineering:auto-invoke");
});

test("auto-invoke re-enables after enough user turns since the mission tool reported unavailable (PR #106 re-review)", async () => {
  const handlers = loadExtension();
  const hook = autoInvokeHandler(handlers);
  await missionResultWatcher(handlers)(missionResult("Orchestrator not initialized for this directory."), {
    mode: "tui",
  });
  for (let turn = 1; turn <= MISSION_UNAVAILABLE_RETRY_TURNS; turn++) {
    assert.equal(
      await hook({ type: "before_agent_start", prompt: `${PROMPT} variant ${turn}` }, { mode: "tui" }),
      undefined,
      `turn ${turn} stays quiet`,
    );
  }
  const injected = (await hook({ type: "before_agent_start", prompt: `${PROMPT} once more` }, { mode: "tui" })) as
    | { message?: { customType?: string } }
    | undefined;
  assert.equal(injected?.message?.customType, "pi-engineering:auto-invoke");
});

test("an explicit /mission that reaches an initialized orchestrator re-enables auto-invoke (PR #106 re-review)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-auto-invoke-mission-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
      { cwd: root },
    );
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const handlers = new Map<string, Handler[]>();
    (extension as unknown as (pi: unknown) => void)({
      on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, command),
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
    const hook = autoInvokeHandler(handlers);
    await missionResultWatcher(handlers)(missionResult("Orchestrator not initialized for this directory."), {
      mode: "tui",
    });
    assert.equal(await hook({ type: "before_agent_start", prompt: PROMPT }, { mode: "tui" }), undefined);
    const notices: string[] = [];
    await commands.get("mission")!.handler("resume MSN-does-not-exist", {
      cwd: root,
      mode: "tui",
      signal: undefined,
      model: undefined,
      modelRegistry: undefined,
      getContextUsage: () => undefined,
      isIdle: () => true,
      ui: {
        notify: (text: string) => notices.push(text),
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
        setStatus: () => {},
        setWidget: () => {},
      },
    });
    assert.ok(!notices.some((text) => /not initialized/.test(text)), JSON.stringify(notices));
    const injected = (await hook({ type: "before_agent_start", prompt: `${PROMPT} today` }, { mode: "tui" })) as
      | { message?: { customType?: string } }
      | undefined;
    assert.equal(injected?.message?.customType, "pi-engineering:auto-invoke");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
