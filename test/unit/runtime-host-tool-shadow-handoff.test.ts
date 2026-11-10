/**
 * A declared tool must be served, or say why it cannot (#672).
 *
 * Pi keeps tools per extension (`extension.tools.set`) and resolves a name across
 * extensions first-wins in `getAllRegisteredTools`, and it cannot unregister. So
 * when two copies of this extension are loaded — the release host and a worktree
 * checkout — the copy that loaded first owns the entry the model calls. When that
 * copy's runtime rotates and nothing becomes dispatchable, its forwarder throws
 * `no active pi-engineering runtime provides it` on every turn: the tool stays
 * declared, the error names neither generation nor reason, and nothing in the
 * runtime log says the name was ever lost. `ledger_evidence` and `ledger_claim`
 * went that way mid-session.
 *
 * The bridge now (1) forwards to any live generation of itself that owns the name
 * when the dispatched one does not, (2) says which generation it dispatched,
 * whether that generation is live, and why the name is missing, and (3) reports
 * every lost or unservable name to the Host, so it reaches telemetry and
 * `/engineering version` instead of only the model's turn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BridgeTarget, PiBridge, type ToolNameEvent } from "../../src/runtime/host/piBridge.ts";

/** Pi's real shape: tools are keyed per extension; the visible set is first-wins. */
class FakePi {
  /** extension path -> tool name -> the entry that extension registered */
  readonly perExtension = new Map<string, Map<string, { execute: (...args: unknown[]) => unknown }>>();
  /** Names Pi refuses to accept (mirrors the schema assertions Pi really makes). */
  readonly refused = new Set<string>();

  private map(path: string): Map<string, { execute: (...args: unknown[]) => unknown }> {
    let m = this.perExtension.get(path);
    if (!m) {
      m = new Map();
      this.perExtension.set(path, m);
    }
    return m;
  }

  register(path: string, tool: { name: string; execute: (...args: unknown[]) => unknown }): void {
    if (this.refused.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" registered by extension "${path}" must define an object parameter schema.`);
    }
    this.map(path).set(tool.name, tool);
  }

  /** What Pi will call for `name`: the first extension that registered it. */
  visible(name: string): { execute: (...args: unknown[]) => unknown } | undefined {
    for (const tools of this.perExtension.values()) {
      const entry = tools.get(name);
      if (entry) return entry;
    }
    return undefined;
  }

  /** `pi.getAllTools()` — visible entries carry the owning extension's sourceInfo. */
  getAllTools(): Array<{ name: string; sourceInfo: { path: string } }> {
    const out: Array<{ name: string; sourceInfo: { path: string } }> = [];
    const seen = new Set<string>();
    for (const [path, tools] of this.perExtension) {
      for (const name of tools.keys()) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, sourceInfo: { path: path } });
      }
    }
    return out;
  }

  call(name: string, ...args: unknown[]): unknown {
    const entry = this.visible(name);
    if (!entry) throw new Error(`nothing is declared for ${name}`);
    return entry.execute(...args);
  }
}

/** One copy of the extension: its own bridge and host target, inside one Pi process. */
function copy(pi: FakePi, path: string, events: ToolNameEvent[]) {
  const live = new Set<number>();
  let dispatch: number | undefined;
  const target: BridgeTarget = {
    dispatchGeneration: () => dispatch,
    whenOpen: () => Promise.resolve(),
    track: (_gen, _type, _label, work) => Promise.resolve(work()),
    isLive: (generation) => live.has(generation),
  };
  const api = {
    on: () => () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string }) => pi.register(path, tool as never),
    getAllTools: () => pi.getAllTools(),
  } as never;
  const bridge = new PiBridge(api, target, [], { diagnostics: (event) => events.push(event) });
  return {
    bridge,
    load(generation: number) {
      live.add(generation);
      return bridge.createGenerationApi(generation);
    },
    activate(generation: number) {
      dispatch = generation;
    },
    retire(generation: number) {
      live.delete(generation);
      bridge.dropGeneration(generation);
      // The Host stops routing to a generation it has forgotten; nothing is
      // dispatchable until a replacement activates.
      if (dispatch === generation) dispatch = undefined;
    },
  };
}

function harness(path = "/rel/extensions/index.ts") {
  const events: ToolNameEvent[] = [];
  const pi = new FakePi();
  return { pi, events, copy: (at: string = path) => copy(pi, at, events) };
}

/** The message of a rejection, so the assertions read as text. */
async function failure(call: unknown): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("a rotated generation serves the tool name its predecessor registered", async () => {
  const h = harness();
  const c = h.copy();
  c.load(1).registerTool({ name: "ledger_evidence", execute: async () => "gen-1" } as never);
  c.activate(1);
  // Pi overwrites within one extension, so the same copy re-registers freely.
  c.load(2).registerTool({ name: "ledger_evidence", execute: async () => "gen-2" } as never);
  c.activate(2);
  c.retire(1);

  assert.equal(await h.pi.call("ledger_evidence", {}), "gen-2");
  assert.deepEqual(c.bridge.shadowedTools(2), []);
  assert.deepEqual(
    h.events.filter((e) => e.kind === "unservable"),
    [],
  );
});

test("a name the dispatched generation lacks is served by a live sibling generation", async () => {
  const h = harness();
  const c = h.copy();
  c.load(1).registerTool({ name: "ledger_claim", execute: async () => "gen-1" } as never);
  c.activate(1);

  // A handover in flight: generation 2 receives Pi traffic before it has
  // registered everything, while generation 1 is still live.
  c.load(2);
  c.activate(2);

  assert.equal(
    await h.pi.call("ledger_claim", {}),
    "gen-1",
    "a live generation that owns the definition must answer rather than the call failing",
  );
  assert.deepEqual(
    h.events.filter((e) => e.kind === "unservable"),
    [],
    "a served call reports nothing",
  );
});

test("an unservable tool says which generation was dispatched and how to recover", async () => {
  const h = harness();
  const c = h.copy();
  c.load(1).registerTool({ name: "ledger_evidence", execute: async () => "gen-1" } as never);
  c.activate(1);
  c.retire(1); // activation failed; nothing became dispatchable

  const message = await failure(h.pi.call("ledger_evidence", {}));
  assert.ok(message.length > 0, "calling a tool nobody serves must reject");
  assert.match(
    message,
    /no active pi-engineering runtime provides it/,
    "the documented phrase stays so callers and docs keep matching",
  );
  assert.match(message, /no generation is active/, `the error must say the state: ${message}`);
  assert.match(message, /\/engineering reload/, `the error must name the remedy: ${message}`);
});

test("an unservable tool names the generation and the registration loss behind it", async () => {
  const h = harness();
  const c = h.copy();
  c.load(1).registerTool({ name: "ledger_evidence", execute: async () => "gen-1" } as never);
  c.activate(1);

  // The new generation cannot take the name: Pi refuses it, so generation 2
  // records the loss, and generation 1 is then retired. The visible entry still
  // forwards here.
  h.pi.refused.add("ledger_evidence");
  c.load(2).registerTool({ name: "ledger_evidence", execute: async () => "gen-2" } as never);
  c.activate(2);
  c.retire(1);

  const message = await failure(h.pi.call("ledger_evidence", {}));
  assert.ok(message.length > 0, "calling a tool nobody serves must reject");
  assert.match(message, /generation 2/, `must name the dispatched generation: ${message}`);
  assert.match(message, /is live|is retired/, `must say whether that generation is live: ${message}`);
  assert.match(message, /lost at registration/, `must say why the name is missing: ${message}`);
  assert.match(message, /object parameter schema/, `must carry Pi's reason: ${message}`);

  const unservable = h.events.filter((e) => e.kind === "unservable");
  assert.equal(unservable.length, 1, "the failure is reported once so telemetry shows it without a flood");
  assert.equal(unservable[0]?.name, "ledger_evidence");
  assert.equal(unservable[0]?.generation, 2);
});

test("a refused registration is reported with Pi's reason", () => {
  const h = harness();
  const c = h.copy();
  h.pi.refused.add("mission");
  const api = c.load(1);
  assert.doesNotThrow(() => api.registerTool({ name: "mission", execute: async () => "ok" } as never));

  const reported = h.events.find((e) => e.kind === "shadowed" && e.name === "mission");
  assert.ok(reported);
  assert.match(reported.reason, /object parameter schema/);
  assert.equal(reported.generation, 1);
});
