import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DurableMemoryRecord, InMemoryDurableMemory } from "../../src/blackhole/durableProvider.ts";
import { HindsightError } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
function fixture(
  options: {
    configured?: boolean;
    /** Which client executable the session is configured to call. */
    cli?: string;
    hasUI?: boolean;
    noticeDir?: string;
    stateDir?: string;
    now?: () => number;
    /** Wire the real opt-in path instead of the injected fake provider. */
    realProvider?: boolean;
    env?: Record<string, string>;
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
          PI_HINDSIGHT_ENABLED: "1",
          PI_HINDSIGHT_CLI: options.cli ?? "herdr-memory",
          ...(options.env ?? {}),
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
      // Mirror the real client: `HindsightDurableMemory.recallAll()` is a bounded
      // overview recall, so it reaches the service as a query like any other.
      queries.push("project memory decision");
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

/** The messages the memory extension injected into a context build. */
const notes = (result: { messages: any[] }): any[] =>
  result.messages.filter((m: any) => m.role === "custom" && m.customType === "pi-engineering-memory");

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
  f.fail(new Error("secret value herdr-token-live"));
  await f.command("remember", "valid note");
  assert.ok(f.notices.some((n) => n.type === "error"));
  assert.ok(!f.notices.some((n) => /saved/i.test(n.text)));
  assert.ok(!JSON.stringify(f.notices).includes("herdr-token-live"));
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

test("configuration off causes no provider calls", async () => {
  for (const options of [{ configured: false }]) {
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
  // A turn that could not read memory says so: silence was read as "the bank is empty".
  assert.equal(third.messages.length, 2, "the failed turn carries one notice instead of recalled notes");
  assert.deepEqual(third.messages[1], original[0], "the conversation itself is untouched");
  assert.match(notes(third)[0].content, /could not be read this turn/);
  assert.doesNotMatch(notes(third)[0].content, /Use metric|Python formatting/);
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

test("session reset and replacing the memory client clear stale memory and pending results", async () => {
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
  f.env.PI_HINDSIGHT_CLI = "/opt/rotated/herdr-memory";
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

test("context preserves off status", async () => {
  for (const options of [{ configured: false }]) {
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

    const other = fixture({ hasUI: false, noticeDir, cli: "/opt/other/herdr-memory" });
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
    const f = fixture({ hasUI: false, stateDir, cli: "/opt/private/herdr-memory" });
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

for (const action of ["save", "check", "search"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`explicit ${action} fences a pending automatic lookup ${outcome}`, async () => {
      const f = fixture();
      const prompt = { prompt: "calibration", systemPrompt: "" };
      let resolve!: (rows: DurableMemoryRecord[]) => void;
      let reject!: (error: Error) => void;
      f.override(
        () =>
          new Promise((resolveSearch, rejectSearch) => {
            resolve = resolveSearch;
            reject = rejectSearch;
          }),
      );
      const pending = f.emit("before_agent_start", prompt);
      f.override(undefined);
      if (action === "save") await f.command("remember", "calibration newly saved");
      else {
        await f.store.store(record("calibration newly saved"));
        await f.command("memory", action === "check" ? "status" : "calibration");
      }
      const statuses = f.statuses.length;
      const notices = f.notices.length;
      if (outcome === "success") resolve([record("calibration obsolete snapshot")]);
      else reject(new HindsightError("exit"));
      await pending;
      assert.equal(f.statuses.length, statuses, "stale work must preserve explicit command status");
      assert.equal(f.notices.length, notices, "stale failure must not publish a notice");
      assert.deepEqual((await f.emit("context", { messages: [] })).messages, []);
      const queries = f.queries.length;
      await f.emit("before_agent_start", prompt);
      assert.equal(f.queries.length, queries + 1, "stale work must not populate cache or impose backoff");
      const content = (await f.emit("context", { messages: [] })).messages[0].content;
      assert.match(content, /newly saved/);
      assert.doesNotMatch(content, /obsolete snapshot/);
    });
  }
}

for (const action of ["save", "check", "search"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`explicit ${action} spanning a new turn retires that turn's older lookup ${outcome}`, async () => {
      const f = fixture();
      const prompt = { prompt: "calibration", systemPrompt: "" };
      const store = f.store.store.bind(f.store);
      const recallAll = f.store.recallAll.bind(f.store);
      await store(record("calibration obsolete snapshot"));
      let completeCommand!: () => void;
      const commandGate = new Promise<void>((resolve) => {
        completeCommand = resolve;
      });
      if (action === "save")
        f.store.store = async (row) => {
          await commandGate;
          await store(row);
        };
      else if (action === "check")
        f.store.recallAll = async () => {
          await commandGate;
          return recallAll();
        };
      else
        f.override(async () => {
          await commandGate;
          return f.store.search("calibration");
        });
      const command = f.command(
        action === "save" ? "remember" : "memory",
        action === "check" ? "status" : "calibration newly saved",
      );
      let resolve!: (rows: DurableMemoryRecord[]) => void;
      let reject!: (error: Error) => void;
      f.override(
        () =>
          new Promise((resolveSearch, rejectSearch) => {
            resolve = resolveSearch;
            reject = rejectSearch;
          }),
      );
      const lookup = f.emit("before_agent_start", prompt);
      if (action !== "save") await store(record("calibration newly saved"));
      completeCommand();
      await command;
      assert.ok(f.notices.length > 0, "ordinary turn changes must not invalidate explicit command acknowledgments");
      const statuses = f.statuses.length;
      const notices = f.notices.length;
      if (outcome === "success") resolve([record("calibration obsolete snapshot")]);
      else reject(new HindsightError("unavailable"));
      await lookup;
      assert.equal(f.statuses.length, statuses);
      assert.equal(f.notices.length, notices);
      f.override(undefined);
      f.store.recallAll = recallAll;
      const searches = f.queries.length;
      await f.emit("before_agent_start", prompt);
      assert.equal(f.queries.length, searches + 1, "an obsolete lookup cannot seed cache or failure backoff");
      assert.match((await f.emit("context", { messages: [] })).messages[0].content, /newly saved/);
    });
  }
}

for (const replacement of ["session", "client"] as const) {
  test(`an explicit save remains fenced after real ${replacement} replacement`, async () => {
    const f = fixture();
    const store = f.store.store.bind(f.store);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.store.store = async (row) => {
      await gate;
      await store(row);
    };
    const save = f.command("remember", "calibration from the retired connection");
    if (replacement === "session") await f.emit("session_before_switch");
    else f.env.PI_HINDSIGHT_CLI = "/opt/rotated/herdr-memory";
    await f.emit("before_agent_start", { prompt: "calibration" });
    const statuses = f.statuses.length;
    const notices = f.notices.length;
    finish();
    await save;
    assert.equal(f.statuses.length, statuses);
    assert.equal(f.notices.length, notices);
  });
}

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

test("rejected requests back off automatic search and a new client bypasses the backoff", async () => {
  const f = fixture();
  f.fail(new HindsightError("exit"));
  await f.emit("before_agent_start", { prompt: "different calibration", systemPrompt: "" });
  assert.equal(f.queries.length, 1, "a rejected client is not called on each turn");
  assert.match(f.statuses.at(-1)!, /failure|unavailable/i);
  f.fail();
  f.env.PI_HINDSIGHT_CLI = "/opt/rotated/herdr-memory";
  await f.store.store(record("calibration available"));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  assert.equal(f.queries.length, 2);
  assert.match((await f.emit("context", { messages: [] })).messages[0].content, /available/);
});

test("a rejected client is not called on every prompt, and switching client bypasses the backoff", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { makeHerdrStub } = await import("../support/herdrMemoryStub.ts");
  const deniedDir = mkdtempSync(join(tmpdir(), "memory-client-denied-"));
  const workingDir = mkdtempSync(join(tmpdir(), "memory-client-working-"));
  const denied = makeHerdrStub(deniedDir, "fail");
  const working = makeHerdrStub(workingDir, "ok");
  const f = fixture({ realProvider: true, cli: denied.cli });
  const recalls = (stub: ReturnType<typeof makeHerdrStub>) =>
    stub.calls().filter((call: { argv: string[] }) => call.argv[0] === "recall").length;
  try {
    const prompt = { prompt: "calibration", systemPrompt: "" };
    await f.emit("before_agent_start", prompt);
    await f.emit("before_agent_start", prompt);
    assert.equal(recalls(denied), 1, "a client the service rejects is not called on each turn");
    assert.match(f.statuses.at(-1)!, /failure/i);
    // The operator points the session at a working client: that is a new identity.
    f.env.PI_HINDSIGHT_CLI = working.cli;
    await f.emit("before_agent_start", prompt);
    assert.equal(recalls(working), 1, "a changed client bypasses the failure backoff");
    assert.match(f.statuses.at(-1)!, /ready/);
    assert.equal(recalls(denied), 1, "the retired client is never called again");
  } finally {
    rmSync(deniedDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
  }
});

test("temporary memory failures retry after backoff and explicit status bypasses it", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  f.fail(new HindsightError("unavailable"));
  const prompt = { prompt: "calibration", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  f.fail();
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 1);
  now += 61_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 2);
  f.fail(new HindsightError("exit"));
  f.fail();
  await f.command("memory");
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 4, "explicit success clears cached recall and the failure backoff");
});

test("a client that answered late is asked again soon, a client that refused waits a minute", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  f.fail(new HindsightError("timeout"));
  const prompt = { prompt: "calibration", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  f.fail();
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 1, "one spent budget per backoff window");
  now += 11_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(
    f.queries.length,
    2,
    "a timeout means slow, not refused: the next turn asks again after 10 s rather than 60 s",
  );
});

test("automatic recall bounds cached queries and discards results arriving after its deadline", async () => {
  // A tight budget keeps this test's wall-clock assertion meaningful; the default is
  // deliberately larger because the live client answers in 0.39-4.9 s.
  const f = fixture({ env: { PI_HINDSIGHT_AUTOMATIC_MS: "250" } });
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

test("automatic recall holds the turn for exactly the in-turn budget and fences late results from a retired context", async (t) => {
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
  t.mock.timers.tick(1_199);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "automatic lookup is still pending before its deadline");
  t.mock.timers.tick(1);
  await pending;
  assert.equal(settled, true, "automatic lookup settles at the default 1200 ms without a provider response");
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

test("an answer that lands after the in-turn budget is injected at the next model call of the same turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ env: { PI_HINDSIGHT_AUTOMATIC_MS: "300" } });
  let resolve!: (rows: DurableMemoryRecord[]) => void;
  f.override(
    () =>
      new Promise((resolveSearch) => {
        resolve = resolveSearch;
      }),
  );
  const pending = f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  t.mock.timers.tick(299);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    notes(await f.emit("context", { messages: [{ role: "user", content: "calibration" }] })),
    [],
    "nothing is injected while the lookup is still inside its budget",
  );
  t.mock.timers.tick(1);
  await pending;
  const stalled = notes(await f.emit("context", { messages: [{ role: "user", content: "calibration" }] }));
  assert.equal(stalled.length, 1, "the turn says memory is unavailable instead of proceeding in silence");
  assert.match(stalled[0].content, /could not be read this turn/);
  assert.match(stalled[0].content, /timed out/);
  resolve([record("calibration answered late")]);
  await new Promise((r) => setImmediate(r));
  const delivered = notes(await f.emit("context", { messages: [{ role: "user", content: "calibration" }] }));
  assert.equal(delivered.length, 1, "the late answer replaces the notice rather than adding to it");
  assert.match(delivered[0].content, /answered late/);
  assert.match(f.statuses.at(-1)!, /ready/);
});

test("a headless prompt waits longer for memory than an interactive turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stall = () => new Promise<DurableMemoryRecord[]>(() => {});
  const interactive = fixture({ hasUI: true });
  interactive.override(stall);
  const headless = fixture({ hasUI: false });
  headless.override(stall);
  const prompt = { prompt: "calibration", systemPrompt: "" };
  let uiDone = false;
  let cliDone = false;
  const pending = [
    interactive.emit("before_agent_start", prompt).then(() => {
      uiDone = true;
    }),
    headless.emit("before_agent_start", prompt).then(() => {
      cliDone = true;
    }),
  ];
  t.mock.timers.tick(1_199);
  await new Promise((r) => setImmediate(r));
  assert.equal(uiDone, false);
  assert.equal(cliDone, false);
  t.mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(uiDone, true, "an interactive turn gives memory the in-turn budget");
  assert.equal(cliDone, false, "a headless run keeps waiting: its one model call is the only chance");
  t.mock.timers.tick(3_799);
  await new Promise((r) => setImmediate(r));
  assert.equal(cliDone, false, "the headless deadline is 5000 ms");
  t.mock.timers.tick(1);
  await Promise.all(pending);
  assert.equal(cliDone, true, "a headless prompt waits the full 5000 ms");
});

test("a late answer stays usable in its own turn and is fenced by the next turn", async () => {
  let release: ((rows: DurableMemoryRecord[]) => void) | undefined;
  const f = fixture();
  f.override(
    () =>
      new Promise((resolveSearch) => {
        release = resolveSearch;
      }),
  );
  const pending = f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  await new Promise((r) => setTimeout(r, 5));
  release?.([record("calibration arrived after the budget")]);
  await pending;
  const sameTurn = notes(await f.emit("context", { messages: [{ role: "user", content: "calibration" }] }));
  assert.match(sameTurn.map((m) => m.content).join("\n"), /calibration arrived after the budget/);
  await f.emit("before_agent_start", { prompt: "another question", systemPrompt: "" });
  const nextTurn = notes(await f.emit("context", { messages: [{ role: "user", content: "another question" }] }));
  assert.doesNotMatch(
    nextTurn.map((m) => m.content).join("\n"),
    /calibration arrived after the budget/,
    "an answer to a retired prompt is never injected into a new turn",
  );
});

test("a slow herdr-memory client cannot hold startup or a prompt for seconds", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { makeHerdrStub } = await import("../support/herdrMemoryStub.ts");
  const dir = mkdtempSync(join(tmpdir(), "memory-client-slow-"));
  // The stub sleeps 1.5 s per action and ignores --timeout-ms, exactly like a
  // client wedged on a hung service: only the provider's own deadline saves us.
  const slow = makeHerdrStub(dir, "slow");
  const f = fixture({ realProvider: true, cli: slow.cli, env: { PI_HINDSIGHT_TIMEOUT_MS: "120" } });
  try {
    let start = performance.now();
    await f.emit("session_start");
    const startup = performance.now() - start;
    start = performance.now();
    await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
    const turn = performance.now() - start;
    assert.ok(startup < 1000, `startup waited ${startup.toFixed(0)} ms for memory`);
    assert.ok(turn < 1000, `the prompt waited ${turn.toFixed(0)} ms for memory`);
    const stalled = notes(await f.emit("context", { messages: [{ role: "user", content: "calibration" }] }));
    assert.equal(stalled.length, 1, "a timed out read injects no recall, only the notice");
    assert.match(stalled[0].content, /could not be read this turn/);
    assert.match(f.statuses.at(-1)!, /timed out/);
    await f.emit("session_shutdown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
