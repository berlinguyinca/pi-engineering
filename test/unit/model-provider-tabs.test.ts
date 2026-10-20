import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelTabsComponent, type TabsTheme } from "../../src/models/modelTabsComponent.ts";
import { ALL_TAB, type ModelEntry, ProviderTabsState, matchesQuery } from "../../src/models/providerTabs.ts";
import { registerModelTabs } from "../../src/models/registerModelTabs.ts";

const MODELS: ModelEntry[] = [
  { provider: "metabolomics", id: "qwen3.8-27b-modality-vision-quant-q8_k_xl" },
  { provider: "metabolomics", id: "deepseek_v4-flash-modality-text-quant-mxfp4" },
  { provider: "development", id: "qwen3.8-text" },
  {
    provider: "bender",
    id: "qwen3.8-27b-modality-vision-quant-q4_k_m",
    name: "Qwen 3.8 27B Vision Q4_K_M (Bender direct)",
  },
];

const plain: TabsTheme = { fg: (_c, t) => t, bold: (t) => t };

test("tabs are all plus providers alphabetically, with counts", () => {
  const s = new ProviderTabsState(MODELS);
  assert.deepEqual(s.tabs, [ALL_TAB, "bender", "development", "metabolomics"]);
  assert.equal(s.count(ALL_TAB), 4);
  assert.equal(s.count("metabolomics"), 2);
});

test("opens on the current model's provider with that model first and selected", () => {
  const current = { provider: "metabolomics", id: "qwen3.8-27b-modality-vision-quant-q8_k_xl" };
  const s = new ProviderTabsState(MODELS, { current });
  assert.equal(s.tab, "metabolomics");
  assert.equal(s.visible[0]?.id, current.id);
  assert.equal(s.selected?.id, current.id);
});

test("a tab only lists its provider, and next/previous wrap around", () => {
  const s = new ProviderTabsState(MODELS);
  s.nextTab(1);
  assert.equal(s.tab, "bender");
  assert.deepEqual(new Set(s.visible.map((m) => m.provider)), new Set(["bender"]));
  s.nextTab(-1);
  assert.equal(s.tab, ALL_TAB);
  s.nextTab(-1);
  assert.equal(s.tab, "metabolomics");
  s.nextTab(1);
  assert.equal(s.tab, ALL_TAB);
});

test("the query filters within the active tab and matches provider/id, id and name", () => {
  const s = new ProviderTabsState(MODELS);
  s.setQuery("vision q8");
  assert.deepEqual(
    s.visible.map((m) => m.provider),
    ["metabolomics"],
  );
  s.setQuery("bender direct");
  assert.deepEqual(
    s.visible.map((m) => m.provider),
    ["bender"],
  );
  s.setQuery("development/");
  assert.deepEqual(
    s.visible.map((m) => m.id),
    ["qwen3.8-text"],
  );
  s.nextTab(2);
  assert.equal(s.tab, "development");
  s.setQuery("deepseek");
  assert.equal(s.visible.length, 0);
  assert.equal(s.selected, undefined);
  assert.equal(matchesQuery(MODELS[0] as ModelEntry, "   "), true);
});

test("the cursor wraps and resets to the top when the query changes", () => {
  const s = new ProviderTabsState(MODELS);
  s.move(-1);
  assert.equal(s.selectedIndex, 3);
  s.move(1);
  assert.equal(s.selectedIndex, 0);
  s.move(2);
  s.setQuery("qwen");
  assert.equal(s.selectedIndex, 0);
});

test("the default model sorts right after the current one", () => {
  const s = new ProviderTabsState(MODELS, {
    current: { provider: "development", id: "qwen3.8-text" },
    defaultModel: { provider: "metabolomics", id: "deepseek_v4-flash-modality-text-quant-mxfp4" },
  });
  s.gotoTab(1);
  assert.deepEqual(
    s.visible.slice(0, 2).map((m) => m.id),
    ["qwen3.8-text", "deepseek_v4-flash-modality-text-quant-mxfp4"],
  );
});

test("the component renders the tab bar and a provider badge only on the all tab", () => {
  const s = new ProviderTabsState(MODELS);
  const view = new ModelTabsComponent(s, plain, () => {});
  const all = view.render(120).join("\n");
  assert.match(all, /\[all 4\]/);
  assert.match(all, / metabolomics 2 /);
  assert.match(all, /\[metabolomics\]/);
  s.nextTab(3);
  const one = view.render(120).join("\n");
  assert.match(one, /\[metabolomics 2\]/);
  assert.doesNotMatch(one, /qwen3\.8-text/);
  assert.doesNotMatch(one, /_xl \[metabolomics\]/);
});

test("every rendered line fits the width", () => {
  const view = new ModelTabsComponent(new ProviderTabsState(MODELS), plain, () => {});
  for (const line of view.render(30)) assert.ok(visibleWidth(line) <= 30, line);
});

test("keys: tab switches provider, typing filters, enter selects, escape cancels", () => {
  let result: ModelEntry | undefined | "pending" = "pending";
  const s = new ProviderTabsState(MODELS);
  const view = new ModelTabsComponent(s, plain, (r) => {
    result = r;
  });
  view.handleInput("\t");
  assert.equal(s.tab, "bender");
  view.handleInput("\x1b[Z");
  assert.equal(s.tab, ALL_TAB);
  view.handleInput("d");
  view.handleInput("e");
  view.handleInput("e");
  assert.equal(s.query, "dee");
  view.handleInput("\x7f");
  assert.equal(s.query, "de");
  view.handleInput("e");
  view.handleInput("\r");
  assert.deepEqual(result, MODELS[1]);
  view.handleInput("\x1b");
  assert.equal(result, undefined);
});

test("/models switches through setModel and reports a missing credential", async () => {
  const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const set: string[] = [];
  let ok = true;
  registerModelTabs({
    registerCommand: (name: string, o: { handler: (a: string, c: never) => Promise<void> }) =>
      commands.set(name, o.handler),
    setModel: async (m: { provider: string; id: string }) => {
      set.push(`${m.provider}/${m.id}`);
      return ok;
    },
  } as never);
  const notes: string[] = [];
  const models = MODELS.map((m) => ({ ...m, name: m.name ?? m.id }));
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: models[2],
    modelRegistry: { getAvailable: () => models },
    ui: {
      notify: (t: string) => notes.push(t),
      custom: async (factory: (...a: never[]) => ModelTabsComponent) => {
        const done = new Promise<ModelEntry | undefined>((resolve) => {
          const c = factory({ requestRender() {} } as never, plain as never, {} as never, resolve as never);
          c.handleInput("\t"); // development -> metabolomics
          c.handleInput("\r");
        });
        return done;
      },
    },
  } as never;
  const run = commands.get("models");
  assert.ok(run);
  await run("", ctx);
  assert.deepEqual(set, ["metabolomics/deepseek_v4-flash-modality-text-quant-mxfp4"]);
  assert.match(notes.at(-1) ?? "", /^Model: metabolomics\//);
  ok = false;
  await run("", ctx);
  assert.match(notes.at(-1) ?? "", /No credentials for metabolomics/);
});
