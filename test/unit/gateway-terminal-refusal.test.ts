import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isTerminalGatewayRefusal, registerTerminalRefusalGuard } from "../../src/gateway/terminalRefusalGuard.ts";

const safe = {
  type: "inferweave_backpressure",
  reason: "capacity_unavailable",
  retryable: true,
  replay_safe: true,
  request_state: "not_started",
  action: "backoff",
  action_code: "IW-ACT-BACKOFF",
  retry_after_ms: 20000,
};
const refusal = {
  ...safe,
  action: "do_not_retry",
  action_code: "IW-ACT-DO-NOT-RETRY",
  retryable: false,
  replay_safe: false,
};

for (const [name, fields] of Object.entries({
  "explicit retry denial": { retryable: false },
  "explicit unsafe replay": { replay_safe: false },
  "terminal action": { action: "do_not_retry" },
  "terminal action code": { action_code: "IW-ACT-DO-NOT-RETRY" },
  "input must change": { action: "reduce_input" },
  "credentials must change": { action_code: "IW-ACT-AUTHENTICATE" },
  "already dispatched": { request_state: "dispatched" },
  "already streaming": { request_state: "streaming" },
  "unknown dispatch state": { request_state: "unknown" },
})) {
  test(`recognizes ${name} even alongside a misleading transient status`, () => {
    assert.equal(isTerminalGatewayRefusal(`503: ${JSON.stringify({ ...safe, ...fields })}`), true);
  });
}

for (const [name, body] of Object.entries({
  "top level": refusal,
  "error envelope": { error: refusal },
  "detail envelope": { detail: refusal },
  "nested detail error": { detail: { error: refusal } },
  "legacy tagged explicit denial": { type: "inference_admission", retryable: false, reason: "queue_timeout" },
})) {
  test(`recognizes ${name}`, () => {
    assert.equal(isTerminalGatewayRefusal(`503: ${JSON.stringify(body)}`), true);
  });
}

// The payload the operator saw on the Hive/Farm workers: a terminal reason
// (do_not_retry) on an admission envelope with a default retry_after_ms but
// none of the explicit replay-contract fields. It is terminal even though it
// looks like a transient 503 wait — the old guard missed exactly this shape.
for (const [name, body] of Object.entries({
  "terminal reason do_not_retry with a default wait (operator payload)": {
    active: 1,
    active_limit: 1,
    error: "invalid_upstream_response",
    message: "inference admission: do_not_retry",
    provider: "qwen3.8-27b",
    reason: "do_not_retry",
    retry_after_ms: 60_000,
    scope: "worker",
    type: "inference_admission",
  },
  "terminal reason fix_request": { type: "inference_admission", reason: "fix_request", retry_after_ms: 30_000 },
  "terminal reason in a detail envelope": {
    detail: { type: "inference_admission", reason: "do_not_retry", retry_after_ms: 60_000 },
  },
})) {
  test(`recognizes ${name} (terminal reason, no explicit contract fields)`, () => {
    assert.equal(isTerminalGatewayRefusal(`503: ${JSON.stringify(body)}`), true);
  });
}

// A retryable reason on the same envelope shape stays a wait, not terminal.
for (const [name, body] of Object.entries({
  "retryable reason no_workers": { type: "inference_admission", reason: "no_workers", retry_after_ms: 30_000 },
  "retryable reason queue_timeout": { type: "inference_admission", reason: "queue_timeout", retry_after_ms: 30_000 },
})) {
  test(`leaves ${name} to existing retry policy (terminal-reason check stays negative)`, () => {
    assert.equal(isTerminalGatewayRefusal(`503: ${JSON.stringify(body)}`), false);
  });
}

for (const [name, text] of Object.entries({
  "bare 503": "503 overloaded, retry later",
  "unstructured do_not_retry wording": "503 do_not_retry inferweave_backpressure replay_safe:false",
  "invalid JSON": '503: {"type":"inferweave_backpressure","retryable":false',
  "unrelated provider payload": '503: {"type":"other","retryable":false}',
  "untagged JSON": '503: {"retryable":false}',
  "safe backoff": `503: ${JSON.stringify(safe)}`,
  "safe alternate": `503: ${JSON.stringify({ ...safe, action: "retry_alternate", action_code: "IW-ACT-RETRY-ALTERNATE" })}`,
  "legacy retryable admission": '429: {"type":"inference_admission","reason":"queue_timeout"}',
  "incomplete new envelope": '503: {"type":"inferweave_backpressure"}',
  "mistyped flags": '503: {"type":"inferweave_backpressure","retryable":"false","replay_safe":"false"}',
})) {
  test(`leaves ${name} to existing retry policy`, () => assert.equal(isTerminalGatewayRefusal(text), false));
}

test("only failed assistant messages abort, synchronously once, without changing messages or awaiting idle", () => {
  const handlers: Array<(event: { message: unknown }, ctx: { abort(): Promise<void> }) => unknown> = [];
  const pi = { on: (_event: string, handler: (typeof handlers)[number]) => handlers.push(handler) };
  registerTerminalRefusalGuard(pi as unknown as Pick<ExtensionAPI, "on">);
  registerTerminalRefusalGuard(pi as unknown as Pick<ExtensionAPI, "on">);
  let aborts = 0;
  const ctx = {
    abort: () => {
      aborts++;
      return new Promise<void>(() => {});
    },
  };
  for (const role of ["user", "toolResult", "custom"]) {
    for (const handler of handlers)
      handler({ message: { role, stopReason: "error", errorMessage: `503: ${JSON.stringify(refusal)}` } }, ctx);
  }
  for (const stopReason of ["stop", "aborted", "length"]) {
    for (const handler of handlers)
      handler({ message: { role: "assistant", stopReason, errorMessage: `503: ${JSON.stringify(refusal)}` } }, ctx);
  }
  assert.equal(aborts, 0);
  const message = Object.freeze({
    role: "assistant",
    stopReason: "error",
    errorMessage: `503: ${JSON.stringify(refusal)}`,
  });
  const before = structuredClone(message);
  for (const handler of [...handlers, ...handlers]) assert.equal(handler({ message }, ctx), undefined);
  assert.equal(aborts, 1);
  assert.deepEqual(message, before);
  const later = { ...message };
  for (const handler of handlers) handler({ message: later }, ctx);
  assert.equal(aborts, 2, "a later run with a new message is independently guarded");
});
