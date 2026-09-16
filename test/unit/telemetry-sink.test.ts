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
import { type TelemetryNotice, emitTelemetry, setTelemetrySink, stderrForced } from "../../src/telemetry/sink.ts";

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
  restoreFirst(); // the older session tears down last
  emitTelemetry({ level: "info", text: "still live" }, {});
  restoreSecond();
  assert.deepEqual(second, ["still live"]);
  assert.deepEqual(first, []);
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
  assert.equal(notice.text, "gateway busy — waiting 30s · queue timeout · 31 of 100 queued · 4 admitted");
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
  assert.equal(notice.text, "gateway busy — waiting 5s · HTTP 503");
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
