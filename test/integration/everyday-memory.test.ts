/**
 * Everyday memory, end to end: the whole extension wired to a real
 * `herdr-memory` executable.
 *
 * The retired version of this test stood up the tier-1 OpenViking HTTP service
 * and drove the extension against it. There is no service to stand up any more;
 * what still has to be proven across process boundaries is the same three
 * things, and a shell stub that speaks the CLI's argv and JSON contract proves
 * them without a server, a token or a port:
 *
 *   1. an explicit /remember leaves the session through the provider's own
 *      storage (nothing is kept only in this process),
 *   2. a DIFFERENT session sees it, and only through the `context` hook — the
 *      system prompt stays the user's, and no automatic note-taking happens,
 *   3. when the CLI fails, the status says so and nothing is injected.
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

/** The contract `herdr-memory` is expected to satisfy, minus the binary. */
const STUB_SOURCE = readFileSync(new URL("../fixtures/herdr-memory-stub.sh", import.meta.url), "utf8");

test("explicit /remember survives into another session through the herdr-memory CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "everyday-memory-"));
  const cli = join(dir, "herdr-memory");
  writeFileSync(cli, STUB_SOURCE);
  chmodSync(cli, 0o755);
  const previous = { ...process.env };
  let second: ReturnType<typeof load> | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.MEMORY_STUB_DB = join(dir, "hindsight.jsonl");
    process.env.PI_HINDSIGHT_ENABLED = "1";
    process.env.PI_HINDSIGHT_CLI = cli;
    const first = load(dir);
    await first.emit("session_start");
    await first.commands.get("remember")!.handler("Calibration reports use metric units.", first.ctx);
    assert.match(first.statuses.at(-1)!, /saved/);

    // A fresh registration stands for a fresh `pi` process: the note reaches it
    // through the CLI's own storage, never through this process's memory.
    second = load(dir);
    await second.emit("session_start");
    const before = await second.emit("before_agent_start", {
      prompt: "Which units for calibration reports?",
      systemPrompt: "Original system instructions",
    });
    assert.match(before.systemPrompt, /Original system instructions/);
    assert.match(before.systemPrompt, /Tool Transition Rule/);
    assert.doesNotMatch(
      before.systemPrompt,
      /Calibration reports use metric/,
      "recall is not written into the system prompt",
    );
    const input = [{ role: "user", content: "Which units for calibration reports?", timestamp: 1 }];
    const context = await second.emit("context", { messages: input });
    assert.equal(input.length, 1, "the caller's array is never mutated");
    assert.equal(context.messages.length, 2);
    assert.match(context.messages[0].content, /Calibration reports use metric units/);
    assert.equal(second.sent.length, 0, "automatic recall never sends a chat message");
    assert.match(second.footer()!.render(100).join("\n"), /Memory: ready/);

    // A broken CLI must not serve the last good recall as if it were current:
    // the cache is cleared, so nothing is injected. Reads stay fail-open by
    // design (a missing memory never blocks the chat); the write path below is
    // where a broken CLI is named, because only a write gets an answer back.
    process.env.MEMORY_STUB_FAIL = "1";
    await second.emit("before_agent_start", { prompt: "calibration reports", systemPrompt: "" });
    assert.deepEqual((await second.emit("context", { messages: input })).messages, input);

    await second.commands.get("remember")!.handler("Second note.", second.ctx);
    assert.match(second.statuses.at(-1)!, /herdr-memory exited unsuccessfully|Hindsight refused the write/);
    assert.match(
      second.footer()!.render(100).join("\n"),
      /herdr-memory exited unsuccessfully|Hindsight refused the write/,
    );
    // And the note really did not land: the storage file still holds one line.
    assert.equal(readFileSync(process.env.MEMORY_STUB_DB!, "utf8").trim().split("\n").length, 1);
  } finally {
    await second?.emit("session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
