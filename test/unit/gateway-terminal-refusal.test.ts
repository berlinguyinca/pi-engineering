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
