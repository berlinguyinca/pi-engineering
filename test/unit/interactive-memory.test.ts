import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DurableMemoryRecord, InMemoryDurableMemory } from "../../src/blackhole/durableProvider.ts";
import { HindsightDurableMemory, HindsightError, type HindsightRunner } from "../../src/blackhole/hindsight.ts";
import { registerInteractiveMemory } from "../../src/blackhole/interactiveMemory.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
function fixture(
  options: {
    configured?: boolean;
    hasUI?: boolean;
    noticeDir?: string;
    cli?: string;
    stateDir?: string;
    now?: () => number;
  } = {},
) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, Handler>();
  const statuses: string[] = [];
  const notices: Array<{ text: string; type: string }> = [];
  const sent: any[] = [];
  // Hindsight is the only durable backend and it is on by default: `memory.hindsight` in
  // the global engineering.yaml is the whole configuration, and the herdr-memory
  // CLI holds its own credentials.
  const agentDir = mkdtempSync(join(tmpdir(), "im-agent-"));
  const writeConfig = (scopes: string[], extra = "") =>
    writeFileSync(
      join(agentDir, "engineering.yaml"),
      `memory:\n  hindsight:\n    enabled: true\n    cli: ${JSON.stringify(options.cli ?? "herdr-memory")}\n    scopes: ${JSON.stringify(scopes)}\n${extra}`,
    );
  // Memory is on by default, so "not configured" states the opt-out explicitly.
  if (options.configured !== false) writeConfig(["project"]);
  else writeFileSync(join(agentDir, "engineering.yaml"), "memory:\n  hindsight:\n    enabled: false\n");
  const env: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: agentDir };
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
    provider: () => provider,
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
    writeConfig,
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

test("memory disabled causes no provider calls", async () => {
  const f = fixture({ configured: false });
  await f.emit("session_start");
  await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
  await f.command("remember", "note");
  assert.equal(f.saves, 0);
  assert.equal(f.queries.length, 0);
  assert.match(f.statuses.at(-1)!, /off/i);
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
  f.writeConfig(["global"]);
  // The new scope set is picked up at the next turn start (a prompt with no search terms recalls nothing).
  await f.emit("before_agent_start", { prompt: "the", systemPrompt: "" });
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

test("context preserves the off status", async () => {
  const f = fixture({ configured: false });
  await f.emit("session_start");
  const status = f.statuses.at(-1);
  await f.emit("context", { messages: [] });
  assert.equal(f.statuses.at(-1), status);
});

test("the retired /memory setup names the YAML keys that replaced it, and still checks", async () => {
  const f = fixture({ hasUI: false });
  await f.command("memory", "setup");
  const said = f.sent.map((m: any) => m.message.content).join("\n");
  assert.match(
    said,
    /engineering\.yaml.*memory\.hindsight.*enabled.*cli.*scopes/s,
    "no dialog: the answer must say which knobs configure memory now",
  );
  assert.doesNotMatch(said, /PI_OPENVIKING|PI_HINDSIGHT|hidden key/i);
});

test("headless automatic memory failures stay out of the transcript and log once per connection per day", async () => {
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
    assert.equal(logged.filter((t) => /unavailable/.test(t)).length, 1, "logged once");

    // A second headless run (a new `pi -p` process) on the same day and connection stays quiet.
    const second = fixture({ hasUI: false, noticeDir });
    second.fail(new Error("unavailable"));
    await second.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    assert.equal(second.sent.length, 0);
    assert.equal(logged.filter((t) => /unavailable/.test(t)).length, 1, "once per connection per day");

    const other = fixture({ hasUI: false, noticeDir, cli: "other-herdr-memory" });
    other.fail(new Error("unavailable"));
    await other.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    assert.equal(logged.filter((t) => /unavailable/.test(t)).length, 2, "a different connection logs");

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
    const f = fixture({ hasUI: false, stateDir, cli: "private-memory.example" });
    f.fail(new Error("unavailable"));
    await f.emit("before_agent_start", { prompt: "metric units", systemPrompt: "" });
    const dir = join(stateDir, "memory-notices");
    assert.equal(statSync(dir).mode & 0o777, 0o700, "notice dir is private to the user");
    const markers = readdirSync(dir);
    assert.equal(markers.length, 1);
    const marker = join(dir, markers[0]!);
    assert.equal(statSync(marker).mode & 0o777, 0o600, "marker is private to the user");
    assert.doesNotMatch(
      readFileSync(marker, "utf8"),
      /private-memory/,
      "the memory connection identity is not written in clear",
    );
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
      else reject(new HindsightError("rejected"));
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
      else reject(new HindsightError("rejected"));
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

for (const replacement of ["session", "credential"] as const) {
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
    else f.writeConfig(["global"]);
    await f.emit("before_agent_start", { prompt: "calibration" });
    const statuses = f.statuses.length;
    const notices = f.notices.length;
    finish();
    await save;
    assert.equal(f.statuses.length, statuses);
    assert.equal(f.notices.length, notices);
  });
}

test("late provider errors do not touch a session closed while the lookup was pending", async () => {
  for (const manual of [false, true]) {
    let reject!: (error: Error) => void;
    const f = fixture();
    // The retired setup dialog was one async hand-off at session start; the
    // equivalent risk now is a CLI recall/search still in flight at shutdown.
    if (manual)
      f.override(
        () =>
          new Promise((_resolve, rejectSearch) => {
            reject = rejectSearch;
          }),
      );
    else
      f.store.recallAll = () =>
        new Promise((_resolve, rejectRecall) => {
          reject = rejectRecall;
        });
    Object.assign(f.ctx, { mode: "tui" });
    const pending = manual ? f.command("memory", "calibration") : f.emit("session_start");
    await f.emit("session_shutdown");
    const statuses = f.statuses.length;
    const notices = f.notices.length;
    reject(new HindsightError("unavailable"));
    await pending;
    assert.equal(f.statuses.length, statuses);
    assert.equal(f.notices.length, notices);
  }
});

test("refused writes back off automatic search and a connection change bypasses the backoff", async () => {
  const f = fixture();
  f.fail(new HindsightError("rejected"));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  await f.emit("before_agent_start", { prompt: "different calibration", systemPrompt: "" });
  assert.equal(f.queries.length, 1, "a refused backend is not queried on each turn");
  assert.match(f.statuses.at(-1)!, /refused/);
  f.fail();
  f.writeConfig(["global"]);
  await f.store.store(record("calibration available"));
  await f.emit("before_agent_start", { prompt: "calibration", systemPrompt: "" });
  assert.equal(f.queries.length, 2);
  assert.match((await f.emit("context", { messages: [] })).messages[0].content, /available/);
});

test("temporary memory failures retry after backoff and explicit status bypasses it", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  // A CLI that timed out is a blip; one that is simply absent is not, and that
  // distinction is what the two backoff lengths are for.
  f.fail(new HindsightError("timeout"));
  const prompt = { prompt: "calibration", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  f.fail();
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 1);
  now += 61_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 2);
  f.fail(new HindsightError("rejected"));
  await f.emit("before_agent_start", { prompt: "different calibration", systemPrompt: "" });
  f.fail();
  await f.command("memory");
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 4, "explicit success clears cached recall and the failure backoff");
});

test("an absent herdr-memory CLI backs off longer than a blip", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  f.fail(new HindsightError("unavailable"));
  const prompt = { prompt: "calibration", systemPrompt: "" };
  await f.emit("before_agent_start", prompt);
  f.fail();
  now += 61_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 1, "a missing CLI is not re-probed every minute");
  now += 5 * 60_000;
  await f.emit("before_agent_start", prompt);
  assert.equal(f.queries.length, 2, "it is probed again once the longer backoff passes");
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

test("a slow herdr-memory call cannot hold startup or a prompt for seconds", async () => {
  // The real CLI provider, driven through an injected runner that answers far
  // outside the automatic budget: what is under test is the deadline, not HTTP.
  let requests = 0;
  const slowAgentDir = mkdtempSync(join(tmpdir(), "im-slow-"));
  writeFileSync(
    join(slowAgentDir, "engineering.yaml"),
    "memory:\n  hindsight:\n    enabled: true\n    timeout_ms: 1500\n",
  );
  const slowRunner: HindsightRunner = async () => {
    requests++;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      timer.unref?.(); // a test that timed out must not hold the process open
    });
    return { stdout: "{}", exitCode: 0 };
  };
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
      env: () => ({ PI_CODING_AGENT_DIR: slowAgentDir }),
      provider: (config) =>
        new HindsightDurableMemory({
          cli: config.cli,
          scopes: config.scopes,
          timeoutMs: config.timeoutMs,
          run: slowRunner,
        }),
    },
  );
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
});
