import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DurableMemoryRecord, InMemoryDurableMemory } from "../../src/blackhole/OpenViking.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
function fixture(options: { configured?: boolean; token?: string; hasUI?: boolean } = {}) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, Handler>();
  const statuses: string[] = [];
  const notices: Array<{ text: string; type: string }> = [];
  const sent: any[] = [];
  const env: Record<string, string | undefined> =
    options.configured === false
      ? {}
      : {
          PI_OPENVIKING_BASE_URL: "https://memory.example",
          PI_OPENVIKING_TOKEN: options.token ?? "test-key",
        };
  const store = new InMemoryDurableMemory();
  const queries: string[] = [];
  let saves = 0;
  let failure: Error | undefined;
  let searchOverride: ((query: string) => Promise<DurableMemoryRecord[]>) | undefined;
  const provider = {
    kind: "test",
    store: async (r: DurableMemoryRecord) => {
      saves++;
      if (failure) throw failure;
      await store.store(r);
    },
    recallAll: async () => {
      if (failure) throw failure;
      return store.recallAll();
    },
    search: async (q: string) => {
      queries.push(q);
      if (failure) throw failure;
      return searchOverride ? searchOverride(q) : store.search(q);
    },
  };
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, fn: Handler) => events.set(event, fn),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/project",
    hasUI: options.hasUI ?? true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? ""),
      notify: (text: string, type: string) => notices.push({ text, type }),
    },
  } as unknown as ExtensionCommandContext;
  registerInteractiveMemory(pi, { env: () => env, provider: () => provider, setup: async () => {} });
  return {
    commands,
    events,
    statuses,
    notices,
    sent,
    ctx,
    env,
    store,
    queries,
    get saves() {
      return saves;
    },
    fail: (error?: Error) => {
      failure = error;
    },
    override: (fn: typeof searchOverride) => {
      searchOverride = fn;
    },
    emit: async (name: string, event: any = {}) => events.get(name)?.(event, ctx),
    command: async (name: string, args = "") => commands.get(name)!.handler(args, ctx),
  };
}
const record = (text: string, id = text): DurableMemoryRecord => ({
  id,
  text,
  sourceRefs: [],
  promotedFrom: "user",
  evidenceIds: [],
  promotedAt: "2026-09-14T00:00:00Z",
  promotedBy: "user",
});

test("explicit remember persists only supplied text with honest user provenance", async () => {
  const f = fixture();
  await f.command("remember", "  Use metric units.  ");
  const rows = await f.store.recallAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, "Use metric units.");
  assert.equal(rows[0]!.promotedBy, "user");
  assert.match(rows[0]!.promotedFrom, /remember/);
  assert.ok(f.notices.some((n) => /saved/i.test(n.text)));
  await f.emit("before_agent_start", { prompt: "ordinary prompt", systemPrompt: "unchanged" });
  await f.emit("agent_end");
  assert.equal(f.saves, 1, "ordinary turns must never save automatically");
});

for (const input of ["", "   ", "x".repeat(4001)]) {
  test(`remember rejects ${input.length} character input before writing`, async () => {
    const f = fixture();
    await f.command("remember", input);
    assert.equal(f.saves, 0);
    assert.ok(f.notices.some((n) => n.type === "error"));
  });
}

test("save errors do not report success or leak raw errors", async () => {
  const f = fixture();
  f.fail(new Error("secret credential test-key"));
  await f.command("remember", "valid note");
  assert.ok(f.notices.some((n) => n.type === "error"));
  assert.ok(!f.notices.some((n) => /saved/i.test(n.text)));
  assert.ok(!JSON.stringify(f.notices).includes("test-key"));
});

test("valid empty response reports ready, failures report error and recover", async () => {
  const f = fixture();
  await f.command("memory");
  assert.match(f.statuses.at(-1)!, /ready/i);
  assert.match(f.notices.at(-1)!.text, /0/);
  f.fail(new Error("unavailable"));
  await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "untouched" });
  assert.match(f.statuses.at(-1)!, /unavailable|error/i);
  const errors = f.notices.filter((n) => n.type === "error").length;
  await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "untouched" });
  assert.equal(f.notices.filter((n) => n.type === "error").length, errors);
  f.fail();
  await f.command("memory");
  assert.match(f.statuses.at(-1)!, /ready/i);
});

test("configuration off or empty key causes no provider calls", async () => {
  for (const options of [{ configured: false }, { token: "" }]) {
    const f = fixture(options);
    await f.emit("session_start");
    await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    await f.command("remember", "note");
    assert.equal(f.saves, 0);
    assert.equal(f.queries.length, 0);
    assert.match(f.statuses.at(-1)!, /off|key/i);
  }
});

test("recall is ephemeral, relevant and replaced on each prompt", async () => {
  const f = fixture();
  await f.store.store(record("Use metric units", "metric"));
  await f.store.store(record("Python formatting uses ruff", "python"));
  const original = [{ role: "user", content: "question", timestamp: 1 }];
  assert.equal(
    await f.emit("before_agent_start", { prompt: "Which metric units?", systemPrompt: "guard text" }),
    undefined,
  );
  const first = await f.emit("context", { messages: original });
  assert.equal(original.length, 1);
  assert.equal(first.messages.length, 2);
  assert.match(first.messages[0].content, /Use metric units/);
  assert.doesNotMatch(first.messages[0].content, /Python formatting/);
  assert.match(first.messages[0].content, /untrusted|reference/i);
  const again = await f.emit("context", { messages: first.messages });
  assert.equal(again.messages.length, 2);
  assert.equal(f.sent.length, 0, "automatic recall must not persist transcript messages");
  await f.emit("before_agent_start", { prompt: "Python formatting", systemPrompt: "guard text" });
  const second = await f.emit("context", { messages: original });
  assert.match(second.messages[0].content, /Python formatting/);
  assert.doesNotMatch(second.messages[0].content, /Use metric/);
  f.fail(new Error("gone"));
  await f.emit("before_agent_start", { prompt: "Python", systemPrompt: "" });
  const third = await f.emit("context", { messages: first.messages });
  assert.deepEqual(third.messages, original);
});

test("recall has a bounded query, result count and complete context budget", async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) await f.store.store(record(`calibration ${"x".repeat(4000)}`, String(i)));
  await f.emit("before_agent_start", { prompt: "calibration ".repeat(1000), systemPrompt: "" });
  assert.ok(f.queries[0]!.length <= 512);
  const response = await f.emit("context", { messages: [] });
  assert.ok(response.messages[0].content.length <= 6000);
  assert.ok(response.messages[0].content.includes("calibration"));
});

test("stopword-only and blank prompts do not retrieve the entire store", async () => {
  const f = fixture();
  for (const prompt of ["", "the and a to", "hi"]) {
    await f.emit("before_agent_start", { prompt, systemPrompt: "" });
  }
  assert.deepEqual(f.queries, []);
});

test("session reset and credential rotation clear stale memory and pending results", async () => {
  const f = fixture();
  let resolve!: (rows: DurableMemoryRecord[]) => void;
  f.override(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  await f.emit("session_before_switch");
  resolve([record("calibration old")]);
  await pending;
  assert.deepEqual((await f.emit("context", { messages: [] })).messages, []);
  f.override(undefined);
  await f.store.store(record("calibration new"));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  f.env.PI_OPENVIKING_TOKEN = "rotated";
  assert.deepEqual((await f.emit("context", { messages: [] })).messages, []);
});

test("late completion cannot overwrite a newer turn", async () => {
  const f = fixture();
  let resolve!: (rows: DurableMemoryRecord[]) => void;
  f.override((q) =>
    q.includes("first")
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve([record("second calibration")]),
  );
  const first = f.emit("before_agent_start", { prompt: "first calibration", systemPrompt: "" });
  await f.emit("before_agent_start", { prompt: "second calibration", systemPrompt: "" });
  resolve([record("first calibration")]);
  await first;
  const content = (await f.emit("context", { messages: [] })).messages[0].content;
  assert.match(content, /second/);
  assert.doesNotMatch(content, /first/);
});

test("headless command confirmation is visible without triggering a model turn", async () => {
  const f = fixture({ hasUI: false });
  await f.command("remember", "Use metric units");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.display, true);
  assert.equal(f.sent[0].options.triggerTurn, false);
});

test("manual search supports short model and language names", async () => {
  const f = fixture();
  await f.store.store(record("Use Go for concurrency and AI inference"));
  for (const query of ["Go", "AI"]) {
    await f.command("memory", query);
    assert.match(f.notices.at(-1)!.text, /Use Go/);
  }
});

test("current user request follows recalled notes in model context", async () => {
  const f = fixture();
  await f.store.store(record("Calibration uses metric units"));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  const user = { role: "user", content: "Use inches for this calibration", timestamp: 1 };
  const result = await f.emit("context", { messages: [user] });
  assert.equal(result.messages.at(-1), user);
});

test("context preserves off and missing-key status", async () => {
  for (const options of [{ configured: false }, { token: "" }]) {
    const f = fixture(options);
    await f.emit("session_start");
    const status = f.statuses.at(-1);
    await f.emit("context", { messages: [] });
    assert.equal(f.statuses.at(-1), status);
  }
});

test("headless manual setup provides actionable visible instructions", async () => {
  const f = fixture({ hasUI: false });
  await f.command("memory", "setup");
  assert.match(f.sent.at(-1).message.content, /interactive.*terminal/i);
  assert.doesNotMatch(f.sent.at(-1).message.content, /connection verified/i);
});
