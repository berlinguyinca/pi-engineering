import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

test("full extension saves over HTTP and recalls in a fresh chat without persisting automatic notes", async () => {
  // @ts-expect-error standalone JS service has no declaration file
  const { startServer } = await import("../../services/openviking/src/server.mjs");
  const server = await startServer({ port: 0, token: "everyday-test" });
  const profile = await mkdtemp(join(tmpdir(), "everyday-memory-"));
  const previous = { ...process.env };
  let second: ReturnType<typeof load> | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = profile;
    process.env.PI_OPENVIKING_BASE_URL = server.url;
    process.env.PI_OPENVIKING_TOKEN = "everyday-test";
    process.env.PI_OPENVIKING_ENABLED = "1";
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
    assert.match(context.messages[0].content, /Calibration reports use metric units/);
    assert.equal(second.sent.length, 0);
    assert.match(second.footer()!.render(100).join("\n"), /Memory: ready/);
    process.env.PI_OPENVIKING_TOKEN = "revoked-test-key";
    await second.emit("before_agent_start", { prompt: "calibration reports", systemPrompt: "" });
    assert.match(second.statuses.at(-1)!, /invalid or revoked/);
    assert.match(second.footer()!.render(100).join("\n"), /invalid or revoked/);
    assert.deepEqual((await second.emit("context", { messages: input })).messages, input);
  } finally {
    await second?.emit("session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
