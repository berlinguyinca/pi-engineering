import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../../extensions/index.ts";

function load(cwd: string) {
  const commands = new Map<string, any>();
  const hooks = new Map<string, any[]>();
  const sent: any[] = [];
  const statuses: string[] = [];
  const statusMap = new Map<string, string>();
  let footer: { render(width: number): string[] } | undefined;
  extension({
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: () => {},
    on: (name: string, handler: any) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    sendMessage: (message: any) => sent.push(message),
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    hasUI: true,
    mode: "rpc",
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string) => {
        statuses.push(text);
        statusMap.set(key, text);
      },
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender() {} },
          { fg: (_color: string, text: string) => text },
          {
            getExtensionStatuses: () => statusMap,
            onBranchChange: () => () => {},
            getGitBranch: () => null,
            getAvailableProviderCount: () => 0,
          },
        );
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    commands,
    hooks,
    sent,
    statuses,
    ctx,
    footer: () => footer,
    async emit(name: string, event: any = {}) {
      let result = { ...event };
      for (const handler of hooks.get(name) ?? []) {
        const next = await handler(result, ctx);
        if (next) result = { ...result, ...next };
      }
      return result;
    },
  };
}

test("full extension saves through the herdr-memory client and recalls in a fresh chat", async () => {
  // The client owns its own project profile, endpoint, credentials and queue, so
  // the fixture is a working `herdr-memory` and the state that survives a fresh
  // chat is the client's state file - never anything Pi writes.
  const { makeHerdrStub } = await import("../support/herdrMemoryStub.ts");
  const clientDir = await mkdtemp(join(tmpdir(), "everyday-memory-client-"));
  const stub = makeHerdrStub(clientDir, "ok");
  const profile = await mkdtemp(join(tmpdir(), "everyday-memory-"));
  const previous = { ...process.env };
  let second: ReturnType<typeof load> | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = profile;
    process.env.PI_HINDSIGHT_ENABLED = "1";
    process.env.PI_HINDSIGHT_CLI = stub.cli;
    const first = load(profile);
    await first.emit("session_start");
    await first.commands.get("remember").handler("Calibration reports use metric units.", first.ctx);
    assert.match(first.statuses.at(-1)!, /saved/);
    second = load(profile);
    await second.emit("session_start");
    const before = await second.emit("before_agent_start", {
      prompt: "Which units for calibration reports?",
      systemPrompt: "Original system instructions",
    });
    assert.match(before.systemPrompt, /Original system instructions/);
    assert.match(before.systemPrompt, /Tool Transition Rule/);
    assert.doesNotMatch(before.systemPrompt, /Calibration reports use metric/);
    const input = [{ role: "user", content: "Which units for calibration reports?", timestamp: 1 }];
    const context = await second.emit("context", { messages: input });
    assert.equal(input.length, 1);
    assert.equal(context.messages.length, 2);
    assert.match(context.messages[0].content, /untrusted reference data/i);
    assert.match(context.messages[0].content, /Calibration reports use metric units/);
    assert.equal(second.sent.length, 0);
    assert.match(second.footer()!.render(100).join("\n"), /Memory: ready/);

    // The automatic note was never written back: only the explicit /remember left
    // the session, and it is the client that holds it.
    assert.deepEqual(
      stub.calls().filter((call: { argv: string[] }) => call.argv[0] === "retain").length,
      1,
      "one write, from the explicit command only",
    );

    // The client stops working (its own profile lost the credential): the surface says
    // so, and so does the turn — silence was read as "the bank is empty".
    stub.setMode("fail");
    await second.emit("before_agent_start", { prompt: "calibration reports", systemPrompt: "" });
    assert.match(second.statuses.at(-1)!, /herdr-memory reported a failure/);
    assert.match(second.footer()!.render(100).join("\n"), /herdr-memory reported a failure/);
    const stalled = (await second.emit("context", { messages: input })).messages;
    assert.equal(input.length, 1, "the caller's array is never mutated");
    assert.equal(stalled.length, 2, "the failed turn carries a notice instead of recalled notes");
    assert.deepEqual(stalled.slice(1), input, "the conversation itself is untouched");
    assert.match(stalled[0].content, /could not be read this turn \(herdr-memory reported a failure\)/);
    assert.match(stalled[0].content, /unavailable, not empty/);
    assert.doesNotMatch(stalled[0].content, /Calibration reports use metric/);
  } finally {
    await second?.emit("session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(clientDir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
