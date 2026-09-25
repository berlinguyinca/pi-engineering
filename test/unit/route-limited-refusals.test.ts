/**
 * Refusals that speak for one route or one request, not for the gateway.
 *
 * inferweave-gateway #358: a link peer that cannot take a chunked request is
 * limited to one 1 MiB frame, and a link's own ceiling may sit below the
 * gateway's. A request routed there gets a final 413 with `scope: "route"` and
 * `route_max_request_bytes` INSTEAD OF `max_request_bytes` — another route may
 * still carry it, so it must not be learned as the gateway's cap (which would
 * shrink every later request in the process).
 *
 * Likewise a 429 `queue_bytes` / `inflight_bytes` with `scope: "request"` is
 * about this request's bytes against the gateway's byte budget: the caller
 * waits; nobody else is parked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import { gatewayHoldScope, isAccountWideRefusal, parseGatewayWait } from "../../src/gateway/signals.ts";
import { classifyError } from "../../src/guard/transient.ts";
import {
  describeRequestTooLarge,
  isRouteLimitedTooLarge,
  limitFromBodyTooLarge,
  requestBodyLimit,
  resetAdvertisedRequestLimits,
  resolveRequestBodyBudgetConfig,
  streamWithinRequestBudget,
} from "../../src/request/bodyBudget.ts";
import { classifyInfraError } from "../../src/resilience/classify.ts";

const ROUTE_413 =
  '413 {"error":{"type":"inferweave_backpressure","code":"request_too_large","scope":"route","retryable":false,' +
  '"replay_safe":false,"request_state":"not_started","action_code":"IW-ACT-REDUCE-INPUT",' +
  '"route_max_request_bytes":1048576,"message":"request body too large for this route"}}';
const ROUTE_413_NO_SCOPE = '413 {"error":{"code":"request_too_large","route_max_request_bytes":4194304}}';
const GATEWAY_413 =
  '413 {"error":{"type":"inferweave_backpressure","code":"request_too_large","scope":"request","retryable":false,' +
  '"max_request_bytes":33554432}}';

test("route 413: recognised, never read as the gateway's cap", () => {
  assert.equal(isRouteLimitedTooLarge(ROUTE_413), true);
  assert.equal(isRouteLimitedTooLarge(ROUTE_413_NO_SCOPE), true);
  assert.equal(isRouteLimitedTooLarge(GATEWAY_413), false);
  assert.equal(isRouteLimitedTooLarge("413 http: request body too large"), false);
  assert.equal(limitFromBodyTooLarge(ROUTE_413), undefined, "route_max_request_bytes is not max_request_bytes");
  assert.equal(limitFromBodyTooLarge(GATEWAY_413), 33_554_432);
});

test("route 413: explained as a route limit with its size, final everywhere", () => {
  const described = describeRequestTooLarge(ROUTE_413, 10 * 1024 * 1024) ?? "";
  assert.ok(described.startsWith(ROUTE_413), "keeps the gateway's text");
  assert.match(described, /route/i);
  assert.match(described, /1\.00 MiB/, "names the route's bound, not the gateway cap");
  assert.doesNotMatch(described.slice(ROUTE_413.length), /10\.0 MiB/);
  assert.match(described, /out of budget/);
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: described } as never), false);
  assert.equal(classifyError(new Error(ROUTE_413)).retryable, false);
  assert.notEqual(parseGatewayWait({ text: ROUTE_413 })?.retryable, true);
  assert.equal(classifyInfraError(new Error(ROUTE_413)).retryable, false);
});

test("route 413 before any output: no gateway-wide cap is learned and nothing is resent", async () => {
  resetAdvertisedRequestLimits();
  const baseUrl = "https://gw.example/v1";
  let calls = 0;
  const base = () => {
    calls++;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { stopReason: "stop", content: [] } } as never);
      stream.push({ type: "error", reason: "error", error: { stopReason: "error", errorMessage: ROUTE_413 } } as never);
    });
    return stream;
  };
  const config = resolveRequestBodyBudgetConfig({});
  const wrapped = streamWithinRequestBudget(base as never, {
    config,
    errorResult: (_m, error) => ({ stopReason: "error", errorMessage: error.message }),
  });
  // ~2.4 MB: well over 1 MiB, so the old fallback (80% of what was sent)
  // would have been learned for the whole gateway.
  const context = { messages: [{ role: "user", content: "z".repeat(2_400_000), timestamp: 1 }] };
  const result = (await wrapped({ baseUrl, id: "m" }, context as never, undefined).result()) as {
    stopReason?: string;
    errorMessage?: string;
  };

  assert.equal(calls, 1, "not resent: another route may carry it, this one never will");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /route/i);
  assert.equal(requestBodyLimit(config, { baseUrl, id: "m" }).source, "fallback", "gateway cap untouched");
  resetAdvertisedRequestLimits();
});

// ─── 429 queue_bytes / inflight_bytes, scope "request" ─────────────────────

function byteRefusal(reason: "queue_bytes" | "inflight_bytes"): string {
  return `429: ${JSON.stringify({
    error: {
      type: "inference_admission",
      code: reason,
      reason,
      message: `inference admission: ${reason}`,
      retryable: true,
      replay_safe: true,
      request_state: "not_started",
      action: "backoff",
      action_code: "IW-ACT-BACKOFF",
      retry_after_ms: 2000,
      scope: "request",
      inflight_bytes: 900_000_000,
      queue_bytes_limit: 1_073_741_824,
    },
  })}`;
}

for (const reason of ["queue_bytes", "inflight_bytes"] as const) {
  test(`429 ${reason} (scope request): a retryable wait for this caller only`, async () => {
    const signal = parseGatewayWait({ text: byteRefusal(reason) });
    assert.ok(signal);
    assert.equal(signal.retryable, true);
    assert.equal(signal.retryAfterMs, 2000);
    assert.equal(signal.source, "body");
    assert.equal(signal.scope, "request");
    assert.equal(isAccountWideRefusal(signal), false, "not a statement about the account");
    assert.equal(gatewayHoldScope(signal), "caller", "no shared cooldown");

    // Routed the way the extension and the worker route holds: the refused
    // caller sleeps, everyone else is free to go immediately.
    let now = 0;
    const sleeps: number[] = [];
    const controller = new AdmissionController({
      maxConcurrency: 4,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0,
    });
    const scoped = { ...signal, provider: "p", model: "m" };
    if (gatewayHoldScope(scoped) === "caller") await controller.noteCallerWaitAndSleep(scoped);
    else await controller.noteWaitAndSleep(scoped);
    assert.deepEqual(sleeps, [2000]);
    now = 0;
    assert.equal(controller.cooldownRemainingMs({ provider: "p", model: "m" }), 0, "no model cooldown armed");
    assert.equal(controller.cooldownRemainingMs(), 0, "no process-wide cooldown armed");
    assert.equal(controller.status().concurrency, 4, "no concurrency clamp");
  });
}
