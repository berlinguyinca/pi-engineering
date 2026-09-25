/**
 * A pre-dispatch InferWeave refusal flattened to its bare code.
 *
 * The hive gateway sends refusals whose `message` is the stable code itself
 * (server.rs: `_ => error.code().into()`). Relayed over a link after the head
 * grace, the refusal becomes an SSE error after a 200, and the OpenAI SDK
 * flattens it to that message — so pi-ai's errorMessage is just
 * "routing_snapshot_expired" (observed 2026-09-25T18:01Z; the interactive turn
 * ended). Newer gateways say "<what> (<code>); please retry your request."
 * Both shapes must be waited out and replayed while nothing was delivered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
  DEFAULT_WAIT_MS,
  decideTransientHandover,
  escalateSyntheticWait,
  gatewayFailureMarker,
  gatewayHoldScope,
  isAccountWideRefusal,
  isFlattenedInferWeaveRefusal,
  isGatewayAdmissionRefusal,
  parseGatewayWait,
} from "../../src/gateway/signals.ts";
import { pumpWithGatewayRetry } from "../../src/gateway/streamRetry.ts";
import { classifyError } from "../../src/guard/transient.ts";

const CODES = [
  "routing_snapshot_expired",
  "capacity_unavailable",
  "model_activating",
  "queue_timeout",
  "queue_deadline_exceeded",
  "queue_limit_reached",
  "request_not_queueable",
];

const RUST_WORDING = "No fresh route for model glm5.3 (routing_snapshot_expired); please retry your request.";

// ─── Recognition ────────────────────────────────────────────────────────────

test("bare codes: every retryable pre-dispatch code is recognised, bare or prefixed", () => {
  for (const code of CODES) {
    for (const text of [code, `Error: ${code}`, `503 ${code}`, `Error: 503: ${code}`, `  ${code}.  `]) {
      assert.equal(isFlattenedInferWeaveRefusal(text), true, text);
      const signal = parseGatewayWait({ text });
      assert.ok(signal, text);
      assert.equal(signal.retryable, true, text);
      assert.equal(signal.scope, "model", text);
      assert.equal(signal.reason, code, text);
    }
  }
});

test("bare codes: the new Rust wording is recognised and matches Pi's own retry too", () => {
  assert.equal(isFlattenedInferWeaveRefusal(RUST_WORDING), true);
  assert.equal(
    isFlattenedInferWeaveRefusal("Model m is activating (model_activating); Please retry your request."),
    true,
  );
  assert.equal(parseGatewayWait({ text: RUST_WORDING })?.reason, "routing_snapshot_expired");
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: RUST_WORDING } as never), true);
});

test("bare codes: every flattened code escalates from the default wait — none is a fixed hint", () => {
  // A stale snapshot persists until the controller republishes, and the 1s the
  // gateway advertises is its generic retry_after for every 408/429/5xx. A flat
  // 1s would spend the whole attempt budget in ~8s.
  for (const code of CODES) {
    const signal = parseGatewayWait({ text: code });
    assert.equal(signal?.retryAfterMs, DEFAULT_WAIT_MS, code);
    assert.equal(signal?.source, "default", code);
    assert.equal(signal?.flattened, true, code);
  }
});

test("bare codes: an observed Retry-After is honoured exactly instead of the default", () => {
  const withStatus = parseGatewayWait({ text: "model_activating", status: 429, headers: { "retry-after": "30" } });
  assert.equal(withStatus?.retryAfterMs, 30_000);
  assert.equal(withStatus?.source, "header");
  assert.equal(withStatus?.reason, "model_activating");

  const noStatus = parseGatewayWait({ text: "model_activating", headers: { "retry-after-ms": "2500" } });
  assert.equal(noStatus?.retryAfterMs, 2_500);
  assert.equal(noStatus?.source, "header");
  assert.equal(noStatus?.flattened, true);
});

test("bare codes: with an HTTP status the refusal is not flattened and keeps the shared model hold", () => {
  for (const input of [{ text: "429: queue_limit_reached" }, { text: "model_activating", status: 503 }]) {
    const signal = parseGatewayWait(input);
    assert.ok(signal, input.text);
    assert.equal(signal.retryable, true);
    assert.equal(signal.flattened, undefined, "only a genuine post-200 bare code is flattened");
    assert.equal(signal.scope, "model");
    assert.equal(gatewayHoldScope(signal), "shared");
    assert.equal(isAccountWideRefusal(signal), false);
  }
});

test("worker gateway path: flattened waits escalate and exhaustion is a transient marker", () => {
  const flat = parseGatewayWait({ text: "model_activating" });
  assert.ok(flat);
  const waits = [1, 2, 3, 4, 5, 6].map((n) => escalateSyntheticWait(flat, n, 60_000).retryAfterMs);
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.equal(gatewayFailureMarker(flat), "transient:server_unavailable", "same resilience window as the thrown path");

  const header = parseGatewayWait({ text: "model_activating", headers: { "retry-after": "30" } });
  assert.ok(header);
  assert.equal(escalateSyntheticWait(header, 4, 60_000).retryAfterMs, 30_000, "an advertised wait never escalates");

  const admission = parseGatewayWait({
    text: '429: {"reason":"queue_timeout","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}',
  });
  assert.ok(admission);
  assert.equal(gatewayFailureMarker(admission), "gateway:queue_timeout");
});

test("bare codes: held by the caller only, never an account-wide or admission refusal", () => {
  for (const code of CODES) {
    const signal = parseGatewayWait({ text: code });
    assert.ok(signal);
    assert.equal(gatewayHoldScope(signal), "caller", code);
    assert.equal(isAccountWideRefusal(signal), false, code);
    assert.equal(isGatewayAdmissionRefusal(code), false, code);
  }
});

test("bare codes: prose that merely mentions a code, or an unknown code, does not match", () => {
  const negatives = [
    "The capacity_unavailable counter increased during the run",
    "routing_snapshot_expired happened earlier today (no action needed)",
    "Model m is not served here (model_not_found).",
    "Model m is not served here (model_not_found); please retry your request.",
    "model_not_found",
    "caller_hard_quota",
    "routing_snapshot_expired_v2",
  ];
  for (const text of negatives) assert.equal(isFlattenedInferWeaveRefusal(text), false, text);
});

test("bare codes: fail closed behind permanent statuses, quota wording and any envelope", () => {
  const negatives = [
    "401 capacity_unavailable",
    "Error: 403: routing_snapshot_expired",
    "Out of quota (capacity_unavailable); please retry your request. quota exceeded",
    '{"error":{"type":"inferweave_backpressure","code":"routing_snapshot_expired"',
    "inference_admission (capacity_unavailable); please retry your request.",
  ];
  for (const text of negatives) {
    assert.equal(isFlattenedInferWeaveRefusal(text), false, text);
    assert.notEqual(parseGatewayWait({ text })?.flattened, true, text);
  }
  assert.notEqual(parseGatewayWait({ text: "capacity_unavailable", status: 401 })?.retryable, true);
});

// ─── Single ownership with the worker's transient layer ─────────────────────

test("transient: the routing rule honours a permanent status in the text", () => {
  for (const text of ["404 routing_snapshot_expired", "Error: 403: capacity_unavailable", "401 retry_alternate"]) {
    assert.equal(classifyError(new Error(text)).retryable, false, text);
  }
  assert.equal(classifyError({ status: 404, message: "capacity_unavailable" }).retryable, false);
});

test("bare codes: the transient layer retries them and the handover leaves them alone", () => {
  for (const text of [...CODES, RUST_WORDING]) {
    const cls = classifyError(new Error(text));
    assert.equal(cls.retryable, true, text);
    assert.equal(cls.category, "server_unavailable", text);
    assert.equal(decideTransientHandover(text, 0, 3).action, "not-gateway", text);
  }
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

test("bare codes: [start, error(routing_snapshot_expired)] is retried with exactly one start", async () => {
  const attempts: Ev[][] = [
    [{ type: "start" }, { type: "error", error: { stopReason: "error", errorMessage: "routing_snapshot_expired" } }],
    [{ type: "start" }, { type: "text_delta", text: "ok" }, { type: "done", message: { stopReason: "stop" } }],
  ];
  let opened = 0;
  const open = () => {
    const events = attempts[Math.min(opened++, attempts.length - 1)] ?? [];
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: async (): Promise<Res> => terminal?.message ?? terminal?.error ?? {},
    };
  };
  const pushed: Ev[] = [];
  let ended: Res | undefined;
  const holds: number[] = [];
  await pumpWithGatewayRetry(
    open,
    {
      push: (e: Ev) => pushed.push(e),
      end: (r?: Res) => {
        ended = r;
      },
    },
    {
      hold: async (signal) => {
        holds.push(signal.retryAfterMs);
      },
    },
  );

  assert.equal(opened, 2);
  assert.deepEqual(
    pushed.map((e) => e.type),
    ["start", "text_delta", "done"],
  );
  assert.equal(ended?.stopReason, "stop");
  assert.deepEqual(holds, [DEFAULT_WAIT_MS]);
});
