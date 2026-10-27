import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DurableMemoryRecord, InMemoryDurableMemory } from "../../src/blackhole/OpenViking.ts";
import { OpenVikingRequestError } from "../../src/blackhole/durable.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
function fixture(
  options: {
    configured?: boolean;
    token?: string;
    hasUI?: boolean;
    noticeDir?: string;
    baseUrl?: string;
    stateDir?: string;
    now?: () => number;
    realProvider?: boolean;
    setup?: (ctx: ExtensionContext, force?: boolean) => Promise<void>;
  } = {},
) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, Handler>();
  const statuses: string[] = [];
  const notices: Array<{ text: string; type: string }> = [];
  const sent: any[] = [];
  const env: Record<string, string | undefined> =
    options.configured === false
      ? {}
      : {
          PI_OPENVIKING_BASE_URL: options.baseUrl ?? "https://memory.example",
          PI_OPENVIKING_TOKEN: options.token ?? "test-key",
        };
  if (options.stateDir) env.PI_ENGINEERING_STATE_DIR = options.stateDir;
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
  registerInteractiveMemory(pi, {
    env: () => env,
    ...(options.realProvider ? {} : { provider: () => provider }),
    setup: options.setup ?? (async () => {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.noticeDir ? { headlessNoticeDir: options.noticeDir } : {}),
  });
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

test("headless automatic memory failures stay out of the transcript and log once per host per day", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setTelemetrySink } = await import("../../src/telemetry/sink.ts");
  const noticeDir = mkdtempSync(join(tmpdir(), "memory-notices-"));
  const logged: string[] = [];
  const uninstall = setTelemetrySink((notice) => logged.push(notice.text));
  try {
    const first = fixture({ hasUI: false, noticeDir });
    first.fail(new Error("unavailable"));
    await first.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    await first.emit("before_agent_start", { prompt: "imperial units", systemPrompt: "" });
    assert.equal(first.sent.length, 0, "no memory-status message is written into the session transcript");
    assert.equal(logged.filter((t) => /service unavailable/.test(t)).length, 1, "logged once");

    // A second headless run (a new `pi -p` process) on the same day and host stays quiet.
    const second = fixture({ hasUI: false, noticeDir });
    second.fail(new Error("unavailable"));
    await second.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    assert.equal(second.sent.length, 0);
    assert.equal(logged.filter((t) => /service unavailable/.test(t)).length, 1, "once per host per day");

    const other = fixture({ hasUI: false, noticeDir, baseUrl: "https://other-memory.example" });
    other.fail(new Error("unavailable"));
    await other.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    assert.equal(logged.filter((t) => /service unavailable/.test(t)).length, 2, "a different host logs");

    // An explicit command still answers in headless mode.
    await other.command("memory");
    assert.equal(other.sent.length, 1);
  } finally {
    uninstall();
    rmSync(noticeDir, { recursive: true, force: true });
  }
});

test("headless notice markers live in the per-user state dir, private, without the host in clear (PR #106 review)", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setTelemetrySink } = await import("../../src/telemetry/sink.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "pi-eng-memory-state-"));
  const uninstall = setTelemetrySink(() => {});
  try {
    const f = fixture({ hasUI: false, stateDir, baseUrl: "https://private-memory.example" });
    f.fail(new Error("unavailable"));
    await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    const dir = join(stateDir, "memory-notices");
    assert.equal(statSync(dir).mode & 0o777, 0o700, "notice dir is private to the user");
    const markers = readdirSync(dir);
    assert.equal(markers.length, 1);
    const marker = join(dir, markers[0]!);
    assert.equal(statSync(marker).mode & 0o777, 0o600, "marker is private to the user");
    assert.doesNotMatch(readFileSync(marker, "utf8"), /private-memory/, "the memory host is not written in clear");
  } finally {
    uninstall();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("automatic memory recall caches repeated queries until expiry, save or session reset", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  await f.store.store(record("calibration uses metric units"));
  const prompt = { prompt: "calibration units", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 1, "unchanged prompts reuse a bounded successful recall");
  assert.match((await f.emit("context", { messages: [] })).messages[0].content, /metric/);
  now += 61_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 2, "old recalls expire");
  await f.command("remember", "calibration uses inches now");
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 3, "saving invalidates a successful empty or nonempty recall");
  await f.emit("session_before_switch");
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 4, "another session does not inherit recalled private notes");
});

test("explicit memory search invalidates an earlier automatic recall", async () => {
  const f = fixture();
  const prompt = { prompt: "calibration", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  await f.store.store(record("calibration externally updated"));
  await f.command("memory", "calibration");
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 3);
  assert.match((await f.emit("context", { messages: [] })).messages[0].content, /externally updated/);
});

test("late setup errors do not touch a session closed while setup was pending", async () => {
  for (const manual of [false, true]) {
    let reject!: (error: Error) => void;
    const f = fixture({
      setup: () =>
        new Promise((_resolve, rejectSetup) => {
          reject = rejectSetup;
        }),
    });
    Object.assign(f.ctx, { mode: "tui" });
    const pending = manual ? f.command("memory", "setup") : f.emit("session_start");
    await f.emit("session_shutdown");
    const statuses = f.statuses.length;
    const notices = f.notices.length;
    reject(new Error("setup failed after shutdown"));
    await pending;
    assert.equal(f.statuses.length, statuses);
    assert.equal(f.notices.length, notices);
  }
});

test("authentication failures back off automatic search and credential rotation bypasses the backoff", async () => {
  const f = fixture();
  f.fail(new OpenVikingRequestError("auth", 401));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  await f.emit("before_agent_start", { prompt: "different calibration", systemPrompt: "" });
  assert.equal(f.queries.length, 1, "a rejected key is not sent on each turn");
  assert.match(f.statuses.at(-1)!, /invalid|revoked/);
  f.fail();
  f.env.PI_OPENVIKING_TOKEN = "rotated-key";
  await f.store.store(record("calibration available"));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  assert.equal(f.queries.length, 2);
  assert.match((await f.emit("context", { messages: [] })).messages[0].content, /available/);
});

test("real HTTP authentication failures are not retried on every prompt", async () => {
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.statusCode = req.headers.authorization === "Bearer rotated-key" ? 200 : 401;
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture({ realProvider: true, baseUrl: `http://127.0.0.1:${address.port}` });
  try {
    const prompt = { prompt: "calibration", systemPrompt: "" };
    await f.emit("before_agent_start", prompt);
    await f.emit("before_agent_start", prompt);
    assert.equal(requests, 1);
    assert.match(f.notices.at(-1)!.text, /invalid or revoked/);
    f.env.PI_OPENVIKING_TOKEN = "rotated-key";
    await f.emit("before_agent_start", prompt);
    assert.equal(requests, 2);
    assert.match(f.statuses.at(-1)!, /ready/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("temporary memory failures retry after backoff and explicit status bypasses it", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  f.fail(new OpenVikingRequestError("unreachable"));
  const prompt = { prompt: "calibration", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  f.fail();
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 1);
  now += 61_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 2);
  f.fail(new OpenVikingRequestError("auth", 401));
  await f.emit("before_agent_start", { prompt: "different calibration", systemPrompt: "" });
  f.fail();
  await f.command("memory");
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 4, "explicit success clears cached recall and the failure backoff");
});

test("automatic recall bounds cached queries and discards results arriving after its deadline", async () => {
  const f = fixture();
  for (let i = 0; i < 33; i++) {
    await f.emit("before_agent_start", { prompt: `calibration-${i}`, systemPrompt: "" });
  }
  await f.emit("before_agent_start", { prompt: "calibration-0", systemPrompt: "" });
  assert.equal(f.queries.length, 34, "the oldest recall is evicted rather than retaining every prompt");
  let resolve!: (rows: DurableMemoryRecord[]) => void;
  f.override(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const started = performance.now();
  await f.emit("before_agent_start", { prompt: "pending calibration", systemPrompt: "" });
  assert.ok(performance.now() - started < 1000);
  await f.emit("session_shutdown");
  const statusCount = f.statuses.length;
  resolve([record("pending calibration late")]);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.statuses.length, statusCount, "a late response does not update a closed session");
  assert.deepEqual((await f.emit("context", { messages: [] })).messages, []);
});

test("automatic recall deadline is exactly 250 ms and fences late results from a retired context", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let resolve!: (rows: DurableMemoryRecord[]) => void;
  f.override(
    () =>
      new Promise((resolveSearch) => {
        resolve = resolveSearch;
      }),
  );
  let stale = false;
  let staleAccesses = 0;
  Object.assign(f.ctx, {
    ui: new Proxy(f.ctx.ui, {
      get(target, property, receiver) {
        if (stale) {
          staleAccesses++;
          throw new Error("retired context");
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  });
  let settled = false;
  const pending = f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" }).then(() => {
    settled = true;
  });
  t.mock.timers.tick(249);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "automatic lookup is still pending before its deadline");
  t.mock.timers.tick(1);
  await pending;
  assert.equal(settled, true, "automatic lookup settles at 250 ms without a provider response");
  assert.match(f.statuses.at(-1)!, /timed out/);
  await f.emit("session_shutdown");
  stale = true;
  const statuses = f.statuses.length;
  const notices = f.notices.length;
  resolve([record("calibration late result")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleAccesses, 0);
  assert.equal(f.statuses.length, statuses);
  assert.equal(f.notices.length, notices);
  assert.deepEqual((await f.emit("context", { messages: [] })).messages, []);
});

test("slow memory server cannot hold startup or a prompt for seconds", async () => {
  const { createServer } = await import("node:http");
  const timers = new Set<NodeJS.Timeout>();
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.setHeader("content-type", "application/json");
      res.end("[]");
    }, 1500);
    timers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const events = new Map<string, Handler>();
  let stale = false;
  let staleAccesses = 0;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: () => {
        if (stale) staleAccesses++;
      },
      notify: () => {
        if (stale) staleAccesses++;
      },
    },
  } as unknown as ExtensionContext;
  registerInteractiveMemory(
    {
      registerCommand: () => {},
      on: (name: string, handler: Handler) => events.set(name, handler),
    } as unknown as ExtensionAPI,
    {
      env: () => ({
        PI_OPENVIKING_BASE_URL: `http://127.0.0.1:${address.port}`,
        PI_OPENVIKING_TOKEN: "local-test-key",
      }),
      setup: async () => {},
    },
  );
  try {
    const start = performance.now();
    await events.get("session_start")!({}, ctx);
    assert.ok(performance.now() - start < 1000, "startup recall has a short automatic deadline");
    await events.get("session_before_switch")!({}, ctx);
    const turnStart = performance.now();
    await events.get("before_agent_start")!({ prompt: "calibration", systemPrompt: "" }, ctx);
    assert.ok(performance.now() - turnStart < 1000, "automatic search has a short deadline");
    assert.equal(requests, 2);
    stale = true;
    await events.get("session_shutdown")!({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(staleAccesses, 0, "timed-out work does not touch a retired context");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
