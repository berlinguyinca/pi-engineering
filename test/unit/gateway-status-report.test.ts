/**
 * The `/gateway` report.
 *
 * Two of these assertions carry the feature: the queue POSITION (being 30th of
 * 100 is a wait, being 3rd is a hiccup) and the concurrency CLAMP, which is
 * otherwise invisible — when the gateway reports `active_limit` the runtime
 * silently shrinks its parallelism, and a run that went serial looks exactly
 * like one that got slow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdmissionStatus } from "../../src/gateway/AdmissionController.ts";
import { parseGatewayWait } from "../../src/gateway/signals.ts";
import { type GatewayReportConfig, renderGatewayReport } from "../../src/gateway/statusReport.ts";

const CONFIG: GatewayReportConfig = {
  enabled: true,
  maxConcurrency: 4,
  reservedSlots: 1,
  maxWaitMs: Number.POSITIVE_INFINITY,
  maxRetries: Number.POSITIVE_INFINITY,
};

const PRODUCTION_429 =
  '429: {"active":4,"active_limit":4,"message":"inference admission: queue_timeout","queue_limit":100,"queued":30,' +
  '"reason":"queue_timeout","request_id":"332ea9d2","retry_after_ms":30000,"scope":"agent","type":"inference_admission"}';

/**
 * Defaults mirror a real controller built from CONFIG: the unclamped limit is
 * `maxConcurrency - reservedSlots` (3), not `maxConcurrency` (4). Using 4 here
 * hid a bug where every healthy session was reported as clamped.
 */
function status(over: Partial<AdmissionStatus> = {}): AdmissionStatus {
  return { active: 0, waiting: 0, concurrency: 3, baseConcurrency: 3, cooldownMs: 0, ...over };
}

test("gateway report: an open gateway says so plainly", () => {
  const out = renderGatewayReport({ status: status(), config: CONFIG, installs: [] }).join("\n");
  assert.match(out, /Open — no cooldown/);
});

test("gateway report: a hold shows how long is left", () => {
  const out = renderGatewayReport({ status: status({ cooldownMs: 27_400 }), config: CONFIG, installs: [] }).join("\n");
  assert.match(out, /Holding — 27s left/);
});

test("gateway report: the queue position is shown, not just that we are waiting", () => {
  const signal = parseGatewayWait({ text: PRODUCTION_429 });
  assert.ok(signal);
  const out = renderGatewayReport({
    status: status({ cooldownMs: 30_000, lastSignal: signal }),
    config: CONFIG,
    installs: [],
  }).join("\n");

  assert.match(out, /position 30\/100 in the queue/);
  assert.match(out, /asked for 30s/);
  assert.match(out, /332ea9d2/, "the request id is what support tickets are made of");
});

test("gateway report: a concurrency clamp is named, with what it fell from", () => {
  const out = renderGatewayReport({
    status: status({ concurrency: 1, active: 1 }),
    config: CONFIG,
    installs: [],
  }).join("\n");

  assert.match(out, /limit 1 \(clamped down from 3 by the gateway\)/);
});

test("gateway report: a healthy session is never described as clamped", () => {
  // The reserve is not a clamp. A controller with maxConcurrency 4 and one
  // reserved slot runs at 3 by design, and reporting that as "clamped down
  // from 4" would fire the alarm on every session and teach the operator to
  // ignore it.
  const out = renderGatewayReport({ status: status(), config: CONFIG, installs: [] }).join("\n");
  assert.doesNotMatch(out, /clamped/);
  assert.match(out, /limit 3, 1 reserved for your turn/);
});

test("gateway report: a synthesized wait is distinguished from an advertised one", () => {
  const signal = parseGatewayWait({ text: "503 no worker for model" });
  assert.ok(signal);
  const out = renderGatewayReport({ status: status({ lastSignal: signal }), config: CONFIG, installs: [] }).join("\n");

  assert.match(out, /no wait advertised — using 5s/, "the operator should know when the number is ours, not theirs");
});

test("gateway report: Retry-After headers are described as advertised", () => {
  const out = renderGatewayReport({
    status: status({
      lastSignal: { retryAfterMs: 8_000, retryable: true, source: "header", status: 503 },
    }),
    config: CONFIG,
    installs: [],
  }).join("\n");
  assert.match(out, /asked for 8s/);
  assert.doesNotMatch(out, /no wait advertised/);
});

test("gateway report: a session without the wrapper is warned, not reassured", () => {
  const out = renderGatewayReport({ status: status(), config: CONFIG, installs: [] }).join("\n");
  assert.match(out, /Admission retry NOT installed — this turn uses Pi's own retry budget/);
});

test("gateway report: installed providers are listed", () => {
  const out = renderGatewayReport({
    status: status(),
    config: CONFIG,
    installs: ["metabolomics:openai-completions"],
  }).join("\n");
  assert.match(out, /Bounded admission retry installed for: metabolomics:openai-completions/);
});

test("gateway report: context usage is shown, and an unknown count says so", () => {
  const model = {
    id: "deepseek-v4-flash",
    provider: "metabolomics",
    api: "openai-completions",
    contextWindow: 1_048_576,
  };
  const known = renderGatewayReport({ status: status(), config: CONFIG, installs: [], model, contextTokens: 400_000 });
  assert.match(known.join("\n"), /context 400000\/1048576/);

  // Null is not zero: it is what Pi reports right after compaction, and it is
  // also what blocks a model fallback.
  const unknown = renderGatewayReport({ status: status(), config: CONFIG, installs: [], model, contextTokens: null });
  assert.match(unknown.join("\n"), /context unknown of 1048576/);
});

test("gateway report: legacy infinite overrides read as unlimited, not Infinity", () => {
  const out = renderGatewayReport({ status: status(), config: CONFIG, installs: [] }).join("\n");
  assert.match(out, /worker retry cap unlimited \(then the mission window\), interactive wait horizon default/);
  assert.doesNotMatch(out, /Infinity/);
});

test("gateway report: a disabled controller does not pretend to be holding", () => {
  const out = renderGatewayReport({
    status: status(),
    config: { ...CONFIG, enabled: false },
    installs: [],
  }).join("\n");
  assert.match(out, /disabled/);
  assert.doesNotMatch(out, /Slots:/);
});

// ─── Per-model readiness ────────────────────────────────────────────────────

test("gateway report: the model with no capacity is the one called out", () => {
  // This is the line that answers "why is THIS model refusing?" — a retry
  // counter never can.
  const out = renderGatewayReport({
    status: status(),
    config: CONFIG,
    installs: [],
    healthFresh: true,
    health: new Map([
      ["deepseek-v4-flash", { state: "warm", slots: 9 }],
      ["qwen3.8-27b", { state: "cold", slots: 0 }],
    ]),
  }).join("\n");

  assert.match(out, /Models \(live\):/);
  assert.match(out, /qwen3\.8-27b — 0 slot\(s\) · cold {2}← no capacity/);
  assert.match(out, /deepseek-v4-flash — 9 slot\(s\) · warm/);
  assert.doesNotMatch(out, /deepseek-v4-flash.*no capacity/);
});

test("gateway report: a stale reading is labelled as such", () => {
  // Presenting a cached view as live is how an operator concludes the gateway
  // is healthy while it is refusing them.
  const out = renderGatewayReport({
    status: status(),
    config: CONFIG,
    installs: [],
    healthFresh: false,
    health: new Map([["m", { slots: 1 }]]),
  }).join("\n");

  assert.match(out, /Models \(last known\):/);
});

test("gateway report: the session's own model is marked", () => {
  const out = renderGatewayReport({
    status: status(),
    config: CONFIG,
    installs: [],
    model: { id: "deepseek-v4-flash", provider: "metabolomics", api: "openai-completions", contextWindow: 262_144 },
    health: new Map([
      ["deepseek-v4-flash", { slots: 9 }],
      ["other", { slots: 1 }],
    ]),
  }).join("\n");

  assert.match(out, /\* deepseek-v4-flash/);
  assert.match(out, /\s\sother —/, "a model that is not the session's carries no marker");
});

test("gateway report: absent health readings add no section", () => {
  const out = renderGatewayReport({ status: status(), config: CONFIG, installs: [] }).join("\n");
  assert.doesNotMatch(out, /Models \(/);
});
