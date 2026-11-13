// E07: one upstream failure is one occurrence — every layer observing it derives the same failure_id, the emitted
// telemetry carries only normalized short-safe values, and the old API behaves exactly as before. Pure: no network, no clock.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type ErrorRef,
  type FailureIdentityInput,
  type RetryLayer,
  type RetryTrace,
  actedOn,
  actingLayers,
  errorRef,
  failureIdentity,
  recordRetryTrace,
} from "../../src/inference/retryTrace.ts";
import { InferenceTelemetry } from "../../src/inference/telemetry.ts";
const SECRET = "sk-proj-YWJjZGVmZ2hpamtsbW5vcHFyc3R1";
const PATH = "/Users/dev/IdeaProjects/pi-engineering-runtime/src/app.ts";
const PROMPT = `system: classify ${"the quick brown fox jumps over the lazy dog. ".repeat(24)}`;
const upstream = () =>
  Object.assign(
    new Error(
      `cut stream: 503 Service Unavailable from https://llm.example.com key=${SECRET} near ${PATH} prompt: ${PROMPT}`,
    ),
    { status: 503 },
  );
const scope = (over: Partial<FailureIdentityInput> = {}): FailureIdentityInput => ({
  sessionId: "sess-e07",
  runId: "run-42",
  provider: "metabolomics",
  model: "qwen3.8-flash_next",
  firstAttempt: 3,
  originLayer: "worker-gateway-hold",
  error: upstream(),
  ...over,
});
const entry = (
  layer: RetryLayer,
  attempt: number,
  next: RetryTrace["next"],
  id: string,
  ref: ErrorRef,
): RetryTrace => ({
  layer,
  attempt,
  reason: "503:upstream",
  next,
  owner: "worker-gateway-hold",
  failure_id: id,
  error_ref: ref,
});
test("E07 evidence: one upstream failure observed by three layers stays one occurrence with one acting owner", () => {
  const bus = new InferenceTelemetry();
  const trace: RetryTrace[] = [];
  const ref = errorRef(scope());
  assert.ok(ref !== null, "the normalized reference is produced");
  recordRetryTrace(trace, entry("resilient-stream", 1, "defer", failureIdentity(scope()), ref), bus); // its own attempt 1, mid-replay
  recordRetryTrace(trace, entry("worker-gateway-hold", 2, "hold", failureIdentity(scope()), ref), bus); // acts: waits out the gateway's wait, its own attempt 2
  recordRetryTrace(trace, entry("model-takeover", 5, "defer", failureIdentity(scope()), ref), bus); // saw it later under its own numbering, attempt 5
  assert.equal(
    new Set(trace.map((e) => e.failure_id)).size,
    1,
    "three layer observations, one identical failure_id — one occurrence",
  );
  assert.deepEqual(actingLayers(trace), ["worker-gateway-hold"], "exactly one acting owner");
  assert.equal(bus.eventsNamed("inference.retry.trace").length, 3, "every observation is still emitted");
});
test("distinct failures and scopes yield distinct ids; the same failure re-derived twice is byte-identical", () => {
  const a = failureIdentity(scope());
  assert.equal(failureIdentity(scope()), a, "re-derivation is byte-identical (no clock read by default)");
  assert.match(a, /^sha256:[0-9a-f]{64}$/, "stable digest, prefixed");
  assert.notEqual(
    failureIdentity(scope({ error: Object.assign(new Error("429 rate limited, retry after 30s"), { status: 429 }) })),
    a,
    "different error, different id",
  );
  assert.notEqual(failureIdentity(scope({ runId: "run-43" })), a, "different scope, different id");
});
test("the emitted payload carries failure_id + error_ref; the secret, absolute path and prompt appear nowhere in it", () => {
  const bus = new InferenceTelemetry();
  const id = failureIdentity(scope());
  recordRetryTrace(undefined, entry("worker-gateway-hold", 2, "hold", id, errorRef(scope())!), bus);
  const event = bus.eventsNamed("inference.retry.trace")[0]!;
  const ref = event.data.error_ref as ErrorRef;
  const payload = JSON.stringify(event.data);
  assert.equal(event.data.failure_id, id, "failure_id rides the payload");
  assert.deepEqual(
    [ref.code, ref.layer, ref.severity],
    ["gateway.5xx.upstream", "gateway", "error"],
    "error_ref is E03's normalized call",
  );
  assert.match(ref.summary_digest, /^[0-9a-f]{32}$/, "the summary leaves only as a digest");
  for (const leak of [SECRET, PATH, "IdeaProjects", "quick brown fox", PROMPT.slice(0, 48)])
    assert.ok(!payload.includes(leak), `leak in payload: ${leak}`);
});
test("the old API is intact: actedOn/actingLayers unchanged; old-arity recordRetryTrace pushes and emits as before", () => {
  const plain: RetryTrace = {
    layer: "resilient-stream",
    attempt: 1,
    reason: "429:queue",
    next: "retry",
    owner: "resilient-stream",
  };
  const defer: RetryTrace = {
    layer: "worker-gateway-hold",
    attempt: 1,
    reason: "429:queue",
    next: "defer",
    owner: "resilient-stream",
  };
  assert.deepEqual([actedOn(plain), actedOn(defer)], [true, false]);
  assert.deepEqual(actingLayers([plain, defer]), ["resilient-stream"], "unchanged");
  const arr: RetryTrace[] = [];
  recordRetryTrace(arr, plain);
  assert.deepEqual(arr, [plain], "2-arg call still pushes");
  const bus = new InferenceTelemetry();
  recordRetryTrace(arr, defer, bus);
  const data = bus.eventsNamed("inference.retry.trace")[0]!.data as Record<string, unknown>;
  assert.equal(arr.length, 2);
  assert.deepEqual([data.attempt, data.trace], [1, defer], "3-arg call still emits attempt + trace");
  assert.ok(!("failure_id" in data) && !("error_ref" in data), "old-arity payloads gain no new keys");
});
