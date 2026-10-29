/**
 * What `/update` does when Pi loaded the extension from an installed runtime.
 *
 * The command's only own mechanism is a strict fast-forward of a checkout. An
 * installed runtime has no version-control metadata, so that path answered
 * "not a git checkout" while a real update was pending — the operator was told
 * the impossible. The command must instead drive the host's transactional
 * updater for the tree the host owns, and `--check` must stay read-only while
 * doing it.
 *
 * The checkout path is not exercised here: it needs a real repository and is
 * covered by `test/unit/update-self-update.test.ts`. What matters in this file is
 * the routing decision and the read-only contract.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, test } from "node:test";
import extension from "../../extensions/index.ts";
import { type RuntimeUpdateBridge, setRuntimeUpdateBridge } from "../../src/update/hostBridge.ts";

type Command = { handler: (args: string, ctx: unknown) => Promise<void> | void };

/** The repository root the extension computes as its own root. */
const EXTENSION_ROOT = resolve(new URL("../..", import.meta.url).pathname);

function loadUpdateCommand(): { command: Command; notices: Array<{ message: string; level: string }> } {
  const commands = new Map<string, Command>();
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: Command) => commands.set(name, options),
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
  const command = commands.get("update");
  assert.ok(command, "the extension registers /update");
  return { command, notices: [] };
}

function contextFor(notices: Array<{ message: string; level: string }>) {
  return {
    cwd: EXTENSION_ROOT,
    ui: {
      notify: (message: string, level = "info") => notices.push({ message, level }),
      setStatus: () => {},
      setStatusLine: () => {},
      onTerminalInput: () => () => {},
    },
  };
}

function stubBridge(overrides: Partial<RuntimeUpdateBridge> = {}) {
  const calls = { check: 0, apply: 0, owns: 0 };
  const bridge: RuntimeUpdateBridge = {
    owns: (dir: string) => {
      calls.owns += 1;
      return dir === EXTENSION_ROOT;
    },
    check: async () => {
      calls.check += 1;
      return {
        lines: ["Current:      0.2.0-aaaa1111", "Available:    0.2.0-bbbb2222", "Update available."],
        pending: true,
      };
    },
    apply: async (report?: (line: string) => void) => {
      calls.apply += 1;
      report?.("Activating 0.2.0-bbbb2222");
      return { lines: ["Fetching", "Staging", "Activating"], outcome: "Updated to 0.2.0-bbbb2222", ok: true };
    },
    ...overrides,
  };
  return { bridge, calls };
}

after(() => setRuntimeUpdateBridge(undefined));

test("/update on an installed runtime drives the transaction instead of asking git", async () => {
  const { command, notices } = loadUpdateCommand();
  const { bridge, calls } = stubBridge();
  setRuntimeUpdateBridge(bridge);

  await command.handler("", contextFor(notices));

  assert.equal(calls.apply, 1, "the transactional updater is driven");
  assert.equal(calls.check, 0, "an apply does not stop at a check");
  const text = notices.map((n) => n.message).join("\n");
  assert.match(text, /Updated to 0\.2\.0-bbbb2222/);
  assert.doesNotMatch(text, /Update check unavailable/, "a pending update must never be called an impossible one");
  assert.doesNotMatch(text, /not a git checkout/);
});

test("/update --check on an installed runtime reports the pending commit and mutates nothing", async () => {
  const { command, notices } = loadUpdateCommand();
  const { bridge, calls } = stubBridge();
  setRuntimeUpdateBridge(bridge);

  await command.handler("--check", contextFor(notices));

  assert.equal(calls.check, 1, "the read-only check ran");
  assert.equal(calls.apply, 0, "--check must not stage, activate or move a pointer");
  const text = notices.map((n) => n.message).join("\n");
  assert.match(text, /Current:\s+0\.2\.0-aaaa1111/);
  assert.match(text, /Available:\s+0\.2\.0-bbbb2222/);
  assert.match(text, /Run \/update to fetch, validate and activate/);
});

test("/update --check surfaces a failed check as a warning, not as silence", async () => {
  const { command, notices } = loadUpdateCommand();
  const { bridge } = stubBridge({
    check: async () => ({
      lines: ["Update check failed: remote unreachable"],
      pending: false,
      failure: "remote unreachable",
    }),
  });
  setRuntimeUpdateBridge(bridge);

  await command.handler("--check", contextFor(notices));

  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "warning");
  assert.match(notices[0]?.message ?? "", /remote unreachable/);
});

test("/update reports a refused transaction with the phases that led to it", async () => {
  const { command, notices } = loadUpdateCommand();
  const { bridge } = stubBridge({
    apply: async () => ({ lines: ["Fetching", "Validating"], outcome: "update failed during validating", ok: false }),
  });
  setRuntimeUpdateBridge(bridge);

  await command.handler("", contextFor(notices));

  const text = notices.map((n) => n.message).join("\n");
  assert.match(text, /update failed during validating/);
  assert.match(text, /Validating/, "the phase that stopped it is shown");
  assert.equal(
    notices.some((n) => n.level === "warning"),
    true,
  );
});
