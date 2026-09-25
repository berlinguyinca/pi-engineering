/**
 * A linked (peer-gateway) stream cut mid-response.
 *
 * InferWeave reports it AFTER a 200 head, as an SSE error frame
 * (`inferweave_backpressure`, reason `upstream_transport_error`, scope `model`,
 * `retry_after_ms: 1000`). The OpenAI SDK flattens that frame into an APIError
 * with no status whose message is only the human sentence, so everything the
 * runtime sees is the text below — in either the old or the new gateway
 * wording. Before this fix every layer treated it as permanent or unknown, and
 * the interactive pump could never retry it because pi-ai pushes `start` as
 * soon as the 200 arrives.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
  decideGatewayRetry,
  isAccountWideRefusal,
  isGatewayAdmissionRefusal,
  isGatewayLinkCut,
  parseGatewayWait,
} from "../../src/gateway/signals.ts";
import { pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";
import { classifyError } from "../../src/guard/transient.ts";
import { classifyInfraError } from "../../src/resilience/classify.ts";

const OLD_WORDING =
  "The route serving this model ended before the response did; the response is incomplete. Retry the request: it is routed afresh.";
const NEW_WORDING =
  "Connection lost: the route serving this model ended before the response did; the response is incomplete. Please retry your request: it is routed afresh.";
const WORDINGS = [OLD_WORDING, NEW_WORDING, `Error: ${OLD_WORDING}`, "upstream_transport_error"];

// ─── Signal parsing ─────────────────────────────────────────────────────────

test("link cut: every wording is recognised as a retryable, model-scoped gateway wait", () => {
  for (const text of WORDINGS) {
    assert.equal(isGatewayLinkCut(text), true, text);
    const signal = parseGatewayWait({ text });
    assert.ok(signal, `recognised: ${text}`);
    assert.equal(signal.retryable, true);
    assert.equal(signal.retryAfterMs, 1_000);
    assert.equal(signal.source, "default");
    assert.equal(signal.reason, "upstream_transport_error");
    assert.equal(signal.scope, "model");
  }
});

test("link cut: never parks the whole process and is not an admission refusal", () => {
  const signal = parseGatewayWait({ text: NEW_WORDING });
  assert.ok(signal);
  assert.equal(isAccountWideRefusal(signal), false, "one model's link, not the account");
  assert.equal(isGatewayAdmissionRefusal(NEW_WORDING), false, "no body-advertised wait to honour exactly");
  const decision = decideGatewayRetry(OLD_WORDING, 0, 3);
  assert.equal(decision.action, "wait");
});

test("link cut: matching is case-insensitive and unrelated errors stay unrecognised", () => {
  assert.equal(isGatewayLinkCut(OLD_WORDING.toUpperCase()), true);
  assert.equal(isGatewayLinkCut("The route was not found"), false);
  assert.equal(isGatewayLinkCut(undefined), false);
  assert.equal(parseGatewayWait({ text: "The route was not found" }), null);
});

// ─── Worker-side classifiers ────────────────────────────────────────────────

test("link cut: the transient guard retries it as a network failure", () => {
  for (const text of WORDINGS) {
    const cls = classifyError(new Error(text));
    assert.equal(cls.retryable, true, text);
    assert.equal(cls.category, "network", text);
  }
});

test("link cut: mission resilience classifies it explicitly, not via the unclassified fallback", () => {
  for (const text of WORDINGS) {
    const cls = classifyInfraError(new Error(text));
    assert.equal(cls.category, "TRANSIENT_INFRASTRUCTURE", text);
    assert.equal(cls.retryable, true);
    assert.notEqual(cls.reason, "unclassified error");
  }
});

test("link cut: Pi's own retry covers the new wording (cuts after partial output)", () => {
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: NEW_WORDING } as never), true);
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
  let endCalls = 0;
  return {
    pushed,
    get ended() {
      return ended;
    },
    get endCalls() {
      return endCalls;
    },
    push: (e: Ev) => pushed.push(e),
    end: (r?: Res) => {
      endCalls++;
      ended = r;
    },
  };
}

const noWait = async (): Promise<void> => {};

test("link cut: a cut after `start` but before any token is retried, with exactly one start", async () => {
  const s = scripted([
    [start(), failed(NEW_WORDING)],
    [start(), text("recovered"), done()],
  ]);
  const out = sink();
  const holds: number[] = [];
  let progress = 0;
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: async (signal) => {
      holds.push(signal.retryAfterMs);
    },
    onProgress: () => progress++,
  });

  assert.equal(s.opened, 2, "nothing visible reached the transcript, so the cut is retried");
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "text_delta", "done"],
  );
  assert.equal(out.ended?.stopReason, "stop");
  assert.equal(out.endCalls, 1);
  assert.deepEqual(holds, [1_000], "the gateway's 1s hint is the first wait");
  assert.equal(progress, 1, "progress fires once, for the attempt that produced output");
  assert.equal(outcome.settled, "ok");
});

test("link cut: a withheld start is released ahead of a clean done with no output", async () => {
  const s = scripted([[start(), done()]]);
  const out = sink();
  let progress = 0;
  await pumpWithGatewayRetry(s.open, out, { hold: noWait, onProgress: () => progress++ });

  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "done"],
  );
  assert.equal(progress, 1);
});

test("link cut: once a token is out the cut is not retried (Pi's own retry owns it)", async () => {
  const s = scripted([
    [start(), text("partial"), failed(NEW_WORDING)],
    [start(), text("again"), done()],
  ]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: noWait });

  assert.equal(s.opened, 1);
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "text_delta", "error"],
  );
  assert.equal(out.ended?.stopReason, "error");
});

test("link cut: when the budget is spent the final attempt's start precedes its error, once", async () => {
  const s = scripted([[start(), failed(OLD_WORDING)]]);
  const out = sink();
  let progress = 0;
  const outcome = await pumpWithGatewayRetry(s.open, out, {
    hold: noWait,
    maxAttempts: 2,
    onProgress: () => progress++,
  });

  assert.equal(s.opened, 2);
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "error"],
  );
  assert.equal(out.endCalls, 1);
  assert.equal(progress, 0, "a failed attempt is not the gateway serving us");
  assert.equal(outcome.settled, "error");
});

test("link cut: a non-gateway failure after start is forwarded as before", async () => {
  const s = scripted([[start(), failed("400 invalid request")]]);
  const out = sink();
  await pumpWithGatewayRetry(s.open, out, { hold: noWait });

  assert.equal(s.opened, 1);
  assert.deepEqual(
    out.pushed.map((e) => e.type),
    ["start", "error"],
  );
});
