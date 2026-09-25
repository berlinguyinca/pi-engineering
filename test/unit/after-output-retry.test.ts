import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AFTER_OUTPUT_SCHEDULE,
  isRetryableTransportFailure,
  longWaitSchedule,
  resolveAfterOutputSchedule,
} from "../../src/gateway/afterOutputRetry.ts";

test("schedule: capped exponential backoff with jitter, and no attempt cap", () => {
  const schedule = longWaitSchedule({ baseMs: 2_000, capMs: 180_000, jitter: 0, horizonMs: 1 });
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 50, 500].map((n) => schedule.delayMs(n)),
    [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 180_000, 180_000, 180_000],
  );
  const jittered = longWaitSchedule({ baseMs: 10_000, capMs: 10_000, jitter: 0.2, horizonMs: 1, random: () => 0.999 });
  assert.ok(jittered.delayMs(3) <= 12_000 && jittered.delayMs(3) >= 10_000);
});

test("defaults: long horizon (hours, not attempts), minutes-scale cap; env overrides", () => {
  assert.equal(DEFAULT_AFTER_OUTPUT_SCHEDULE.horizonMs, 12 * 60 * 60 * 1000);
  assert.equal(DEFAULT_AFTER_OUTPUT_SCHEDULE.capMs, 3 * 60 * 1000);
  const env = resolveAfterOutputSchedule({
    PI_AFTER_OUTPUT_RETRY_HORIZON_MS: "3600000",
    PI_AFTER_OUTPUT_RETRY_CAP_MS: "120000",
  });
  assert.equal(env.horizonMs, 3_600_000);
  assert.equal(env.capMs, 120_000);
  assert.equal(resolveAfterOutputSchedule({ PI_AFTER_OUTPUT_RETRY_HORIZON_MS: "junk" }).horizonMs, 12 * 60 * 60 * 1000);
});

const failed = (errorMessage: string, content: unknown[] = [{ type: "text", text: "partial" }]) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage,
  content,
});

test("classification: transport drops and link cuts are retryable; request problems are not", () => {
  for (const text of [
    "Connection lost: the route serving this model ended before the response did; the response is incomplete. Please retry your request: it is routed afresh.",
    "The route serving this model ended before the response did; the response is incomplete. Retry the request: it is routed afresh.",
    "terminated",
    "Connection error.",
    "socket hang up",
    "upstream connect error or disconnect/reset before headers",
  ]) {
    assert.equal(isRetryableTransportFailure(failed(text)), true, text);
  }
  for (const text of [
    "invalid request: schema mismatch",
    "413 http: request body too large",
    "Request body too large to send: … out of budget …",
    "401 invalid api key",
    "context length exceeded: prompt is too long",
  ]) {
    assert.equal(isRetryableTransportFailure(failed(text)), false, text);
  }
  assert.equal(
    isRetryableTransportFailure({ ...failed("terminated"), stopReason: "aborted" }),
    false,
    "Esc is not a failure",
  );
  assert.equal(isRetryableTransportFailure({ ...failed("terminated"), stopReason: "stop" }), false);
});

test("scope: only failures AFTER visible output belong here (pre-output waits are the pump's)", () => {
  const link =
    "Connection lost: the route serving this model ended before the response did; the response is incomplete. Please retry your request: it is routed afresh.";
  assert.equal(isRetryableTransportFailure(failed(link, [])), false, "no output: the pump owns it");
  assert.equal(
    isRetryableTransportFailure(failed(link, [{ type: "text", text: "  " }])),
    false,
    "whitespace is not output",
  );
  assert.equal(isRetryableTransportFailure(failed(link, [{ type: "thinking", thinking: "hmm" }])), true);
  assert.equal(
    isRetryableTransportFailure(failed(link, [{ type: "toolCall", id: "t", name: "read", arguments: {} }])),
    true,
  );
});

test("horizon: one shared setting (PI_GATEWAY_MAX_ELAPSED_MS) by default; the specific override wins", () => {
  assert.equal(resolveAfterOutputSchedule({ PI_GATEWAY_MAX_ELAPSED_MS: "3600000" }).horizonMs, 3_600_000);
  assert.equal(
    resolveAfterOutputSchedule({ PI_GATEWAY_MAX_ELAPSED_MS: "3600000", PI_AFTER_OUTPUT_RETRY_HORIZON_MS: "60000" })
      .horizonMs,
    60_000,
  );
});

test("the owed wait is keyed by (provider, model) and never taken by a summarization call", async () => {
  const { AfterOutputRetry } = await import("../../src/gateway/afterOutputRetry.ts");
  const slept: number[] = [];
  const retry = new AfterOutputRetry({
    schedule: { baseMs: 1_000, capMs: 1_000, jitter: 0, horizonMs: 60_000 },
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const model = { provider: "gw", id: "m" };
  retry.observe(model);
  retry.owe(model, 1_000, 1, "link cut");
  const summary = { systemPrompt: "You are a context summarization assistant. Your task…", messages: [] };
  assert.equal(await retry.beforeSend({ provider: "gw", id: "other" }, undefined, { messages: [] }), "go");
  assert.equal(await retry.beforeSend(model, undefined, summary), "go");
  assert.deepEqual(slept, [], "neither consumed the wait");
  assert.equal(await retry.beforeSend(model, undefined, { messages: [] }), "go");
  assert.deepEqual(slept, [1_000], "the continued request took it");
});
