import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TRANSIENT_RETRY_CONFIG,
  TransientError,
  backoffDelayMs,
  classifyError,
  initialTransientTelemetry,
  isTruncatedStream,
  recordTransientError,
  recordTransientOutcome,
  resolveTransientRetryConfig,
  withTransientRetry,
} from "../../src/guard/transient.ts";

// ─── classifyError ───────────────────────────────────────────────────────────

test("classify: 503 no worker for model is a retryable server_unavailable", () => {
  const cls = classifyError(new Error("503 no worker for model"));
  assert.equal(cls.category, "server_unavailable");
  assert.equal(cls.retryable, true);
});

test("classify: 429 caller_concurrency admission is a retryable rate_limit", () => {
  const cls = classifyError(new Error("429 inference admission: caller_concurrency"));
  assert.equal(cls.category, "rate_limit");
  assert.equal(cls.retryable, true);
});

for (const text of ["routing_snapshot_expired", '503 {"code":"capacity_unavailable","action":"retry_alternate"}']) {
  test(`classify: gateway routing failure is retryable (${text.slice(0, 40)}…)`, () => {
    const cls = classifyError(new Error(text));
    assert.equal(cls.retryable, true);
    assert.equal(cls.category, "server_unavailable");
  });
}

// A model the catalog does not know is either a catalog that has not resynced
// (one retry clears it) or a configuration typo (no amount of waiting does).
// It must not be an infrastructure category, or the mission scheduler parks
// the task in its 90-minute gateway window while the gateway is healthy.
for (const text of ['404: {"code":"model_not_found","message":"model_not_found"}', "invalid model name: qwen-typo"]) {
  test(`classify: unknown model gets one retry, never the infra window (${text.slice(0, 30)}…)`, () => {
    const cls = classifyError(new Error(text));
    assert.equal(cls.category, "model_unavailable");
    assert.equal(cls.retryable, true);
    assert.equal(cls.maxRetries, 1);
  });
}

test("withTransientRetry: an unknown model is retried exactly once, then reported", async () => {
  let calls = 0;
  const out = await withTransientRetry({
    fn: async () => {
      calls++;
      throw new Error('404: {"code":"model_not_found"}');
    },
    sleep: async () => {},
    rand: () => 0,
  });
  assert.equal(calls, 2);
  assert.equal(out.category, "model_unavailable");
  assert.ok(out.error);
});

test("classify: the routing rule never overrides the admission contract's fail-closed decision", () => {
  // A well-formed backpressure envelope that forbids replay, and a malformed
  // one: the contract says terminal for both. Their rendered text still
  // carries routing tokens, which must not flip them to retryable.
  for (const text of [
    '503: {"type":"inferweave_backpressure","reason":"capacity_unavailable","action":"retry_alternate","replay_safe":false,"retry_after_ms":1000}',
    '{"type":"inferweave_backpressure","reason":"capacity_unavailable","retry_after_ms":"soon"',
  ]) {
    const cls = classifyError(new Error(text));
    assert.equal(cls.retryable, false, text);
  }
});

test("classify: a link cut stays with the network branch, not the routing rule", () => {
  const cls = classifyError(
    new Error("The route serving this model ended before the response did; the response is incomplete."),
  );
  assert.equal(cls.category, "network");
});

test("isTruncatedStream: anchored on pi-ai's exact truncation message", () => {
  assert.equal(isTruncatedStream("Stream ended without finish_reason"), true);
  assert.equal(isTruncatedStream("Error: Stream ended without finish_reason"), true);
  assert.equal(isTruncatedStream("Worker returned no worker_result. Stream ended without finish_reason"), true);
  // Loose look-alikes are not pi-ai's truncation.
  assert.equal(isTruncatedStream("upstream returned no finish_reason"), false);
  assert.equal(isTruncatedStream("the model said: stream ended without finish_reason was a bug"), false);
  assert.equal(isTruncatedStream("503 no worker for model"), false);
  assert.equal(isTruncatedStream(undefined), false);
});

test("isTruncatedStream: fails closed behind the envelope and permanent-status guards", () => {
  assert.equal(
    isTruncatedStream('Stream ended without finish_reason {"type":"inferweave_backpressure","reason":"x"}'),
    false,
  );
  assert.equal(isTruncatedStream('Stream ended without finish_reason {"type":"inference_admission"}'), false);
  assert.equal(isTruncatedStream("401: Stream ended without finish_reason"), false);
  const cls = classifyError(Object.assign(new Error("Stream ended without finish_reason"), { status: 403 }));
  assert.equal(cls.retryable, false);
});

test("classify: truncated stream (no finish_reason) is retryable", () => {
  const cls = classifyError(new Error("Worker returned no worker_result. Stream ended without finish_reason"));
  assert.equal(cls.category, "network", "a connection truncation, not a server verdict");
  assert.equal(cls.retryable, true);
  assert.equal(cls.reason, "truncated stream (no finish_reason)");
});

test("classify: numeric status 503 is retryable", () => {
  const cls = classifyError({ status: 503, message: "Service Unavailable" });
  assert.equal(cls.category, "server_unavailable");
  assert.equal(cls.retryable, true);
});

test("classify: network failure (ECONNRESET) is retryable", () => {
  const cls = classifyError(new Error("fetch failed: ECONNRESET"));
  assert.equal(cls.category, "network");
  assert.equal(cls.retryable, true);
});

test("classify: timeout is retryable", () => {
  const cls = classifyError(new Error("Request timed out after 30000ms"));
  assert.equal(cls.category, "timeout");
  assert.equal(cls.retryable, true);
});

test("classify: compaction / context-overflow / summarization failure is retryable", () => {
  for (const msg of [
    "Summarization failed: generation hit the token cap and the summary is incomplete",
    "Auto-compaction failed",
    "context overflow",
  ]) {
    const cls = classifyError(new Error(msg));
    assert.equal(cls.category, "compaction");
    assert.equal(cls.retryable, true);
  }
});

test("classify: permanent errors are not retryable", () => {
  const cls = classifyError(new Error("Invalid argument: bad tool name"));
  assert.equal(cls.category, "permanent");
  assert.equal(cls.retryable, false);
});

test("classify: non-Error values are handled defensively", () => {
  assert.equal(classifyError(undefined).category, "permanent");
  assert.equal(classifyError(null).category, "permanent");
  assert.equal(classifyError("429 too many requests").category, "rate_limit");
});

test("classify: provider Retry-After header is surfaced", () => {
  const cls = classifyError({ status: 429, headers: { get: () => "5" } });
  assert.equal(cls.retryable, true);
  assert.equal(cls.retryAfterMs, 5000);
});

// ─── backoffDelayMs ─────────────────────────────────────────────────────────

test("backoff: deterministic without jitter (jitter=0)", () => {
  const cfg = { ...DEFAULT_TRANSIENT_RETRY_CONFIG, jitter: 0 };
  assert.equal(backoffDelayMs(1, cfg), cfg.baseMs);
  assert.equal(backoffDelayMs(2, cfg), cfg.baseMs * cfg.factor);
  assert.equal(backoffDelayMs(3, cfg), cfg.baseMs * cfg.factor ** 2);
});

test("backoff: clamped to maxMs", () => {
  const cfg = { baseMs: 1000, maxMs: 2500, factor: 2, jitter: 0, maxAttempts: 4 };
  assert.equal(backoffDelayMs(1, cfg), 1000);
  assert.equal(backoffDelayMs(2, cfg), 2000);
  assert.equal(backoffDelayMs(3, cfg), 2500); // clamped
  assert.equal(backoffDelayMs(10, cfg), 2500); // clamped
});

test("backoff: jitter adds a bounded random component (deterministic rand)", () => {
  const cfg = { baseMs: 1000, maxMs: 100_000, factor: 2, jitter: 0.2, maxAttempts: 4 };
  const rand = () => 1; // max jitter
  assert.equal(backoffDelayMs(1, cfg, rand), 1000 + 1000 * 0.2);
  assert.equal(backoffDelayMs(2, cfg, rand), 2000 + 2000 * 0.2);
});

// ─── withTransientRetry ─────────────────────────────────────────────────────

test("withTransientRetry: succeeds on the first attempt (no retry)", async () => {
  let calls = 0;
  const out = await withTransientRetry({
    fn: async () => {
      calls++;
      return "ok";
    },
    sleep: async () => {},
  });
  assert.equal(out.value, "ok");
  assert.equal(out.error, undefined);
  assert.equal(out.attempts, 1);
  assert.equal(calls, 1);
});

test("withTransientRetry: retries a 503 and succeeds after transient failures", async () => {
  const slept: number[] = [];
  let calls = 0;
  const cfg = { ...DEFAULT_TRANSIENT_RETRY_CONFIG, jitter: 0, baseMs: 100, maxAttempts: 4 };
  const out = await withTransientRetry({
    fn: async () => {
      calls++;
      if (calls < 3) throw new Error("503 no worker for model");
      return "done";
    },
    config: cfg,
    sleep: async (ms) => {
      slept.push(ms);
    },
    rand: () => 0,
  });
  assert.equal(out.value, "done");
  assert.equal(out.attempts, 3);
  assert.deepEqual(slept, [100, 200]); // backoff before 2nd and 3rd call
});

test("withTransientRetry: respects provider Retry-After over backoff", async () => {
  const slept: number[] = [];
  let calls = 0;
  const out = await withTransientRetry({
    fn: async () => {
      calls++;
      if (calls < 2) throw { status: 429, headers: { get: () => "7" } };
      return "ok";
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(out.value, "ok");
  assert.deepEqual(slept, [7000]); // Retry-After 7s wins
});

test("withTransientRetry: never retries a permanent error", async () => {
  let calls = 0;
  const out = await withTransientRetry({
    fn: async () => {
      calls++;
      throw new Error("Invalid tool: nope");
    },
    sleep: async () => {
      throw new Error("should not sleep");
    },
  });
  assert.equal(out.value, undefined);
  assert.match(String((out.error as Error).message), /Invalid tool/);
  assert.equal(out.category, "permanent");
  assert.equal(calls, 1);
});

test("withTransientRetry: gives up after maxAttempts with the last error", async () => {
  let calls = 0;
  const slept: number[] = [];
  const cfg = { ...DEFAULT_TRANSIENT_RETRY_CONFIG, jitter: 0, baseMs: 50, maxAttempts: 3 };
  const out = await withTransientRetry({
    fn: async () => {
      calls++;
      throw new Error("429 too many requests");
    },
    config: cfg,
    sleep: async (ms) => {
      slept.push(ms);
    },
    rand: () => 0,
  });
  assert.equal(out.value, undefined);
  assert.equal(out.category, "rate_limit");
  assert.equal(out.attempts, 4); // initial + 3 retries
  assert.equal(calls, 4);
  assert.deepEqual(slept, [50, 100, 200]);
});

// ─── config / telemetry ──────────────────────────────────────────────────────

test("resolveTransientRetryConfig: env overrides defaults", () => {
  const cfg = resolveTransientRetryConfig({
    PI_GUARD_TRANSIENT_BASE_MS: "500",
    PI_GUARD_TRANSIENT_MAX_MS: "10000",
    PI_GUARD_TRANSIENT_MAX_ATTEMPTS: "6",
  });
  assert.equal(cfg.baseMs, 500);
  assert.equal(cfg.maxMs, 10_000);
  assert.equal(cfg.maxAttempts, 6);
});

test("resolveTransientRetryConfig: invalid values fall back to defaults", () => {
  const cfg = resolveTransientRetryConfig({ PI_GUARD_TRANSIENT_BASE_MS: "abc", PI_GUARD_TRANSIENT_FACTOR: "0" });
  assert.equal(cfg.baseMs, DEFAULT_TRANSIENT_RETRY_CONFIG.baseMs);
  assert.equal(cfg.factor, DEFAULT_TRANSIENT_RETRY_CONFIG.factor);
});

test("telemetry: records errors and outcomes per category", () => {
  const t = initialTransientTelemetry();
  recordTransientError(t, "rate_limit");
  recordTransientError(t, "rate_limit");
  recordTransientError(t, "network");
  assert.equal(t.errors, 3);
  assert.equal(t.byCategory.rate_limit, 2);
  recordTransientOutcome(t, true, "rate_limit");
  recordTransientOutcome(t, false, "server_unavailable");
  assert.equal(t.recovered, 1);
  assert.equal(t.exhausted, 1);
});

// ─── TransientError class ────────────────────────────────────────────────────

test("TransientError carries category and attempts", () => {
  const e = new TransientError("timeout", "boom", 2);
  assert.equal(e.name, "TransientError");
  assert.equal(e.category, "timeout");
  assert.equal(e.attempts, 2);
  assert.match(e.message, /boom/);
});
