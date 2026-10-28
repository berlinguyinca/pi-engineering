/**
 * Pi -> Herdr agent-inspector feed (src/runtime/herdr/InspectorFeed.ts).
 * Contract: herdr-engineering docs/contracts/agent-inspector-event.md.
 *
 * A fake Pi (`on` / `events.on` recorders) and a fake sink/fetch: no network, no timers
 * beyond the unref'd flush timer. Tests run serially.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";
import { loadHostConfig } from "../../src/runtime/herdr/HostConfig.ts";
import {
  INSPECTOR_LIMITS,
  type InspectorEvent,
  type InspectorFeedHandle,
  type InspectorFeedOptions,
  attachInspectorFeed,
  attachInspectorFeedFromHost,
  headTail,
  inspectorConfigFromHost,
  isSensitivePath,
  parseTestOutput,
} from "../../src/runtime/herdr/InspectorFeed.ts";

type Handler = (event: any, ctx: any) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  bus = new Map<string, Array<(d: unknown) => void>>();
  events = {
    on: (name: string, h: (d: unknown) => void) => {
      this.bus.set(name, [...(this.bus.get(name) ?? []), h]);
      return () => {};
    },
  };
  on(name: string, h: Handler) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), h]);
    return () => {};
  }
  fire(name: string, event: any = {}, ctx: any = CTX) {
    for (const h of this.handlers.get(name) ?? []) h({ type: name, ...event }, ctx);
  }
  sub(data: unknown) {
    for (const h of this.bus.get("subagents:tool_call") ?? []) h(data);
  }
}

const MODEL = { id: "m1", provider: "p", api: "anthropic-messages", reasoning: true };
const CTX = {
  cwd: "/work/repo",
  model: MODEL,
  sessionManager: { getSessionId: () => "pi-session-1" },
  getContextUsage: () => ({ tokens: 1000, contextWindow: 4000, percent: 25 }),
};

class Sink {
  batches: Array<{ id: string; events: InspectorEvent[] }> = [];
  ok = true;
  throws = false;
  async emitBatch(id: string, events: InspectorEvent[]) {
    if (this.throws) throw new Error("boom");
    this.batches.push({ id, events });
    return this.ok;
  }
  get all(): InspectorEvent[] {
    return this.batches.flatMap((b) => b.events);
  }
  kind(k: string): InspectorEvent[] {
    return this.all.filter((e) => e.kind === k);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function drain(h: InspectorFeedHandle, max = 200) {
  for (let i = 0; i < max && (h.feed.size > 0 || i === 0); i++) {
    h.flush();
    await tick();
    await tick();
  }
}

let seq = 0;
function setup(over: Partial<InspectorFeedOptions> = {}) {
  const pi = new FakePi();
  const sink = new Sink();
  const handle = attachInspectorFeed(pi as never, {
    ingest: sink,
    sessionId: `pane-uniq-${++seq}`,
    flushMs: 10_000, // flush explicitly, never by timer
    env: {},
    ...over,
  });
  return { pi, sink, handle };
}

function toolRun(pi: FakePi, id: string, tool: string, args: any, result: string, isError = false, input = args) {
  pi.fire("tool_call", { toolName: tool, toolCallId: id, input });
  pi.fire("tool_execution_start", { toolCallId: id, toolName: tool, args });
  pi.fire("tool_execution_end", {
    toolCallId: id,
    toolName: tool,
    result: { content: [{ type: "text", text: result }] },
    isError,
  });
}

// ── central host config wiring ──

function hostHome(values: object | null): {
  home: string;
  fetch: typeof fetch;
  ingest: Array<{ url: string; headers: any; body: any }>;
} {
  const home = mkdtempSync(join(tmpdir(), "inspcfg-"));
  mkdirSync(join(home, ".config", "herdr-engineering"), { recursive: true });
  writeFileSync(
    join(home, ".config", "herdr-engineering", "host.json"),
    JSON.stringify({ control_plane_url: "http://cp.lan/", host_id: "h1", token: "tok" }),
  );
  const ingest: Array<{ url: string; headers: any; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/v1/fleet/config"))
      return new Response(JSON.stringify({ revision: "r1", values: values ?? {} }));
    if (url.endsWith("/applied")) return new Response("{}");
    ingest.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
    return new Response("{}");
  }) as unknown as typeof fetch;
  return { home, fetch: f, ingest };
}

test("config enables the feed with NO env vars; URL and key come from the host config; posts inspector.batch", async () => {
  const h = hostHome({ inspector: { enabled: true }, ingest: { api_key: "ing-key" } });
  const pi = new FakePi();
  const handle = await attachInspectorFeedFromHost(pi as never, {
    hostConfig: { home: h.home, fetch: h.fetch },
    fetch: h.fetch,
    env: { HERDR_PANE_ID: "pane-env" },
  });
  assert.ok(handle);
  pi.fire("session_start", { reason: "startup" });
  await drain(handle);
  const posts = h.ingest.filter((i: any) => i.body.entity_type === "inspector");
  assert.equal(posts[0]?.url, "http://cp.lan/api/v1/ingest");
  assert.equal(posts[0]?.headers["x-api-key"], "ing-key");
  assert.equal(posts[0]?.body.entity_type, "inspector");
  assert.equal(posts[0]?.body.entity_id, "pane-env");
  assert.equal(posts[0]?.body.event_type, "inspector.batch");
  // the runtime report rides the same ingest as a session record, not as an inspector batch
  const runtime = h.ingest.find((i: any) => i.body.entity_type === "session");
  assert.equal(runtime?.body.entity_id, "pane-env");
  assert.equal(runtime?.body.payload.runtime.runtime_kind, "standard-pi");
  handle.dispose();
});

test("disposing a host-configured inspector stops its periodic runtime reporter", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = hostHome({ inspector: { enabled: true } });
  const pi = new FakePi();
  const handle = await attachInspectorFeedFromHost(pi as never, {
    hostConfig: { home: h.home, fetch: h.fetch },
    fetch: h.fetch,
    env: { HERDR_PANE_ID: "disposed-runtime-reporter" },
  });
  assert.ok(handle);
  const reports = () => h.ingest.filter((row) => row.body.entity_type === "session").length;
  await tick();
  assert.equal(reports(), 1);
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(reports(), 2, "periodic reporting is active before disposal");
  handle.dispose();
  t.mock.timers.tick(120_000);
  await tick();
  assert.equal(reports(), 2, "the returned handle must own and stop its reporter");
});

test("normal shutdown still emits ended and stops an attached runtime reporter", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = hostHome({ inspector: { enabled: true } });
  const pi = new FakePi();
  const handle = await attachInspectorFeedFromHost(pi as never, {
    hostConfig: { home: h.home, fetch: h.fetch },
    fetch: h.fetch,
    env: { HERDR_PANE_ID: "normal-shutdown-runtime-reporter" },
  });
  assert.ok(handle);
  try {
    pi.fire("session_start", { reason: "startup" });
    await drain(handle);
    pi.fire("session_shutdown");
    await drain(handle);
    const phases = h.ingest
      .flatMap((row) => row.body.payload?.events ?? [])
      .filter((event) => event.kind === "lifecycle")
      .map((event) => event.phase);
    assert.deepEqual(phases, ["started", "ended"]);
    const reports = () => h.ingest.filter((row) => row.body.entity_type === "session").length;
    const before = reports();
    t.mock.timers.tick(120_000);
    await tick();
    assert.equal(reports(), before);
  } finally {
    handle.dispose();
  }
});

test("stays off when inspector.enabled is false, absent, or not boolean true", async () => {
  for (const values of [
    { inspector: { enabled: false } },
    {},
    { inspector: { reasoning: "full" } },
    { inspector: { enabled: "true" } },
    { inspector: { enabled: 1 } },
  ]) {
    const h = hostHome(values);
    const pi = new FakePi();
    const handle = await attachInspectorFeedFromHost(pi as never, {
      hostConfig: { home: h.home, fetch: h.fetch },
      fetch: h.fetch,
    });
    assert.equal(handle, null);
    assert.equal(pi.handlers.size, 0, "no handlers subscribed");
    assert.equal(pi.bus.size, 0);
    await tick();
    assert.equal(h.ingest.length, 0);
  }
});

test("reasoning comes from inspector.reasoning (off|summary|full, default off)", async () => {
  const cfgFor = async (inspector: object) => {
    const h = hostHome({ inspector });
    return inspectorConfigFromHost(await loadHostConfig({ home: h.home, fetch: h.fetch }));
  };
  assert.equal((await cfgFor({ enabled: true })).reasoning, "off");
  assert.equal((await cfgFor({ enabled: true, reasoning: "summary" })).reasoning, "summary");
  assert.equal((await cfgFor({ enabled: true, reasoning: "full" })).reasoning, "full");
  assert.equal((await cfgFor({ enabled: true, reasoning: "bogus" })).reasoning, "off");
  const on = await cfgFor({ enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.url, "http://cp.lan");
  assert.equal((await cfgFor({ enabled: false })).enabled, false);
});

test("agent.api_key is preferred over ingest.api_key for the feed", async () => {
  const h = hostHome({ inspector: { enabled: true }, agent: { api_key: "agent-key" }, ingest: { api_key: "ing-key" } });
  const pi = new FakePi();
  const handle = await attachInspectorFeedFromHost(pi as never, {
    hostConfig: { home: h.home, fetch: h.fetch },
    fetch: h.fetch,
  });
  assert.ok(handle);
  pi.fire("session_start", { reason: "startup" });
  await drain(handle);
  assert.equal(h.ingest[0]?.headers["x-api-key"], "agent-key");
  handle.dispose();
});

test("an empty api key in the host config sends NO x-api-key header to ingest", async () => {
  const h = hostHome({ inspector: { enabled: true }, agent: { api_key: "" }, ingest: { api_key: "" } });
  const pi = new FakePi();
  const handle = await attachInspectorFeedFromHost(pi as never, {
    hostConfig: { home: h.home, fetch: h.fetch },
    fetch: h.fetch,
  });
  assert.ok(handle);
  pi.fire("session_start", { reason: "startup" });
  await drain(handle);
  assert.ok(h.ingest.length > 0);
  assert.ok(!Object.keys(h.ingest[0]!.headers).some((k) => k.toLowerCase() === "x-api-key"));
  handle.dispose();
});

test("legacy env vars have NO effect: PI_INSPECTOR_FEED / HERDR_CP_URL / PI_INSPECTOR_REASONING / HERDR_CP_API_KEY", async () => {
  const saved = { ...process.env };
  process.env.PI_INSPECTOR_FEED = "1";
  process.env.HERDR_CP_URL = "http://legacy.example";
  process.env.PI_INSPECTOR_REASONING = "full";
  process.env.HERDR_CP_API_KEY = "legacy-key";
  try {
    // config disabled -> off despite env
    const off = hostHome({ inspector: { enabled: false } });
    const pi = new FakePi();
    assert.equal(
      await attachInspectorFeedFromHost(pi as never, {
        hostConfig: { home: off.home, fetch: off.fetch },
        fetch: off.fetch,
      }),
      null,
    );
    assert.equal(pi.handlers.size, 0);
    // config enabled -> host URL/key/reasoning, never the env ones
    const on = hostHome({ inspector: { enabled: true }, ingest: { api_key: "ing-key" } });
    const pi2 = new FakePi();
    const handle = await attachInspectorFeedFromHost(pi2 as never, {
      hostConfig: { home: on.home, fetch: on.fetch },
      fetch: on.fetch,
    });
    assert.ok(handle);
    pi2.fire("session_start", { reason: "startup" });
    await drain(handle);
    assert.equal(on.ingest[0]?.url, "http://cp.lan/api/v1/ingest");
    assert.equal(on.ingest[0]?.headers["x-api-key"], "ing-key");
    handle.dispose();
    // no host.json at all -> unavailable despite env
    const empty = mkdtempSync(join(tmpdir(), "inspcfg-"));
    await assert.rejects(
      attachInspectorFeedFromHost(new FakePi() as never, { hostConfig: { home: empty, fetch: on.fetch } }),
      /host config unavailable/,
    );
  } finally {
    for (const k of ["PI_INSPECTOR_FEED", "HERDR_CP_URL", "PI_INSPECTOR_REASONING", "HERDR_CP_API_KEY"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("ControlPlaneIngest.emitBatch is best-effort: fetch failure resolves false, never throws", async () => {
  const cp = new ControlPlaneIngest({
    url: "http://x",
    fetch: (async () => {
      throw new Error("down");
    }) as typeof fetch,
  });
  assert.equal(await cp.emitBatch("s", [{ kind: "lifecycle" }]), false);
});

test("lifecycle + capabilities + association on start; resumed session is restored; reload is restarted; shutdown ends", async () => {
  const a = setup({ sessionId: "pane-7" });
  a.pi.fire("session_start", { reason: "startup" });
  a.pi.fire("session_shutdown", { reason: "quit" });
  await drain(a.handle);
  assert.deepEqual(
    a.sink.kind("lifecycle").map((e) => e.phase),
    ["started", "ended"],
  );
  assert.equal(a.sink.kind("capabilities")[0]?.model, "m1");
  assert.equal(a.sink.kind("association")[0]?.worktree, "/work/repo");
  assert.equal(a.sink.batches[0]?.id, "pane-7");

  // Restart: a second instance with the same session id after a resume.
  const b = setup({ sessionId: "pane-7" });
  b.pi.fire("session_start", { reason: "resume" });
  await drain(b.handle);
  assert.equal(b.sink.kind("lifecycle")[0]?.phase, "restored");

  // Same process starting the same id again without resume is a restart, not a fresh start.
  const c = setup({ sessionId: undefined });
  const ctx = { ...CTX, sessionManager: { getSessionId: () => "lifecycle-pi-session" } };
  c.pi.fire("session_start", { reason: "startup" }, ctx);
  c.pi.fire("session_start", { reason: "reload" }, ctx);
  await drain(c.handle);
  assert.equal(c.sink.batches[0]?.id, "lifecycle-pi-session", "falls back to Pi's session id without HERDR_PANE_ID");
  assert.deepEqual(
    c.sink.kind("lifecycle").map((e) => e.phase),
    ["started", "restarted"],
  );
});

test("branch association is resolved off the hot path via the injected resolver", async () => {
  const { pi, sink, handle } = setup({ resolveGit: async () => ({ branch: "feat/x" }) });
  pi.fire("session_start", { reason: "startup" });
  await tick();
  await drain(handle);
  assert.ok(sink.kind("association").some((e) => e.branch === "feat/x" && e.worktree === "/work/repo"));
  handle.associate({ mission_id: "M-1", handoff_id: "H-1" });
  await drain(handle);
  assert.ok(sink.kind("association").some((e) => e.mission_id === "M-1" && e.handoff_id === "H-1"));
});

test("messages map to message events; usage carries tokens and context from contextReading", async () => {
  const { pi, sink, handle } = setup();
  pi.fire("session_start", { reason: "startup" });
  pi.fire("message_start", { message: { role: "user", timestamp: 1, content: "hello" } });
  pi.fire("message_end", {
    message: {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "hi there" }],
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, reasoning: 2, totalTokens: 15 },
    },
  });
  await drain(handle);
  const msgs = sink.kind("message");
  assert.deepEqual(
    msgs.map((m) => [m.role, m.text]),
    [
      ["user", "hello"],
      ["assistant", "hi there"],
    ],
  );
  const u = sink.kind("usage")[0]!;
  assert.deepEqual(
    [
      u.input_tokens,
      u.output_tokens,
      u.cache_read_tokens,
      u.reasoning_tokens,
      u.context_tokens,
      u.context_window,
      u.model,
    ],
    [10, 5, 3, 2, 1000, 4000, "m1"],
  );
});

test("tool phases, args preview, duration, exit code; long output is head+tail truncated", async () => {
  const { pi, sink, handle } = setup();
  toolRun(pi, "c1", "bash", { command: "echo hi" }, "x".repeat(40_000));
  await drain(handle);
  const tools = sink.kind("tool");
  assert.deepEqual(
    tools.map((t) => t.phase),
    ["start", "end"],
  );
  assert.match(String(tools[0]?.args_preview), /echo hi/);
  const end = tools[1]!;
  assert.equal(end.is_error, false);
  assert.equal(end.exit_code, 0);
  assert.equal(end.truncated, true);
  assert.ok(String(end.output).length <= INSPECTOR_LIMITS.toolOutput);
  assert.ok(typeof end.duration_ms === "number");
});

test("tool updates coalesce per call id to the latest 4KB tail", async () => {
  const { pi, sink, handle } = setup();
  pi.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "make" } });
  for (let i = 0; i < 100; i++) {
    pi.fire("tool_execution_update", {
      toolCallId: "c1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: `line ${i}\n`.repeat(2000) }] },
    });
  }
  assert.equal(handle.feed.size, 2, "start + ONE coalesced update");
  await drain(handle);
  const updates = sink.kind("tool").filter((t) => t.phase === "update");
  assert.equal(updates.length, 1);
  assert.ok(String(updates[0]?.output).length <= INSPECTOR_LIMITS.toolChunk);
  assert.match(String(updates[0]?.output), /line 99/);
});

test("edit emits a file event with the unified diff and counts; write/read are mapped; sensitive reads are hinted", async () => {
  const { pi, sink, handle } = setup();
  const diff = "--- a\n+++ b\n@@\n-old\n+new1\n+new2\n";
  pi.fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "src/a.ts", edits: [] } });
  pi.fire("tool_result", {
    toolName: "edit",
    toolCallId: "e1",
    input: { path: "src/a.ts" },
    details: { diff },
    isError: false,
    content: [],
  });
  pi.fire("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "src/new.ts", content: "x" } });
  pi.fire("tool_result", {
    toolName: "write",
    toolCallId: "w1",
    input: { path: "src/new.ts" },
    isError: false,
    content: [],
  });
  pi.fire("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "/app/.env" } });
  pi.fire("tool_call", { toolName: "read", toolCallId: "r2", input: { path: "/home/u/keys/server.pem" } });
  pi.fire("tool_call", { toolName: "read", toolCallId: "r3", input: { path: "src/ok.ts" } });
  await drain(handle);
  const files = sink.kind("file");
  const edit = files.find((f) => f.op === "edit")!;
  assert.equal(edit.path, "src/a.ts");
  assert.equal(edit.diff, diff);
  assert.equal(edit.additions, 2);
  assert.equal(edit.deletions, 1);
  assert.equal(files.find((f) => f.op === "write")?.path, "src/new.ts");
  assert.equal(files.find((f) => f.path === "/app/.env")?.sensitive, true);
  assert.equal(files.find((f) => String(f.path).endsWith(".pem"))?.sensitive, true);
  assert.equal(files.find((f) => f.path === "src/ok.ts")?.sensitive, undefined);
  assert.ok(
    isSensitivePath("/x/.ssh/id_rsa") && isSensitivePath(".env.production") && !isSensitivePath("environment.ts"),
  );
});

test("diffs are capped at 64KB", async () => {
  const { pi, sink, handle } = setup();
  const diff = `+${"a".repeat(200_000)}\n`;
  pi.fire("tool_result", {
    toolName: "edit",
    toolCallId: "e1",
    input: { path: "big.ts" },
    details: { diff },
    isError: false,
    content: [],
  });
  await drain(handle);
  assert.ok(String(sink.kind("file")[0]?.diff).length <= INSPECTOR_LIMITS.diff);
});

test("test runs: start/end with parsed counts and failing names; unknown format never invents counts", async () => {
  const { pi, sink, handle } = setup();
  toolRun(
    pi,
    "t1",
    "bash",
    { command: "node --test test/unit/x.test.ts" },
    "✖ adds numbers (1.2ms)\nℹ tests 5\nℹ pass 4\nℹ fail 1\nℹ skipped 0\n",
    true,
  );
  toolRun(pi, "t2", "bash", { command: "npm test" }, "all good, no recognisable summary here");
  toolRun(pi, "t3", "bash", { command: "ls -la" }, "total 0");
  await drain(handle);
  const tests = sink.kind("test");
  assert.deepEqual(
    tests.map((t) => [t.run_id, t.phase]),
    [
      ["t1", "start"],
      ["t1", "end"],
      ["t2", "start"],
      ["t2", "end"],
    ],
  );
  const t1 = tests[1]!;
  assert.deepEqual([t1.passed, t1.failed, t1.skipped], [4, 1, 0]);
  assert.deepEqual(t1.failures, [{ name: "adds numbers" }]);
  const t2 = tests[3]!;
  assert.equal(t2.passed, undefined);
  assert.equal(t2.failed, undefined);
  assert.equal(t2.failures, undefined);
  assert.equal(t2.exit_code, 0, "exit code is real (success => 0), never counts");
});

test("test output parsers: jest, vitest, pytest, cargo; garbage => {}", () => {
  assert.deepEqual(parseTestOutput("Tests:       2 failed, 1 skipped, 8 passed, 11 total\n"), {
    passed: 8,
    failed: 2,
    skipped: 1,
  });
  assert.deepEqual(parseTestOutput(" Tests  1 failed | 9 passed (10)\n"), { passed: 9, failed: 1 });
  const py = parseTestOutput(
    "FAILED tests/test_a.py::test_x - assert 1\n==== 1 failed, 3 passed, 2 skipped in 0.5s ====\n",
  );
  assert.deepEqual([py.passed, py.failed, py.skipped, py.failures], [3, 1, 2, [{ name: "tests/test_a.py::test_x" }]]);
  const cargo = parseTestOutput(
    "test a::b ... FAILED\ntest result: FAILED. 3 passed; 1 failed; 0 ignored\ntest result: ok. 2 passed; 0 failed; 1 ignored\n",
  );
  assert.deepEqual([cargo.passed, cargo.failed, cargo.skipped], [5, 1, 1]);
  assert.deepEqual(parseTestOutput("hello world"), {});
});

test("model switch emits a model event, with fallback reason when the host says so, and re-declares capabilities", async () => {
  let reason = undefined as "fallback" | undefined;
  const { pi, sink, handle } = setup({ modelReason: () => reason });
  pi.fire("session_start", { reason: "startup" });
  pi.fire("model_select", {
    model: { id: "m2", provider: "q", api: "x", reasoning: false },
    previousModel: MODEL,
    source: "set",
  });
  reason = "fallback";
  pi.fire("model_select", { model: { id: "m3", provider: "q", api: "x" }, previousModel: { id: "m2" }, source: "set" });
  await drain(handle);
  const models = sink.kind("model");
  assert.deepEqual(
    models.map((m) => [m.model, m.previous_model, m.reason]),
    [
      ["m2", "m1", "switch"],
      ["m3", "m2", "fallback"],
    ],
  );
  assert.deepEqual(
    sink.kind("capabilities").map((c) => c.model),
    ["m1", "m2", "m3"],
  );
});

function thinking(pi: FakePi, text: string) {
  pi.fire("message_start", { message: { role: "assistant", timestamp: 9 } });
  pi.fire("message_update", { message: { timestamp: 9 }, assistantMessageEvent: { type: "thinking_start" } });
  pi.fire("message_update", {
    message: { timestamp: 9 },
    assistantMessageEvent: { type: "thinking_delta", delta: text },
  });
  pi.fire("message_update", {
    message: { timestamp: 9 },
    assistantMessageEvent: { type: "thinking_end", content: text },
  });
}

test("reasoning: never sent when config is off (default), even if the model streams thinking", async () => {
  const { pi, sink, handle } = setup();
  pi.fire("session_start", { reason: "startup" });
  thinking(pi, "secret chain of thought");
  await drain(handle);
  assert.equal(sink.kind("reasoning").length, 0);
  assert.ok(!JSON.stringify(sink.all).includes("secret chain"));
  // Capability is still declared truthfully: thinking text WAS delivered by Pi.
  assert.equal(sink.kind("capabilities").at(-1)?.reasoning, "full");
});

test("reasoning: capability stays 'none' and nothing is sent when no thinking events ever arrive (even if enabled)", async () => {
  const { pi, sink, handle } = setup({ reasoning: "full" });
  pi.fire("session_start", { reason: "startup" });
  pi.fire("message_start", { message: { role: "assistant", timestamp: 1 } });
  pi.fire("message_end", { message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "answer" }] } });
  await drain(handle);
  assert.equal(sink.kind("reasoning").length, 0);
  assert.deepEqual(new Set(sink.kind("capabilities").map((c) => c.reasoning)), new Set(["none"]));
});

test("reasoning: sent only when explicitly enabled AND really received, with the matching source", async () => {
  const { pi, sink, handle } = setup({ reasoning: "full" });
  pi.fire("session_start", { reason: "startup" });
  thinking(pi, "step one");
  await drain(handle);
  const r = sink.kind("reasoning");
  assert.equal(r.length, 1);
  assert.equal(r[0]?.text, "step one");
  assert.equal(r[0]?.source, "provider_raw");

  const s = setup({ reasoning: "summary" });
  s.pi.fire("session_start", { reason: "startup" }, { ...CTX, model: { ...MODEL, api: "openai-responses" } });
  thinking(s.pi, "summary text");
  await drain(s.handle);
  assert.equal(s.sink.kind("reasoning")[0]?.source, "provider_summary");
  assert.equal(s.sink.kind("capabilities").at(-1)?.reasoning, "summary");
});

test("subagent tool calls carry agent_id / parent_agent_id and file events", async () => {
  const { pi, sink, handle } = setup();
  pi.sub({ toolName: "edit", input: { path: "src/z.ts" }, agent: "reviewer" });
  pi.sub({ toolName: "read", input: { path: ".env" }, agent: "reviewer" });
  pi.sub(undefined);
  await drain(handle);
  const tools = sink.kind("tool");
  assert.equal(tools.length, 2);
  assert.ok(tools.every((t) => t.agent_id === "reviewer" && t.parent_agent_id === "main"));
  assert.equal(sink.kind("file").find((f) => f.path === ".env")?.sensitive, true);
});

test("bounded queue under a 10k flood: <= cap, tool ends and lifecycle preserved, drops counted and reported", async () => {
  const { pi, sink, handle } = setup({ queueCap: 500 });
  pi.fire("session_start", { reason: "startup" });
  const ends = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const id = `c${i}`;
    pi.fire("tool_execution_update", {
      toolCallId: id,
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "x" }] },
    });
    if (i % 100 === 0) {
      pi.fire("tool_execution_end", {
        toolCallId: id,
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      });
      ends.add(id);
    }
    assert.ok(handle.feed.size <= 500, `queue exceeded cap at ${i}: ${handle.feed.size}`);
  }
  pi.fire("session_shutdown", { reason: "quit" });
  await drain(handle);
  const sentEnds = new Set(
    sink
      .kind("tool")
      .filter((t) => t.phase === "end")
      .map((t) => String(t.call_id)),
  );
  for (const id of ends) assert.ok(sentEnds.has(id), `tool end ${id} was dropped`);
  assert.ok(sink.kind("lifecycle").some((l) => l.phase === "started"));
  assert.ok(sink.kind("lifecycle").some((l) => l.phase === "ended"));
  assert.ok(handle.feed.stats.droppedTotal > 9000);
  const reported = sink.kind("lifecycle").reduce((n, l) => n + (typeof l.dropped === "number" ? l.dropped : 0), 0);
  assert.ok(reported > 0, "dropped count is reported to the server");
  for (const b of sink.batches) assert.ok(b.events.length <= 100, "batch size <= 100");
});

test("critical events are never evicted by lower-priority ones", async () => {
  const { pi, sink, handle } = setup({ queueCap: 20 });
  for (let i = 0; i < 15; i++) {
    pi.fire("tool_execution_end", { toolCallId: `e${i}`, toolName: "bash", result: "r", isError: false });
  }
  for (let i = 0; i < 500; i++) pi.fire("message_start", { message: { role: "user", timestamp: i, content: "m" } });
  await drain(handle);
  const ends = sink.kind("tool").filter((t) => t.phase === "end");
  assert.equal(ends.length, 15);
});

test("a failing / throwing / rejecting sink never throws into Pi; batch is dropped, backoff applies, no retry storm", async () => {
  const sink = new Sink();
  sink.ok = false;
  let t = 1_000;
  const pi = new FakePi();
  const handle = attachInspectorFeed(pi as never, {
    ingest: sink,
    sessionId: "p",
    flushMs: 10_000,
    env: {},
    now: () => t,
  });
  assert.doesNotThrow(() => pi.fire("session_start", { reason: "startup" }));
  await drain(handle, 1);
  assert.equal(sink.batches.length, 1);
  assert.equal(handle.feed.stats.failedBatches, 1);
  pi.fire("message_start", { message: { role: "user", timestamp: 1, content: "again" } });
  await drain(handle, 3); // still inside backoff window: nothing is sent
  assert.equal(sink.batches.length, 1, "no retry during backoff");
  t += 60_000;
  sink.ok = true;
  await drain(handle, 3);
  assert.equal(sink.batches.length, 2);
  assert.ok(
    sink.batches[1]!.events.some((e) => e.kind === "lifecycle" && Number(e.dropped) > 0),
    "loss reported",
  );

  sink.throws = true;
  t += 60_000;
  pi.fire("message_start", { message: { role: "user", timestamp: 2, content: "x" } });
  assert.doesNotThrow(() => handle.flush());
  await tick();
  await tick();
  // Malformed Pi events never throw either.
  assert.doesNotThrow(() => {
    pi.fire("tool_execution_end", undefined as never, undefined as never);
    pi.fire("message_update", { assistantMessageEvent: null });
    pi.fire("tool_call", null as never);
  });
  handle.dispose();
});

test("headTail keeps head and tail and marks the cut", () => {
  const r = headTail(`${"A".repeat(100)}${"B".repeat(100)}`, 100);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 100 + 32);
  assert.ok(r.text.startsWith("AAA") && r.text.endsWith("BBB") && r.text.includes("truncated"));
});

test("micro-benchmark: 10k tool updates are processed well under a second", () => {
  const { pi, handle } = setup();
  const result = { content: [{ type: "text", text: "progress ".repeat(50) }] };
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    pi.fire("tool_execution_update", { toolCallId: `c${i % 20}`, toolName: "bash", partialResult: result });
  }
  const ms = performance.now() - start;
  assert.ok(handle.feed.size <= 500);
  assert.ok(ms < 1000, `10k updates took ${ms.toFixed(1)}ms`);
  handle.dispose();
});

test("an ingest apiKey is sent as X-API-Key and never otherwise", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchStub = (async (_url: unknown, init: { headers: Record<string, string> }) => {
    seen.push(init.headers);
    return { ok: true } as Response;
  }) as unknown as typeof globalThis.fetch;
  const withKey = new ControlPlaneIngest({ url: "http://cp", apiKey: " k1 ", fetch: fetchStub });
  const without = new ControlPlaneIngest({ url: "http://cp", fetch: fetchStub });
  await withKey.emitBatch("s", []);
  await without.emitBatch("s", []);
  assert.equal(seen[0]?.["x-api-key"], "k1");
  assert.equal(seen[1]?.["x-api-key"], undefined);
});
