/**
 * The model-switch guard inside the extension.
 *
 * The fresh-context review found the guard silently disabled whenever the
 * status bar was off: the previous window was read from footer state, and
 * with no footer it fell back to the TARGET's window, making fromWindow ===
 * toWindow and the decision always "none" — the compact-before-dispatch and
 * reject behaviours never fired. The previous window now comes from the
 * event's previousModel, which exists with or without a footer.
 *
 * These tests load the real extension against a stub ExtensionAPI with the
 * status bar DISABLED, prime the provider through the captured
 * registerProvider payload (the way Pi does), and drive the guard.
 */
import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const LISTING = {
  object: "list",
  data: [
    {
      id: "big",
      object: "model",
      inferweave: { guaranteed_routable_tokens: 1_048_576, max_output_tokens: 32_768 },
    },
    {
      id: "small",
      object: "model",
      inferweave: { guaranteed_routable_tokens: 131_072, max_output_tokens: 8_192 },
    },
    {
      // Output cap just under the window: maxTokens is not clamped (that only
      // kicks in at advertised >= window), so the reserve eats the whole
      // compaction budget and no request can fit — the reject case.
      id: "tiny",
      object: "model",
      inferweave: { guaranteed_routable_tokens: 8_192, max_output_tokens: 8_000 },
    },
  ],
};

const gateway: Server = createServer((req, res) => {
  if ((req.url ?? "").split("?")[0] === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(LISTING));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const port = (gateway.address() as AddressInfo).port;

// The extension reads both of these at module load, so set them before the
// import. PI_STATUS_BAR_ENABLED=0 is the regression scenario itself.
process.env.INFERWEAVE_BASE_URL = `http://127.0.0.1:${port}`;
process.env.PI_STATUS_BAR_ENABLED = "0";

const extension = (await import("../../extensions/index.ts")).default as unknown as (pi: unknown) => void;

type Handler = (event: unknown, ctx: unknown) => unknown;

const handlers = new Map<string, Handler[]>();
let providerPayload: { refreshModels: (c: { signal?: AbortSignal }) => Promise<unknown[]> } | undefined;

extension({
  on: (name: string, handler: Handler) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
  registerCommand: () => {},
  registerTool: () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
  getFlag: () => undefined,
  registerMessageRenderer: () => {},
  registerMarkdownTransformer: () => {},
  registerEntryRenderer: () => {},
  registerProvider: (_name: string, payload: typeof providerPayload) => {
    providerPayload = payload;
  },
  setModel: async () => false,
  events: { on: () => {}, emit: () => {} },
});

test("the provider is registered and the guard is armed", async () => {
  assert.ok(providerPayload, "the extension registered the inferweave provider");
  const models = (await providerPayload!.refreshModels({})) as Array<{ id: string; contextWindow: number }>;
  assert.deepEqual(
    models.map((m) => [m.id, m.contextWindow]),
    [
      ["big", 1_048_576],
      ["small", 131_072],
      ["tiny", 8_192],
    ],
  );
  // Two model_select handlers exist: the context tracker and this guard.
  // Pick the guard by what it does, not by position.
  const guard = (handlers.get("model_select") ?? []).find((h) => h.toString().includes("planModelSwitch"));
  assert.ok(guard, "the model-switch guard handler is registered even with the status bar off");
});

function guardCtx(usedTokens: number) {
  const notes: Array<[string, string]> = [];
  const compacts: unknown[] = [];
  return {
    notes,
    compacts,
    ctx: {
      model: { id: "big" },
      getContextUsage: () => ({ tokens: usedTokens }),
      compact: (opts: unknown) => {
        compacts.push(opts);
      },
      ui: { notify: (msg: string, kind: string) => notes.push([kind, String(msg)]) },
    },
  };
}

const event = (from: string, to: string) => ({
  type: "model_select",
  source: "set",
  model: { id: to, contextWindow: LISTING.data.find((m) => m.id === to)!.inferweave.guaranteed_routable_tokens },
  previousModel: {
    id: from,
    contextWindow: LISTING.data.find((m) => m.id === from)!.inferweave.guaranteed_routable_tokens,
  },
});

const guard = (handlers.get("model_select") ?? []).find((h) => h.toString().includes("planModelSwitch"))!;

test("1M -> 128K with 200K in use compacts before dispatch — with the status bar off", async () => {
  const { ctx, notes, compacts } = guardCtx(200_000);
  await guard(event("big", "small"), ctx);
  assert.equal(compacts.length, 1, "compaction is demanded before the next request");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.[0], "info");
});

test("a switch that still fits dispatches immediately", async () => {
  const { ctx, notes, compacts } = guardCtx(100_000);
  await guard(event("big", "small"), ctx);
  assert.equal(compacts.length, 0);
  assert.equal(notes.length, 0);
});

test("a window that cannot hold its own output budget is refused, not attempted", async () => {
  const { ctx, notes, compacts } = guardCtx(8_000);
  await guard(event("big", "tiny"), ctx);
  assert.equal(compacts.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.[0], "error");
  assert.match(notes[0]?.[1] ?? "", /cannot switch/);
});

test("a switch to a wider window is a no-op", async () => {
  const { ctx, notes, compacts } = guardCtx(100_000);
  await guard(event("small", "big"), ctx);
  assert.equal(compacts.length, 0);
  assert.equal(notes.length, 0);
});

test.after(() => {
  gateway.close();
});
