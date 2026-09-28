import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../../extensions/index.ts";
import { discoverSessions, requestSession } from "../../src/sessionControl/SessionControl.ts";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

test("extension publishes one live session, tool progress, UI-only note and lifecycle cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-extension-control-"));
  const control = join(root, "control");
  const old = {
    directory: process.env.PI_ENGINEERING_CONTROL_DIR,
    update: process.env.PI_SELF_UPDATE,
    panel: process.env.PI_PANEL_AUTO_OPEN,
    narrator: process.env.PI_PANEL_NARRATOR,
  };
  process.env.PI_ENGINEERING_CONTROL_DIR = control;
  process.env.PI_SELF_UPDATE = "0";
  process.env.PI_PANEL_AUTO_OPEN = "0";
  process.env.PI_PANEL_NARRATOR = "0";
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
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
  };
  const ctx = {
    cwd: root,
    mode: "tui",
    signal: undefined,
    model: undefined,
    modelRegistry: undefined,
    sessionManager: { getSessionId: () => "pi-session-1" },
    getContextUsage: () => undefined,
    isIdle: () => true,
    ui: {
      notify: (text: string) => notices.push(text),
      custom: () => ({ close: () => {} }),
      setFooter: () => {},
      onTerminalInput: () => () => {},
    },
  };
  try {
    extension(pi as never);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    const sessions = await discoverSessions(control);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionId, "pi-session-1");
    for (const handler of handlers.get("tool_execution_start") ?? [])
      await handler({ toolName: "mission", toolCallId: "tool-1", args: {} }, ctx);
    for (const handler of handlers.get("tool_execution_update") ?? [])
      await handler(
        {
          toolName: "mission",
          toolCallId: "tool-1",
          args: {},
          partialResult: { content: [{ type: "text", text: "repairing task TSK-1" }] },
        },
        ctx,
      );
    const status = await requestSession(sessions[0]!, { version: 1, op: "status" });
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(status.data.currentTool, "mission");
      assert.equal(status.data.lastToolProgress, "repairing task TSK-1");
    }
    const note = await requestSession(sessions[0]!, {
      version: 1,
      op: "note",
      messageId: "11111111-1111-4111-8111-111111111111",
      text: "Please report progress",
    });
    assert.equal(note.ok, true);
    assert.ok(notices.some((line) => line.includes("Please report progress")));
    const nextNotices: string[] = [];
    const nextCtx = {
      ...ctx,
      sessionManager: { getSessionId: () => "pi-session-2" },
      ui: { ...ctx.ui, notify: (text: string) => nextNotices.push(text) },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({}, nextCtx);
    const next = await discoverSessions(control);
    assert.equal(next.length, 1);
    assert.equal(next[0]!.sessionId, "pi-session-2");
    assert.notEqual(next[0]!.instanceId, sessions[0]!.instanceId);
    const nextNote = await requestSession(next[0]!, {
      version: 1,
      op: "note",
      messageId: "22222222-2222-4222-8222-222222222222",
      text: "New session only",
    });
    assert.equal(nextNote.ok, true);
    assert.ok(nextNotices.some((line) => line.includes("New session only")));
    assert.ok(!notices.some((line) => line.includes("New session only")));
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, nextCtx);
    assert.equal((await discoverSessions(control)).length, 0);
  } finally {
    for (const [key, value] of Object.entries({
      PI_ENGINEERING_CONTROL_DIR: old.directory,
      PI_SELF_UPDATE: old.update,
      PI_PANEL_AUTO_OPEN: old.panel,
      PI_PANEL_NARRATOR: old.narrator,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
