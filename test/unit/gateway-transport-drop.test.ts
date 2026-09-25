/**
 * "Error: terminated" — undici closing the connection mid-body.
 *
 * Every observed occurrence (13/13, 2026-09-22..25) coincided with a Fry
 * gateway restart whose 75s drain grace cut a long in-flight stream. pi-ai
 * reports it as an assistant message with stopReason "error", errorMessage
 * "terminated", usually no content and 0/0 usage. The operator's Pi retry is
 * off, so unless the interactive pump waits out the restart, the turn dies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TRANSPORT_DROP_WAITS_MS,
  decideTransientHandover,
  escalateSyntheticWait,
  gatewayHoldScope,
  isTransportDrop,
  parseGatewayWait,
  transportDropWait,
} from "../../src/gateway/signals.ts";
import { pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";
import { classifyError } from "../../src/guard/transient.ts";

const DROPS = [
  "terminated",
  "Error: terminated",
  "TypeError: terminated",
  "terminated: other side closed",
  "other side closed",
  "socket hang up",
  "read ECONNRESET",
  "ECONNRESET",
  "UND_ERR_SOCKET: other side closed",
  "fetch failed",
  "fetch failed: connect ECONNREFUSED 10.0.0.5:8081",
];

// ─── Signal ─────────────────────────────────────────────────────────────────

test("transport drop: undici/Node connection failures are recognised", () => {
  for (const text of DROPS) {
    assert.equal(isTransportDrop(text), true, text);
    const signal = transportDropWait({ text });
    assert.ok(signal, text);
    assert.equal(signal.retryable, true);
    assert.equal(signal.source, "transport-drop");
    assert.equal(signal.retryAfterMs, 2_000);
    assert.equal(gatewayHoldScope(signal), "caller", "one request's connection: no shared cooldown");
  }
  // A 2xx head (the stream was being served when it dropped) is still a drop.
  assert.ok(transportDropWait({ text: "terminated", status: 200 }));
});

test("transport drop: fails closed when a status or body envelope is present", () => {
  const negatives: Array<{ text: string; status?: number }> = [
    { text: "terminated", status: 503 },
    { text: "terminated", status: 401 },
    { text: "503: terminated" },
    { text: "Error: 429 terminated" },
    { text: 'terminated {"type":"inference_admission","reason":"queue_timeout"}' },
    { text: 'terminated {"error":{"message":"boom"}}' },
    { text: "terminated: inferweave_backpressure" },
    { text: "terminated (quota exceeded)" },
    // Prose that merely mentions a drop word is not a drop.
    { text: "The worker was terminated by policy" },
    { text: "Request was aborted" },
    { text: "This operation was aborted" },
  ];
  for (const n of negatives) assert.equal(transportDropWait(n), null, JSON.stringify(n));
});

test("transport drop: the generic gateway parser is unchanged (worker gateway layer does not claim it)", () => {
  for (const text of DROPS) assert.equal(parseGatewayWait({ text }), null, text);
});

test("transport drop: escalates 2s, 5s, 10s, 20s, 40s, then caps at 60s", () => {
  const base = transportDropWait({ text: "terminated" })!;
  const waits = [1, 2, 3, 4, 5, 6, 7, 12].map((a) => escalateSyntheticWait(base, a, 60_000).retryAfterMs);
  assert.deepEqual(waits, [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.deepEqual([...TRANSPORT_DROP_WAITS_MS], [2_000, 5_000, 10_000, 20_000, 40_000, 60_000]);
  // A lower configured cap wins.
  assert.equal(escalateSyntheticWait(base, 6, 30_000).retryAfterMs, 30_000);
});

// ─── Interactive pump ───────────────────────────────────────────────────────

interface Ev {
  type: string;
  text?: string;
  message?: Res;
  error?: Res;
}
interface Res {
  stopReason?: string;
  errorMessage?: string;
}
const start = (): Ev => ({ type: "start" });
const text = (t: string): Ev => ({ type: "text_delta", text: t });
const done = (): Ev => ({ type: "done", message: { stopReason: "stop" } });
const failed = (msg: string): Ev => ({ type: "error", error: { stopReason: "error", errorMessage: msg } });
const aborted = (msg?: string): Ev => ({
  type: "error",
  error: { stopReason: "aborted", ...(msg ? { errorMessage: msg } : {}) },
});

function scripted(attempts: Ev[][]) {
  let opened = 0;
  const open = () => {
    const events = attempts[Math.min(opened, attempts.length - 1)] ?? [];
    opened++;
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: async (): Promise<Res> => terminal?.message ?? terminal?.error ?? {},
    };
  };
  return {
    open,
    get opened() {
      return opened;
    },
  };
}
function sink() {
  const pushed: Ev[] = [];
  let ended: Res | undefined;
  return {
    pushed,
    get ended() {
      return ended;
    },
    push: (e: Ev) => pushed.push(e),
    end: (r?: Res) => {
      ended = r;
    },
  };
}

test("pump: [start, error(terminated)] is retried with exactly one start, on a caller hold", async () => {
  const s = scripted([
    [start(), failed("terminated")],
    [start(), failed("Error: terminated")],
    [start(), text("recovered"), done()],
  ]);
  const out = sink();
  const holds: Array<{ ms: number; scope: string }> = [];
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: async (signal) => {
      holds.push({ ms: signal.retryAfterMs, scope: gatewayHoldScope(signal) });
    },
  });
  assert.equal(s.opened, 3);
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "text_delta", "done"],
  );
  assert.deepEqual(holds, [
    { ms: 2_000, scope: "caller" },
    { ms: 5_000, scope: "caller" },
  ]);
  assert.equal(outcome.settled, "ok");
});

test("pump: a drop with no start at all (connection refused mid-restart) is retried too", async () => {
  const s = scripted([[failed("fetch failed")], [start(), text("ok"), done()]]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: async () => {} });
  assert.equal(s.opened, 2);
});

test("pump: after a visible text delta a drop is never retried", async () => {
  const s = scripted([
    [start(), text("partial"), failed("terminated")],
    [start(), text("again"), done()],
  ]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: async () => {} });
  assert.equal(s.opened, 1);
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "text_delta", "error"],
  );
  assert.equal(out.ended?.errorMessage, "terminated");
});

test("pump: a user abort is never retried, however it is worded", async () => {
  // pi-ai marks an aborted request stopReason "aborted".
  for (const attempt of [[start(), aborted("terminated")], [aborted()]]) {
    const s = scripted([attempt, [start(), text("no"), done()]]);
    const out = sink();
    const outcome = await pumpWithGatewayRetry(s.open, out, { hold: async () => {} });
    assert.equal(s.opened, 1);
    assert.equal(outcome.settled, "aborted");
  }
  // And an "error" that lands after Escape (the turn's signal is aborted).
  const controller = new AbortController();
  controller.abort();
  const s = scripted([
    [start(), failed("terminated")],
    [start(), text("no"), done()],
  ]);
  const outcome = await pumpWithGatewayRetry(s.open, sink(), { hold: async () => {}, signal: controller.signal });
  assert.equal(s.opened, 1);
  assert.equal(outcome.settled, "aborted");
});

test("pump: an error status captured for the attempt means it is not a transport drop", async () => {
  const s = scripted([
    [start(), failed("terminated")],
    [start(), text("no"), done()],
  ]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: async () => {}, response: () => ({ status: 401 }) });
  assert.equal(s.opened, 1);
  assert.equal(out.ended?.stopReason, "error");
});

test("pump: the chain stays inside the elapsed budget (a restart outlasting it ends the turn)", async () => {
  let clock = 0;
  const s = scripted([[start(), failed("terminated")]]);
  const out = sink();
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: async (signal) => {
      clock += signal.retryAfterMs;
    },
    now: () => clock,
    maxElapsedMs: 30_000,
    maxAttempts: 20,
  });
  // 2 + 5 + 10 = 17s held; the next 20s wait would overrun 30s.
  assert.equal(outcome.holds, 3);
  assert.equal(out.ended?.errorMessage, "terminated");
});

// ─── Workers ────────────────────────────────────────────────────────────────

test("workers: a thrown transport drop is a retryable network failure, owned by the transient layer", () => {
  for (const text of DROPS) {
    const cls = classifyError(new Error(text));
    assert.equal(cls.retryable, true, text);
    assert.equal(cls.category, "network", text);
    // After the transient loop gave up, the gateway layer does not take it again.
    assert.equal(decideTransientHandover(text, 0, 3).action, "not-gateway", text);
  }
  // Fail closed like the pump: a permanent status is not a drop.
  assert.equal(classifyError(Object.assign(new Error("terminated"), { status: 401 })).retryable, false);
  assert.equal(classifyError(new Error("The worker was terminated by policy")).retryable, false);
});
