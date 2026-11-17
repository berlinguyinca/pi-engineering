/**
 * A mission belongs to the runtime that created it, not to whichever runtime the
 * session is bound to now. A session launched in a parent directory rebinds to a
 * nested worktree as soon as a tool touches it; the missions the parent runtime
 * owns must stay cancellable (live: 57 + 5 missions answered `unknown mission`).
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import extension, { settleWorkspaceActivity } from "../../extensions/index.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { discoverSessions, requestSession } from "../../src/sessionControl/SessionControl.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeGitRepo } from "../support/childSessions.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> | void };
interface ToolLike {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
}

function loadHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, ToolLike>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, options: Command) => commands.set(name, options),
    registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  };
  (extension as unknown as (api: unknown) => void)(pi);
  return { handlers, commands, tools };
}

function ctxFor(cwd: string, sessionId?: string) {
  const notices: Array<{ text: string; level: string }> = [];
  return {
    notices,
    ctx: {
      cwd,
      hasUI: false,
      mode: "tui",
      signal: undefined,
      model: undefined,
      modelRegistry: undefined,
      getContextUsage: () => undefined,
      isIdle: () => true,
      ui: {
        notify: (text: string, level: string) => notices.push({ text, level }),
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
      },
      sessionManager: { getSessionId: () => sessionId },
    },
  };
}

async function touch(handlers: Map<string, Handler[]>, cwd: string, path: string): Promise<void> {
  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path } }, ctxFor(cwd).ctx);
  }
  await settleWorkspaceActivity();
}

describe("mission commands resolve the runtime that owns the mission", () => {
  const cleanup: string[] = [];
  // A private control directory, as extension-session-control does: the shared
  // default is not guaranteed to exist or be writable on a CI runner.
  const previousControlDir = process.env.PI_ENGINEERING_CONTROL_DIR;
  before(async () => {
    const control = await mkdtemp(join(tmpdir(), "pi-eng-owning-control-"));
    cleanup.push(control);
    process.env.PI_ENGINEERING_CONTROL_DIR = control;
  });
  after(async () => {
    if (previousControlDir === undefined) delete process.env.PI_ENGINEERING_CONTROL_DIR;
    else process.env.PI_ENGINEERING_CONTROL_DIR = previousControlDir;
    for (const dir of cleanup) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  // The control socket is published asynchronously after session_start.
  async function listening(sessionId: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = (await discoverSessions()).find((s) => s.sessionId === sessionId);
      if (found || Date.now() > deadline) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function parentWithMission(prefix: string) {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
    cleanup.push(workspace);
    await makeGitRepo(workspace);
    const alpha = await makeGitRepo(join(workspace, "alpha"));
    const { handlers, commands, tools } = loadHarness();
    // The parent launch opens (and binds to) the parent runtime through the extension.
    await tools.get("ledger_read")!.execute("1", {}, undefined, undefined, ctxFor(workspace).ctx);
    // A second handle on the same store creates a mission the parent runtime owns.
    const writer = await EngineeringRuntime.open({ cwd: workspace, worker: new FakeWorkerExecutor({}) });
    const mission = writer.missionStore!.createMission({
      title: "parent owned",
      goal: "stays cancellable after a rebind",
      user_request: "stays cancellable after a rebind",
      repository: workspace,
      base_ref: await writer.git!.headCommit(),
      risk_profile: "low",
      workflow_class: "engineering",
    });
    // Custody is what makes a runtime the owner (maintenanceOwnedMissionIds).
    await writer.missionOwnership!.acquire(mission.mission_id);
    await writer.missionStore!.flush();
    return { workspace, alpha, handlers, commands, tools, mission, writer };
  }

  it("cancels a mission owned by the parent runtime after the session rebinds to a nested worktree", async () => {
    const { workspace, alpha, handlers, commands, tools, mission, writer } = await parentWithMission("pi-eng-owning-");
    const session = RuntimeSession.current();
    const sessionId = `owning-runtime-${process.pid}`;
    const { ctx, notices } = ctxFor(workspace, sessionId);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    try {
      await touch(handlers, workspace, join(alpha, "README.md"));
      assert.equal(session.binding?.worktreePath, alpha, "session is bound to the nested worktree");

      const control = await listening(sessionId);
      assert.ok(control, "session control is listening");
      const status = await requestSession(control, { version: 1, op: "status" });
      assert.equal(status.ok, true);
      const listed = status.ok ? (status.data as { missions: Array<{ id: string }> }).missions : [];
      assert.ok(
        listed.some((m) => m.id === mission.mission_id),
        "status lists the parent-owned mission",
      );

      await commands.get("mission")!.handler(`cancel ${mission.mission_id}`, ctx);
      assert.doesNotMatch(notices.at(-1)?.text ?? "", /unknown mission/i);
      assert.match(notices.at(-1)?.text ?? "", new RegExp(`${mission.mission_id} .*\\[CANCELED\\]`));
      assert.equal(writer.missionStore!.getMission(mission.mission_id)?.status, "CANCELED");

      // The mission tool resolves the same way.
      const tool = await tools
        .get("mission")!
        .execute("2", { action: "status", missionId: mission.mission_id }, undefined, undefined, ctx);
      assert.match(tool.content[0]!.text, new RegExp(`${mission.mission_id} \\[CANCELED\\]`));
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      await writer.close();
    }
  });

  it("refuses to guess when two open runtimes both own the mission id", async () => {
    const { workspace, alpha, handlers, commands, tools, mission, writer } = await parentWithMission("pi-eng-ambig-");
    const { ctx, notices } = ctxFor(workspace);
    await touch(handlers, workspace, join(alpha, "README.md"));
    const twin = await EngineeringRuntime.open({ cwd: alpha, worker: new FakeWorkerExecutor({}) });
    try {
      twin.missionStore!.createMission({
        mission_id: mission.mission_id,
        title: "same id elsewhere",
        goal: "collides",
        user_request: "collides",
        repository: alpha,
        base_ref: await twin.git!.headCommit(),
        risk_profile: "low",
        workflow_class: "engineering",
      });
      await twin.missionOwnership!.acquire(mission.mission_id);
      await commands.get("mission")!.handler(`cancel ${mission.mission_id}`, ctx);
      assert.match(notices.at(-1)?.text ?? "", /refusing to guess/);
      assert.equal(notices.at(-1)?.level, "error");
      assert.notEqual(writer.missionStore!.getMission(mission.mission_id)?.status, "CANCELED");
      assert.notEqual(twin.missionStore!.getMission(mission.mission_id)?.status, "CANCELED");
      await assert.rejects(
        tools
          .get("mission")!
          .execute("3", { action: "cancel", missionId: mission.mission_id }, undefined, undefined, ctx),
        /refusing to guess/,
      );
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      await twin.close();
      await writer.close();
    }
  });
});
