/**
 * The operator's ways out of a persisted operator pin, through the live
 * extension: `/engineering-model auto` releases the pins stored on this
 * session's missions, and `/mission resume <id> --model auto` releases one.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import extension from "../../extensions/index.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const exec = promisify(execFile);
type Command = { handler: (args: string, ctx: unknown) => Promise<void> | void };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

test("/engineering-model auto and /mission resume --model auto release persisted mission pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-pin-commands-"));
  const commands = new Map<string, Command>();
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const ctx = {
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
    },
  };
  let runtime: EngineeringRuntime | undefined;
  try {
    await exec("git", ["init", "-q"], { cwd: root });
    await exec(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-qm", "init"],
      {
        cwd: root,
      },
    );
    (extension as unknown as (api: unknown) => void)({
      on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name: string, options: Command) => commands.set(name, options),
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
    runtime = await EngineeringRuntime.open({ cwd: root, worker: new FakeWorkerExecutor({}) });
    // The extension opens its runtime over the same namespace (shared mission store).
    await commands.get("mission-status")!.handler("", ctx);
    const store = runtime.missionStore!;
    const pin = { provider: "gw", id: "glm5.3-flash", set_at: new Date().toISOString() };
    const make = (parent: string) => {
      const mission = store.createMission({
        title: "pinned",
        goal: "g",
        user_request: "g",
        repository: root,
        base_ref: "",
        risk_profile: "low",
        workflow_class: "engineering",
        parent_session_id: parent,
      });
      store.updateMission(mission.mission_id, { operator_model_pin: pin });
      return mission.mission_id;
    };
    const ours = make(RuntimeSession.current().sessionId);
    const restored = make("S-before-restart");

    // A paused, pinned mission is visible in /mission-status and /engineering-status.
    store.markOperatorPause(restored);
    notices.length = 0;
    await commands.get("mission-status")!.handler("", ctx);
    const paused = new RegExp(
      `PAUSED by operator at \\S+ — automatic repair is off; resume with /mission resume ${restored} \\(add --model auto to release a model pin\\)`,
    );
    assert.match(notices.join("\n"), paused);
    assert.match(notices.join("\n"), /model: gw\/glm5\.3-flash \(operator pin\)/);
    notices.length = 0;
    await commands.get("engineering-status")!.handler("", ctx);
    assert.match(notices.join("\n"), paused);
    assert.match(notices.join("\n"), new RegExp(`${ours}.*model: gw/glm5\\.3-flash \\(operator pin\\)`));

    await commands.get("engineering-model")!.handler("auto", ctx);
    assert.equal(store.getMission(ours)?.operator_model_pin, null, notices.join("\n"));
    assert.equal(store.getMission(restored)?.operator_model_pin?.id, pin.id, "another session's mission is untouched");

    await commands.get("mission")!.handler(`resume ${restored} --model auto`, ctx);
    assert.equal(store.getMission(restored)?.operator_model_pin, null, notices.join("\n"));
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
