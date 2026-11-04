/**
 * Diagnostics must not write to the terminal themselves.
 *
 * The bug: `process.stderr.write("[gateway-admission] " + JSON.stringify(event))`
 * is right in a worker and destructive inside Pi. The TUI owns the screen and
 * composites the side panel into a frame it drew; a raw write lands underneath
 * all of it, does not wrap, runs straight through the panel, and scrolls the
 * terminal by a row the TUI does not know about — which is why the frame
 * beneath came back shifted, drawing `extensions/index.ts` as `xtensions/index.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAdmissionEvent, formatDuration } from "../../src/gateway/admissionNotice.ts";
import {
  type TelemetryNotice,
  currentTelemetrySink,
  emitTelemetry,
  setTelemetrySink,
  stderrForced,
} from "../../src/telemetry/sink.ts";

const SIGNAL = {
  retryAfterMs: 30_000,
  retryable: true,
  source: "body" as const,
  status: 429,
  reason: "queue_timeout",
  type: "inference_admission",
  scope: "agent",
  activeLimit: 4,
  queued: 31,
  queueLimit: 100,
};

test("sink: an installed sink receives the notice and stderr is left alone", () => {
  const seen: TelemetryNotice[] = [];
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    writes.push(String(chunk));
    return true;
  };
  const restore = setTelemetrySink((notice) => seen.push(notice));
  try {
    emitTelemetry({ level: "warning", text: "gateway busy" }, {});
  } finally {
    restore();
    (process.stderr as { write: unknown }).write = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.text, "gateway busy");
  assert.deepEqual(writes, [], "a surface is installed, so nothing may be painted under it");
});

test("sink: with no sink the line still reaches stderr", () => {
  // Workers, scripts and CI have no TUI to corrupt, and their stderr is the
  // only record there is. Removing the write entirely would have traded a
  // rendering bug for a silent one.
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    emitTelemetry({ level: "warning", text: "gateway busy" }, {});
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? "", /\[warning\] gateway busy/);
});

test("sink: a sink that throws does not take down the work it was reporting on", () => {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    writes.push(String(chunk));
    return true;
  };
  const restore = setTelemetrySink(() => {
    throw new Error("session torn down");
  });
  try {
    assert.doesNotThrow(() => emitTelemetry({ level: "error", text: "boom" }, {}));
  } finally {
    restore();
    (process.stderr as { write: unknown }).write = original;
  }
  assert.equal(writes.length, 1, "a failed sink falls back rather than swallowing the line");
});

test("sink: uninstalling out of order does not clear a newer sink", () => {
  const first: string[] = [];
  const second: string[] = [];
  const restoreFirst = setTelemetrySink((n) => first.push(n.text));
  const restoreSecond = setTelemetrySink((n) => second.push(n.text));
  restoreFirst(); // the older session tears down first
  emitTelemetry({ level: "info", text: "still live" }, {});
  restoreSecond();
  assert.deepEqual(second, ["still live"]);
  assert.deepEqual(first, []);
});

test("sink: an uninstalled sink cannot be restored by someone else's teardown", () => {
  // This is the assertion the test above was missing, and a fresh-context
  // review caught the gap: it exercised the exact failing sequence and then
  // checked only which sink received the notice, so it passed while the bug
  // was live. Install A, install B, uninstall A, uninstall B — and the old
  // single-slot implementation left the process pointed at A, a sink belonging
  // to a session that had already gone.
  const a = () => {};
  const b = () => {};
  const restoreA = setTelemetrySink(a);
  const restoreB = setTelemetrySink(b);
  restoreA();
  assert.equal(currentTelemetrySink(), b, "the newer surface is still in force");
  restoreB();
  assert.equal(currentTelemetrySink(), undefined, "a removed sink must stay removed");
});

test("sink: uninstalling twice is a no-op, not a removal of someone else's sink", () => {
  const a = () => {};
  const b = () => {};
  const restoreA = setTelemetrySink(a);
  restoreA();
  restoreA();
  const restoreB = setTelemetrySink(b);
  restoreA();
  assert.equal(currentTelemetrySink(), b, "a stale uninstaller may not reach into a later registration");
  restoreB();
});

test("sink: the newest surface wins while it is installed", () => {
  const seen: string[] = [];
  const restoreA = setTelemetrySink(() => seen.push("a"));
  const restoreB = setTelemetrySink(() => seen.push("b"));
  emitTelemetry({ level: "info", text: "x" }, {});
  restoreB();
  emitTelemetry({ level: "info", text: "x" }, {});
  restoreA();
  assert.deepEqual(seen, ["b", "a"], "removing the top hands control back to the one beneath it");
});

test("sink: PI_TELEMETRY_STDERR restores the raw line alongside the notice", () => {
  const seen: string[] = [];
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    writes.push(String(chunk));
    return true;
  };
  const restore = setTelemetrySink((n) => seen.push(n.text));
  try {
    assert.equal(stderrForced({ PI_TELEMETRY_STDERR: "1" }), true);
    emitTelemetry({ level: "warning", text: "gateway busy", detail: { a: 1 } }, { PI_TELEMETRY_STDERR: "1" });
  } finally {
    restore();
    (process.stderr as { write: unknown }).write = original;
  }
  assert.equal(seen.length, 1);
  assert.match(writes[0] ?? "", /\{"a":1\}/, "the structured detail is what the escape hatch is for");
});

test("notice: the production 429 becomes one readable sentence", () => {
  const notice = describeAdmissionEvent({ type: "wait", waitMs: 30_000, signal: SIGNAL, concurrency: 4 });
  assert.equal(notice.level, "warning", "a stalled session is not an FYI");
  assert.equal(notice.text, "Gateway capacity wait — waiting 30s · queue timeout · 31 of 100 queued · 4 admitted");
  assert.ok(!notice.text.includes("{"), "no JSON reaches a human-facing line");
  assert.ok(notice.text.length < 90, "it must fit a panelled terminal without wrapping into a wall");
  assert.deepEqual((notice.detail as { type: string }).type, "wait", "the structure is kept, just not shown");
});

test("notice: a wait the gateway barely described still reads as a sentence", () => {
  const notice = describeAdmissionEvent({
    type: "wait",
    waitMs: 5_000,
    signal: { retryAfterMs: 5_000, retryable: true, source: "default", status: 503 },
    concurrency: 3,
  });
  assert.equal(notice.text, "Gateway retry wait — waiting 5s · HTTP 503");
});

test("notice: a clamp warns and a relax does not", () => {
  const clamp = describeAdmissionEvent({ type: "clamp", concurrency: 2, previous: 4, signal: SIGNAL });
  assert.equal(clamp.level, "warning");
  assert.equal(clamp.text, "gateway busy — concurrency 4 → 2 · queue timeout");

  const relax = describeAdmissionEvent({ type: "relax", concurrency: 4, previous: 2 });
  assert.equal(relax.level, "info", "good news must not be coloured like a problem");
  assert.equal(relax.text, "gateway recovered — concurrency 2 → 4");
});

test("notice: durations read the way a person would say them", () => {
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(59_400), "59s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(-1), "0s", "a negative wait is a bug upstream, not a crash here");
});

test("notice: a memory outage names the client, never its configuration", async () => {
  // The client (or a proxy in front of it) may repeat a credential in its own
  // error text, and this warning is SHOWN to the operator rather than buried in
  // stderr — a surface is exactly where a token must not be repeated back.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { registerInteractiveMemory } = await import("../../src/blackhole/interactiveMemory.ts");
  const { makeHerdrStub } = await import("../support/herdrMemoryStub.ts");
  const dir = mkdtempSync(join(tmpdir(), "memory-leak-"));
  const noticeDir = mkdtempSync(join(tmpdir(), "memory-leak-notices-"));
  const stub = makeHerdrStub(dir, "leaky");
  const seen: string[] = [];
  const restore = setTelemetrySink((n) => seen.push(n.text));
  try {
    const events = new Map<string, (event: never, ctx: never) => unknown>();
    const pi = {
      registerCommand: () => undefined,
      on: (name: string, fn: (event: never, ctx: never) => unknown) => events.set(name, fn),
      sendMessage: () => undefined,
    };
    const ctx = { cwd: "/tmp/project", hasUI: false, ui: { setStatus: () => undefined, notify: () => undefined } };
    registerInteractiveMemory(pi as never, {
      env: () => ({ PI_HINDSIGHT_ENABLED: "1", PI_HINDSIGHT_CLI: stub.cli }),
      setup: async () => undefined,
      headlessNoticeDir: noticeDir,
    });
    await events.get("session_start")?.({} as never, ctx as never);
    await events.get("before_agent_start")?.({ prompt: "metric units", systemPrompt: "" } as never, ctx as never);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(noticeDir, { recursive: true, force: true });
  }
  assert.equal(seen.length, 1, "a headless outage is logged once");
  assert.ok(!seen[0]?.includes("s3cr3t-token"), "the credential must not reach the surface");
  assert.ok(!seen[0]?.includes("user:"), "nor the userinfo around it");
  assert.ok(!seen[0]?.includes("8443"), "nor the endpoint it was talking to");
  assert.match(seen[0] ?? "", /herdr-memory reported a failure/, "the canned message still identifies the client");
});
