import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../../extensions/index.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { publishHostMaintenance } from "../../src/runtime/host/maintenance.ts";
import {
  type ControlReply,
  type SessionDescriptor,
  discoverSessions,
  requestSession,
} from "../../src/sessionControl/SessionControl.ts";

/**
 * `status` lists the session's missions, which opens the repository's runtime the first time (git, SQLite, a registry
 * session: seconds when the host is loaded, against a 1.5 s client / 2 s server request budget). The open is shared and
 * keeps running when a request gives up, so ask until it has answered instead of assuming it is ready - a fixed budget
 * made this test a measurement of host load. The deadline only bounds a genuinely stuck open; the fast path is one request.
 */
async function statusWhenReady(session: SessionDescriptor): Promise<ControlReply> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const reply = await requestSession(session, { version: 1, op: "status" }, 10_000);
      if (reply.ok || Date.now() >= deadline) return reply;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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
  const removeHost = publishHostMaintenance({
    describe: async () => ({
      hostCommit: "a".repeat(40),
      commit: "a".repeat(40),
      generation: 1,
      capabilities: ["runtime.describe"],
      pending: false,
    }),
    reload: async () => ({ ok: false, commit: "a".repeat(40), generation: 1 }),
  });
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
    hasUI: true,
    signal: undefined,
    model: undefined,
    modelRegistry: undefined,
    sessionManager: { getSessionId: () => "pi-session-1" },
    getContextUsage: () => undefined,
    isIdle: () => true,
    ui: {
      notify: (text: string) => notices.push(text),
      custom: () => ({ close: () => {} }),
      setStatus: () => {},
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
    const status = await statusWhenReady(sessions[0]!);
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.ok(status.data.runtime?.capabilities.includes("mission.resume.selected-model.v1"));
      assert.equal(status.data.runtime?.interactiveIdle, true);
      assert.equal(status.data.currentTool, "mission");
      assert.equal(status.data.lastToolProgress, "repairing task TSK-1");
    }
    for (const handler of handlers.get("session_before_compact") ?? []) await handler({}, ctx);
    const compacting = await statusWhenReady(sessions[0]!);
    assert.ok(compacting.ok);
    assert.equal(compacting.data.runtime?.interactiveIdle, false);
    for (const handler of handlers.get("session_compact_failed") ?? []) await handler({}, ctx);
    const settled = await statusWhenReady(sessions[0]!);
    assert.ok(settled.ok);
    assert.equal(settled.data.runtime?.interactiveIdle, true);
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
    const headlessCtx = {
      ...nextCtx,
      hasUI: false,
      mode: "print",
      sessionManager: { getSessionId: () => "pi-session-headless" },
      ui: { ...nextCtx.ui, notify: () => {} },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({}, headlessCtx);
    const headless = await discoverSessions(control);
    assert.equal(headless.length, 1);
    const refused = await requestSession(headless[0]!, {
      version: 1,
      op: "note",
      messageId: "33333333-3333-4333-8333-333333333333",
      text: "Nobody can see this",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "notes_unavailable");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, headlessCtx);
    assert.equal((await discoverSessions(control)).length, 0);
  } finally {
    removeHost();
    for (const [key, value] of Object.entries({
      PI_ENGINEERING_CONTROL_DIR: old.directory,
      PI_SELF_UPDATE: old.update,
      PI_PANEL_AUTO_OPEN: old.panel,
      PI_PANEL_NARRATOR: old.narrator,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("housekeeping is deferred past session_start and a shutdown cancels it before any git child starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-housekeeping-dispose-"));
  const keys = ["PI_ENGINEERING_CONTROL_DIR", "PI_SELF_UPDATE", "PI_PANEL_AUTO_OPEN", "PI_PANEL_NARRATOR"] as const;
  const old = Object.fromEntries(
    [...keys, "PI_HOUSEKEEPING_FIRST_RUN_MS", "PI_HOUSEKEEPING_INTERVAL_MS"].map((k) => [k, process.env[k]]),
  );
  process.env.PI_ENGINEERING_CONTROL_DIR = join(root, "control");
  process.env.PI_SELF_UPDATE = "0";
  process.env.PI_PANEL_AUTO_OPEN = "0";
  process.env.PI_PANEL_NARRATOR = "0";
  // A logging wrapper around the real git records spawns tagged by the sweep
  // (other session-start git use is not housekeeping and may race), so "no git
  // child was started" is observable rather than inferred from handles.
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--allow-empty", "-q", "-m", "init"], {
    cwd: root,
  });
  const spawnLog = join(root, "git-spawns.log");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin", "git"),
    `#!/bin/sh\n[ -n "$PI_HOUSEKEEPING_SWEEP" ] && echo "sweep $@" >> '${spawnLog}'\nexec '${realGit}' "$@"\n`,
    {
      mode: 0o755,
    },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${oldPath}`;
  process.env.PI_HOUSEKEEPING_FIRST_RUN_MS = "60000";
  process.env.PI_HOUSEKEEPING_INTERVAL_MS = "150";
  const handlers = new Map<string, Handler[]>();
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
    hasUI: true,
    sessionManager: { getSessionId: () => "hk-session" },
    getContextUsage: () => undefined,
    isIdle: () => true,
    ui: {
      notify: () => {},
      custom: () => ({ close: () => {} }),
      setStatus: () => {},
      setFooter: () => {},
      onTerminalInput: () => () => {},
    },
  };
  // What a surviving housekeeping timer DOES is call housekeep(), whose first step opens the repository's runtime. Count
  // opens that begin after shutdown has returned. (Counting process.getActiveResourcesInfo() "Timeout" entries before and
  // after cannot see it - housekeeping's timers are unref'd, which that API does not list - and it did count unrelated
  // ref'd timers of the runtime the session's own start-up opens, which under load is still finishing: the old flake.)
  const originalOpen = EngineeringRuntime.open;
  let shutdownReturned = false;
  let opensAfterShutdown = 0;
  EngineeringRuntime.open = ((...args: Parameters<typeof EngineeringRuntime.open>) => {
    if (shutdownReturned) opensAfterShutdown++;
    return originalOpen.apply(EngineeringRuntime, args);
  }) as typeof EngineeringRuntime.open;
  try {
    extension(pi as never);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    shutdownReturned = true;
    // Past both the first-run delay and several intervals: nothing may fire.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(opensAfterShutdown, 0, "no housekeeping tick ran after shutdown (it would have reopened the runtime)");
    assert.equal(
      (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8") : "").includes("sweep "),
      false,
      "housekeeping sweep started no worktree discovery before or after shutdown",
    );
  } finally {
    EngineeringRuntime.open = originalOpen;
    process.env.PATH = oldPath;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
