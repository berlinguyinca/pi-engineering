import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../../extensions/index.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

test("/room is registered next to the local /mission command (no collision) and explains a missing herdr block", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) =>
      commands.set(name, options),
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
  (extension as unknown as (api: unknown) => void)(pi);
  assert.ok(commands.has("room"));
  assert.ok(commands.has("mission"), "the local orchestrator command is untouched");
  const notices: Array<{ text: string; level: string }> = [];
  await commands
    .get("room")!
    .handler("", { ui: { notify: (text: string, level: string) => notices.push({ text, level }) } });
  // The test process has no herdr block in the agent dir (HERDR_DISABLED): a plain instruction, never a crash or a request.
  assert.equal(notices.length, 1);
  assert.notEqual(notices[0]!.level, "info");
});

test("EngineeringRuntime enables the context-threshold handoff on its Orchestrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-continuity-"));
  try {
    const runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    const orchestrator = runtime.orchestrator as unknown as Record<string, unknown> | undefined;
    assert.ok(orchestrator, "runtime built an Orchestrator");
    assert.ok(orchestrator.phaseHandoffCfg, "phaseHandoff configured by the runtime");
    assert.ok(orchestrator.continuityTrigger, "live context/quota trigger built");
    await runtime.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
