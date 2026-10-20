import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkingStatusController } from "../../src/status/working.ts";

function harness() {
  let now = 100_000;
  let message: string | undefined;
  let lines: string[] | undefined;
  const controller = new WorkingStatusController(
    {
      setWorkingMessage: (text) => {
        message = text;
      },
      setWidget: (_key, text) => {
        lines = text;
      },
    },
    () => now,
  );
  controller.onModelSelect({ provider: "metabolomics", id: "qwen" });
  return {
    controller,
    advance: (ms: number) => {
      now += ms;
      controller.tick();
    },
    text: () => [message, ...(lines ?? [])].join("\n"),
    message: () => message,
    lines: () => lines,
  };
}

test("gateway countdown stays visible while awaiting a retry response, then restores tool activity", () => {
  const h = harness();
  try {
    h.controller.onAgentStart();
    h.controller.onToolEvent({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    h.controller.onGatewayEvent({
      type: "wait",
      waitMs: 30_000,
      concurrency: 4,
      signal: {
        retryAfterMs: 30_000,
        retryable: true,
        source: "body",
        reason: "queue_timeout",
        queued: 6,
        queueLimit: 12,
        activeLimit: 4,
        provider: "metabolomics",
        model: "qwen",
        waitingSinceMs: 0,
      },
    });
    assert.match(h.message()!, /Gateway capacity/);
    assert.match(h.text(), /metabolomics\/qwen/);
    assert.match(h.text(), /6\/12 queued.*4 admitted/);
    assert.match(h.text(), /retry in 30s/);
    h.advance(20_000);
    assert.match(h.text(), /retry in 10s/);
    assert.match(h.text(), /waiting for 2m 00s/);
    h.advance(10_000);
    assert.match(h.message()!, /Awaiting gateway response/);
    h.controller.onModelProgress();
    assert.match(h.message()!, /npm test/);
    assert.equal(h.lines(), undefined);
    h.controller.onAgentEnd();
    assert.equal(h.message(), undefined);
  } finally {
    h.controller.dispose();
  }
});

test("transport error is not mislabeled as busy capacity, and cancel clears all UI", () => {
  const h = harness();
  try {
    h.controller.onAgentStart();
    h.controller.onGatewayEvent({
      type: "wait",
      waitMs: 5_000,
      concurrency: 4,
      signal: {
        retryAfterMs: 5_000,
        retryable: true,
        source: "transport-drop",
        reason: "upstream_transport_error",
        model: "qwen",
        provider: "metabolomics",
      },
    });
    assert.match(h.message()!, /Gateway transport/);
    assert.doesNotMatch(h.text(), /capacity|busy/);
    h.controller.onAgentEnd();
    h.advance(10_000);
    assert.equal(h.message(), undefined);
    assert.equal(h.lines(), undefined);
  } finally {
    h.controller.dispose();
  }
});

test("normal model/tool activity shows ages and safe labels, survives concurrent tool completion", () => {
  const h = harness();
  try {
    h.controller.onAgentStart();
    assert.match(h.message()!, /Waiting for model.*metabolomics\/qwen/);
    assert.match(h.message()!, /no output yet/);
    h.advance(90_000);
    assert.match(h.message()!, /no output yet for 1m 30s/);
    h.controller.onToolEvent({
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "read",
      args: { path: "/repo/src/main.ts" },
    });
    h.controller.onToolEvent({
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "bash",
      args: { command: "npm test --token secret-value" },
    });
    assert.match(h.message()!, /npm test/);
    assert.doesNotMatch(h.message()!, /secret-value|--token/);
    h.controller.onToolEvent({ type: "tool_execution_end", toolCallId: "b", toolName: "bash" });
    assert.match(h.message()!, /main.ts/);
    h.controller.onToolEvent({ type: "tool_execution_end", toolCallId: "a", toolName: "read" });
    assert.match(h.message()!, /Waiting for model/);
    h.controller.onMessageUpdate({ assistantMessageEvent: { type: "thinking_delta" } });
    assert.match(h.message()!, /Model thinking/);
    h.controller.onMessageUpdate({ assistantMessageEvent: { type: "text_delta" } });
    assert.match(h.message()!, /Model responding/);
  } finally {
    h.controller.dispose();
  }
});

test("unrelated model waits and events after disposal do not overwrite the working indicator", () => {
  const h = harness();
  h.controller.onAgentStart();
  h.controller.onGatewayEvent({
    type: "wait",
    waitMs: 5_000,
    concurrency: 4,
    signal: {
      retryAfterMs: 5_000,
      retryable: true,
      source: "body",
      provider: "other",
      model: "qwen",
    },
  });
  assert.match(h.message()!, /Waiting for model/);
  h.controller.dispose();
  h.controller.onAgentStart();
  h.controller.onToolEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "bash" });
  h.advance(5_000);
  assert.equal(h.message(), undefined);
});

test("one-second timer advances countdown and total age without incoming events and stops on disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
  let message: string | undefined;
  let writes = 0;
  const controller = new WorkingStatusController({
    setWorkingMessage: (text) => {
      message = text;
      writes++;
    },
    setWidget: () => {},
  });
  controller.onAgentStart();
  controller.onGatewayEvent({
    type: "wait",
    waitMs: 5_000,
    concurrency: 4,
    signal: {
      retryAfterMs: 5_000,
      retryable: true,
      source: "body",
      reason: "queue_timeout",
      waitingSinceMs: 90_000,
    },
  });
  t.mock.timers.tick(1_000);
  assert.match(message!, /retry in 4s.*waiting for 11s/);
  controller.dispose();
  const afterDispose = writes;
  t.mock.timers.tick(10_000);
  assert.equal(writes, afterDispose);
  assert.equal(message, undefined);
});

test("foreground tool start and output clear a gateway wait even without assistant deltas", () => {
  const h = harness();
  const wait = () =>
    h.controller.onGatewayEvent({
      type: "wait",
      waitMs: 5_000,
      concurrency: 4,
      signal: {
        retryAfterMs: 5_000,
        retryable: true,
        source: "body",
        reason: "queue_timeout",
        provider: "metabolomics",
        model: "qwen",
      },
    });
  try {
    h.controller.onAgentStart();
    wait();
    h.controller.onToolEvent({
      type: "tool_execution_start",
      toolCallId: "one",
      toolName: "bash",
      args: { command: "npm test" },
    });
    assert.match(h.message()!, /npm test/);
    assert.doesNotMatch(h.message()!, /Gateway/);
    assert.equal(h.lines(), undefined);
    wait();
    h.controller.onToolEvent({ type: "tool_execution_update", toolCallId: "one", toolName: "bash" });
    assert.match(h.message()!, /npm test/);
    assert.equal(h.lines(), undefined);
    wait();
    h.controller.onToolEvent({ type: "tool_execution_end", toolCallId: "one", toolName: "bash" });
    assert.match(h.message()!, /Waiting for model/);
    assert.equal(h.lines(), undefined);
  } finally {
    h.controller.dispose();
  }
});

test("a torn-down UI cannot fail a provider observation or leave its interval alive", () => {
  const controller = new WorkingStatusController({
    setWorkingMessage: () => {
      throw new Error("inactive UI");
    },
    setWidget: () => {
      throw new Error("inactive UI");
    },
  });
  assert.doesNotThrow(() => {
    controller.onAgentStart();
    controller.onGatewayEvent({
      type: "wait",
      waitMs: 5_000,
      concurrency: 4,
      signal: {
        retryAfterMs: 5_000,
        retryable: true,
        source: "body",
        reason: "queue_timeout",
      },
    });
    controller.tick();
    controller.dispose();
  });
});
