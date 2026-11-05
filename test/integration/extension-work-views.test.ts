/** /summary, /task and /team are registered next to /work and /handoff stays registered; no model call is involved. */
import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../../extensions/index.ts";

test("work views are registered as commands; /work and /handoff remain", () => {
  const commands = new Map<string, { description?: string; handler: unknown }>();
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: { description?: string; handler: unknown }) => commands.set(name, options),
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
  for (const name of ["work", "summary", "task", "team", "handoff"])
    assert.equal(typeof commands.get(name)?.handler, "function", `/${name} registered`);
  assert.match(commands.get("summary")?.description ?? "", /[Dd]eterministic/);
});

test("/task without an id explains usage without opening a runtime", async () => {
  const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
  const pi = {
    on: () => {},
    registerCommand: (n: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => commands.set(n, o),
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
  const notices: string[] = [];
  await commands.get("task")?.handler("  ", { cwd: process.cwd(), ui: { notify: (m: string) => notices.push(m) } });
  assert.match(notices[0] ?? "", /Usage: \/task/);
});
