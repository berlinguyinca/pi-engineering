import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as agent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sourcePath = path.join(root, "extensions/split-view/split-view.ts");

type Handler = (event: any, ctx?: any) => unknown;

async function harness(noSplit = false) {
  agent.initTheme("dark");
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const require = createRequire(sourcePath);
  const localConfig = await import(new URL("../../extensions/split-view/ui-panels-config.ts", import.meta.url).href);
  const layout = await import(new URL("../../extensions/split-view/layout-manager.ts", import.meta.url).href);
  const deps: Record<string, unknown> = {
    "@earendil-works/pi-coding-agent": agent,
    "@earendil-works/pi-tui": tui,
    "./ui-panels-config.ts": localConfig,
    "./layout-manager.ts": layout,
    "node:os": os,
    "node:path": path,
  };
  const src = `${readFileSync(sourcePath, "utf8")}\nexports.state = {
    responseDoc, toolsBy, pathsFrom, rebuildResponseDoc,
    get trim() { return trimResponse; }, set trim(value) { trimResponse = value; },
    get stream() { return streamingResponseComponent; },
    prepareLayout(base) {
      tuiRef = { layoutRoot: base, setLayoutRoot(root) { this.layoutRoot = root; }, requestRender() {}, terminal: { columns: 120 } };
      initLayoutManager(tuiRef);
    },
  };`;
  const compiled = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as any };
  new Function("require", "module", "exports", compiled)((id: string) => deps[id] ?? require(id), mod, mod.exports);
  mod.exports.default({
    registerFlag: () => {},
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    getFlag: () => noSplit,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { on: () => () => {} },
  });
  const emit = async (event: string, value: any, ctx?: any) => {
    for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
  };
  const ctx = (branch: any[] = []) => ({
    mode: "print",
    hasUI: false,
    sessionManager: { getBranch: () => branch },
    ui: { notify: () => {} },
  });
  return { state: mod.exports.state, emit, ctx, commands };
}

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
});

test("split-view restores persisted tool result text", async () => {
  const h = await harness(true);
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "echo result" } }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        content: [{ type: "text", text: "saved result" }],
        isError: false,
      },
    },
  ];
  await h.emit("session_start", {}, h.ctx(branch));
  assert.equal(h.state.toolsBy.get("call").output, "saved result");
});

test("disabled response trim builds no duplicate transcript during startup or streaming", async () => {
  const h = await harness(true);
  const msg = assistant("saved assistant response");
  await h.emit("session_start", {}, h.ctx([{ type: "message", message: msg }]));
  await h.emit("message_start", { message: { role: "user", content: "hello" } });
  await h.emit("message_update", { message: msg });
  await h.emit("message_end", { message: msg });
  assert.equal(h.state.responseDoc.children.length, 0);
  assert.equal(h.state.stream, null);
});

test("trim response history remains bounded when rebuilding and streaming", async () => {
  const h = await harness(true);
  h.state.trim = true;
  const branch = Array.from({ length: 1000 }, (_, i) => ({ type: "message", message: assistant(`response ${i}`) }));
  h.state.rebuildResponseDoc(h.ctx(branch));
  for (let i = 0; i < 1000; i++) await h.emit("message_end", { message: assistant(`live ${i}`) });
  assert.ok(h.state.responseDoc.children.length <= 400, "retain at most 200 message components and their spacers");
  const rendered = h.state.responseDoc.render(80).join("\n");
  assert.match(rendered, /live 999/);
  assert.doesNotMatch(rendered, /response 0(?:\n|\s)/);
});

test("bash file tracking does not infer local files from shell words", async () => {
  const h = await harness(true);
  assert.deepEqual(h.state.pathsFrom("bash", { command: `cat ${sourcePath}` }), []);
  assert.deepEqual(h.state.pathsFrom("read", { path: sourcePath }), [{ abs: sourcePath, op: "r" }]);
});

test("enabling trim lazily restores history and disabling releases its components", async () => {
  const h = await harness(true);
  const saved = assistant("saved history");
  const branch = [{ type: "message", message: saved }];
  await h.emit("session_start", {}, h.ctx(branch));
  h.state.prepareLayout(
    new tui.VStack([
      { component: new tui.ScrollView(new tui.Container()), basis: 0, grow: 1 },
      { component: new tui.Container(), basis: "auto" },
    ]),
  );
  const ctx = {
    ...h.ctx(branch),
    mode: "tui",
    ui: { notify: () => {}, theme: { fg: (_: string, text: string) => text } },
  };
  await h.commands.get("split-trim-response")!.handler("on", ctx);
  assert.match(h.state.responseDoc.render(80).join("\n"), /saved history/);
  await h.emit("message_update", { message: assistant("in progress") });
  assert.match(h.state.responseDoc.render(80).join("\n"), /in progress/);
  await h.commands.get("split-trim-response")!.handler("off", ctx);
  assert.equal(h.state.responseDoc.children.length, 0);
  assert.equal(h.state.stream, null);
  await h.commands.get("split-trim-response")!.handler("on", ctx);
  assert.equal(
    h.state.responseDoc.children.length,
    3,
    "toggle restores saved history and the one current streaming response",
  );
  assert.match(h.state.responseDoc.render(80).join("\n"), /in progress/);
});

test("enabling trim mid-stream keeps one current response even when branch contains its partial message", async () => {
  const h = await harness(true);
  const partial = { ...assistant("partial"), timestamp: 123 };
  const current = { ...assistant("partial and current"), timestamp: 123 };
  const branch = [{ type: "message", message: partial }];
  await h.emit("session_start", {}, h.ctx(branch));
  await h.emit("message_update", { message: current });
  h.state.prepareLayout(
    new tui.VStack([
      { component: new tui.ScrollView(new tui.Container()), basis: 0, grow: 1 },
      { component: new tui.Container(), basis: "auto" },
    ]),
  );
  const ctx = {
    ...h.ctx(branch),
    mode: "tui",
    ui: { notify: () => {}, theme: { fg: (_: string, text: string) => text } },
  };
  await h.commands.get("split-trim-response")!.handler("on", ctx);
  assert.match(h.state.responseDoc.render(80).join("\n"), /partial and current/);
  await h.emit("message_update", {
    message: { ...current, content: [{ type: "text", text: "partial and current final" }] },
  });
  assert.equal(
    h.state.responseDoc.children.length,
    1,
    "update must reuse the current component after branch reconstruction",
  );
  await h.commands.get("split-trim-response")!.handler("off", ctx);
  await h.commands.get("split-trim-response")!.handler("on", ctx);
  assert.match(h.state.responseDoc.render(80).join("\n"), /partial and current final/);
  assert.equal(h.state.responseDoc.children.length, 1);
});
