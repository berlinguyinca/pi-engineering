// R02: cross-layer retry correlation is the existing failureIdentity / errorRef / actingLayers / recordRetryTrace API.
// Pinned here as-is — no reimplementation, no wrapper, no new detector. Pure: no clock read, no network, no scheduler.
import assert from "node:assert/strict";
import { it } from "node:test";
import type { InferenceTelemetryData, InferenceTelemetryEventName } from "../../src/inference/telemetry.ts";
import { InferenceTelemetry } from "../../src/inference/telemetry.ts";
import { type ErrorRef, type FailureIdentityInput, type RetryLayer, type RetryTrace, actingLayers, errorRef, failureIdentity, recordRetryTrace } from "../../src/inference/retryTrace.ts";

/** A tiny telemetry stand-in that records the event name and payload exactly as `recordRetryTrace` emits them. */
class Probe extends InferenceTelemetry {
  seen: Array<{ name: InferenceTelemetryEventName; data: InferenceTelemetryData }> = [];
  emit(name: InferenceTelemetryEventName, data: InferenceTelemetryData = {}): void {
    this.seen.push({ name, data });
  }
}

const upstream = () => Object.assign(new Error("cut stream: 503 Service Unavailable from https://llm.example.com"), { status: 503 });
const throttled = { status: 429, reason: "queue_timeout", retryAfterMs: 30_000 };
const scope = (over: Partial<FailureIdentityInput> = {}): FailureIdentityInput => ({ sessionId: "sess-r02", runId: "run-7", provider: "metabolomics", model: "qwen3.8-flash_next", originLayer: "worker-transient-retry", firstAttempt: 3, error: upstream(), ...over });
const entry = (layer: RetryLayer, attempt: number, next: RetryTrace["next"], over: Partial<RetryTrace> = {}): RetryTrace => ({ layer, attempt, reason: "503:upstream", next, owner: layer, ...over });

it("one failure observed by two layers derives one byte-identical id, and the observing layer's own attempt is not identity", () => {
  const lower = entry("resilient-stream", 1, "defer", { owner: "worker-transient-retry", failure_id: failureIdentity(scope()) });
  const upper = entry("worker-transient-retry", 4, "retry", { failure_id: failureIdentity(scope()) });
  assert.notEqual(upper.attempt, lower.attempt, "the two layers count their own attempts differently");
  assert.equal(upper.failure_id, lower.failure_id, "different observing layers, one upstream failure: identical failure_id");
  assert.deepEqual(Object.keys(scope()).sort(), ["error", "firstAttempt", "model", "originLayer", "provider", "runId", "sessionId"], "identity is scope+failure only: no observing layer, no observing attempt");
});

it("independent failures stay separate ids while one failure re-derived stays one id", () => {
  const one = failureIdentity(scope());
  assert.equal(failureIdentity(scope()), one, "re-derivation is byte-identical");
  assert.notEqual(failureIdentity(scope({ error: throttled })), one, "same session, a 429 wait instead of a 500: a different failure");
  assert.notEqual(failureIdentity(scope({ sessionId: "sess-r02-b" })), one, "same error, another session: a different failure");
  assert.notEqual(failureIdentity(scope({ runId: "run-8" })), one, "same error, another run: a different failure");
  assert.notEqual(failureIdentity(scope({ error: throttled, firstAttempt: 4 })), one, "attempt 4 throttled is not attempt 3 upstream-failed: two failures, not one observed twice");
});

it("duplicate layer action on one correlated failure reads straight out of actingLayers", () => {
  const id = failureIdentity(scope());
  const multiplied = [entry("resilient-stream", 1, "retry", { failure_id: id }), entry("worker-transient-retry", 2, "hold", { failure_id: id, owner: "resilient-stream" })];
  const single = [entry("worker-transient-retry", 2, "retry", { failure_id: id }), entry("resilient-stream", 1, "defer", { failure_id: id, owner: "worker-transient-retry" }), entry("model-takeover", 3, "defer", { failure_id: id, owner: "worker-transient-retry" })];
  assert.deepEqual(actingLayers(multiplied), ["resilient-stream", "worker-transient-retry"], "two acting layers on one failure_id");
  assert.deepEqual(actingLayers(single), ["worker-transient-retry"], "one acting layer plus defers on the same failure_id");
  assert.equal(new Set([...multiplied, ...single].map((e) => e.failure_id)).size, 1, "all five entries correlate to one failure, so actingLayers().length > 1 is itself the retry-multiplication signal — no extra detector");
});

it("the five original RetryTrace fields stay valid and identity rides the emitted payload unchanged", () => {
  const plain: RetryTrace = { layer: "resilient-stream", attempt: 1, reason: "429:queue", next: "retry", owner: "resilient-stream" };
  const trace: RetryTrace[] = [];
  assert.doesNotThrow(() => recordRetryTrace(trace, plain), "2-arg call: no telemetry, no identity");
  assert.deepEqual(trace, [plain], "the entry is appended as-is");
  const bus = new Probe();
  const id = failureIdentity(scope());
  const ref = errorRef(scope());
  assert.ok(ref !== null, "the normalized reference is produced");
  recordRetryTrace(trace, entry("worker-transient-retry", 3, "retry", { failure_id: id, error_ref: ref }), bus);
  assert.deepEqual(bus.seen.map((e) => e.name), ["inference.retry.trace"], "the trace still publishes on the one existing event name");
  assert.deepEqual([bus.seen[0]!.data.failure_id, bus.seen[0]!.data.error_ref], [id, ref], "failure_id and error_ref ride unchanged");
  assert.deepEqual(Object.keys(plain).sort(), ["attempt", "layer", "next", "owner", "reason"], "the original format is unchanged");
});

it("identity is deterministic and errorRef keeps only normalized code, layer, severity and a digest", () => {
  const leaky = scope({ error: { message: "socket hang up at /Users/secret/personal/token=abc", status: 500 } });
  assert.equal(failureIdentity(leaky), failureIdentity(leaky), "same input twice: same id");
  assert.match(failureIdentity(leaky), /^sha256:[0-9a-f]{64}$/, "the id is sha256: plus hex and nothing else");
  const ref: ErrorRef | null = errorRef(leaky);
  assert.ok(ref !== null, "the reference is produced");
  assert.deepEqual(Object.keys(ref).sort(), ["code", "layer", "severity", "summary_digest"], "exactly the four normalized fields");
  assert.deepEqual([ref.code, ref.layer, ref.severity], ["gateway.5xx.upstream", "gateway", "error"], "E03's normalized call");
  assert.match(ref.summary_digest, /^[0-9a-f]{32}$/);
  for (const leak of ["/Users/secret/personal/token=abc", "/Users", "secret", "token=abc", "socket hang up"]) assert.ok(!JSON.stringify(ref).includes(leak), `raw message text leaked into error_ref: ${leak}`);
});
