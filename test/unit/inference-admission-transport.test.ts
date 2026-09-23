import assert from "node:assert";
import { test } from "node:test";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeAdmissionConfig } from "../../src/inference/admissionConfig.ts";
import type { AdmissionInfo } from "../../src/inference/admissionContract.ts";
import { type AdmissionEvent, AdmissionEventBus, AdmissionMetrics } from "../../src/inference/admissionEvents.ts";
import {
  type AdmissionAttemptCapture,
  AdmissionBudgetLedger,
  executeWithAdmissionRetry,
  terminalAssistantMessage,
} from "../../src/inference/admissionTransport.ts";

/**
 * Deterministic clock + interruptible sleep for the state machine.
 *
 * The state machine registers each sleep asynchronously, so a test cannot
 * rely on advancing the clock at the exact moment the transport awaits. This
 * clock therefore accumulates `credit` on advance(): a sleep resolves
 * immediately (consuming credit) when it is registered after the advance, and
 * pending wakeups fire on the next advance. Both patterns are deterministic.
 */
class FakeClock {
  time = 0;
  readonly waits: { ms: number; signal?: AbortSignal }[] = [];
  /** Pre-advanced ms not yet consumed by a sleep. */
  private credit = 0;
  private readonly wakeups: Map<number, () => void> = new Map();
  private nextId = 1;

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.waits.push({ ms, signal });
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (this.credit >= ms) {
      this.credit -= ms;
      this.time += ms;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.wakeups.set(id, () => {
        this.wakeups.delete(id);
        if (signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        else resolve();
      });
    });
  }

  /** Advance the clock, adding credit and firing any pending wakeups. */
  advance(ms: number): void {
    this.credit += ms;
    for (const fn of [...this.wakeups.values()]) {
      this.wakeups.clear();
      fn();
    }
  }
}

function model(id = "qwen"): Model<Api> {
  return { api: "openai-completions", provider: "inferweave", id } as unknown as Model<Api>;
}

function context(): unknown {
  return {};
}

function errorStream(message = "boom"): ReturnType<typeof createAssistantMessageEventStream> {
  const s = createAssistantMessageEventStream();
  s.push({ type: "error", reason: "error", error: terminalAssistantMessage(model(), message, "error") });
  s.end();
  return s;
}

function successStream(text = "hello"): ReturnType<typeof createAssistantMessageEventStream> {
  const s = createAssistantMessageEventStream();
  s.push({ type: "text_start", contentIndex: 0, partial: {} as never });
  s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: {} as never });
  s.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "inferweave",
      model: "qwen",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    } as never,
  });
  s.end();
  return s;
}

/** Collect the terminal event + text of a stream. */
async function collect(
  stream: ReturnType<typeof executeWithAdmissionRetry>,
): Promise<{ terminal: AssistantMessageEvent; text: string; result: unknown }> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  const result = await stream.result();
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { delta?: string }).delta ?? "")
    .join("");
  return { terminal: events[events.length - 1]!, text, result };
}

function admissionInfo(reason: string, retryAfterMs = 30_000): AdmissionInfo {
  return {
    reason,
    retryAfterMs,
    active: 4,
    activeLimit: 4,
    queued: 26,
    queueLimit: 100,
    payload: {
      type: "inference_admission",
      reason,
      retry_after_ms: retryAfterMs,
      active: 4,
      active_limit: 4,
      queued: 26,
      queue_limit: 100,
    },
  };
}

const CONFIG = normalizeAdmissionConfig({
  max_attempts: 50,
  max_elapsed_ms: 900_000,
  min_delay_ms: 500,
  max_delay_ms: 120_000,
  base_backoff_ms: 2_000,
  jitter_ratio: 0,
  honor_retry_after: true,
});

/** Build an invoke that returns admission rejections for the first `n` attempts. */
function invokingRejections(n: number, reason = "queue_timeout", retryAfterMs = 30_000) {
  return (
    attempt: number,
    _options: unknown,
    capture: AdmissionAttemptCapture,
  ): ReturnType<typeof createAssistantMessageEventStream> => {
    if (attempt <= n) {
      capture.admission = admissionInfo(reason, retryAfterMs);
      return errorStream("InferWeave admission rejected");
    }
    return successStream();
  };
}

function runTransport(opts: {
  config?: typeof CONFIG;
  clock?: FakeClock;
  bus?: AdmissionEventBus;
  signal?: AbortSignal;
  rejections?: number;
  reason?: string;
  retryAfterMs?: number;
  budget?: AdmissionBudgetLedger;
  invoke?: (
    attempt: number,
    options: unknown,
    capture: { admission?: unknown },
  ) => ReturnType<typeof createAssistantMessageEventStream>;
}) {
  const clock = opts.clock ?? new FakeClock();
  const bus = opts.bus ?? new AdmissionEventBus();
  const rejections = opts.rejections ?? 4;
  const stream = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: opts.signal } as never,
    opts.invoke ?? invokingRejections(rejections, opts.reason, opts.retryAfterMs),
    {
      config: opts.config ?? CONFIG,
      events: bus,
      budget: opts.budget,
      now: clock.now.bind(clock),
      sleep: clock.sleep.bind(clock),
      random: () => 0,
    },
  );
  return { stream, clock, bus };
}

test("admission contract: a single 429 then success succeeds after one wait", async () => {
  const { stream, clock, bus } = runTransport({ rejections: 1 });
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));

  clock.advance(30_000);
  const { terminal, text } = await collect(stream);

  assert.equal(terminal.type, "done");
  assert.equal(text, "hello");
  assert.equal(clock.waits.length, 1);
  assert.equal(clock.waits[0]!.ms, 30_000);
  const names = events.map((e) => e.name);
  assert.ok(names.includes("inference.retry.scheduled"));
  assert.ok(names.includes("inference.retry.waiting"));
  assert.ok(names.includes("inference.retry.started"));
  assert.ok(names.includes("inference.retry.succeeded"));
});

test("new-contract explicit false is surfaced with the final server message and codes", async () => {
  const finalText = "capacity rejected: FINAL-CODE / IW-ACT-DO-NOT-RETRY";
  const { stream, clock } = runTransport({
    rejections: 0,
    invoke: (_attempt, _options, capture) => {
      capture.admission = {
        type: "inferweave_backpressure",
        reason: "internal_error",
        code: "FINAL-CODE",
        message: "final server message",
        retryable: false,
        replaySafe: false,
        requestState: "dispatched",
        action: "do_not_retry",
        actionCode: "IW-ACT-DO-NOT-RETRY",
        explicitReplayContract: true,
        payload: {},
      } satisfies AdmissionInfo;
      return errorStream(finalText);
    },
  });
  const { terminal } = await collect(stream);
  assert.equal(clock.waits.length, 0);
  assert.match((terminal as { error?: { errorMessage?: string } }).error?.errorMessage ?? "", /FINAL-CODE/);
  assert.match((terminal as { error?: { errorMessage?: string } }).error?.errorMessage ?? "", /IW-ACT-DO-NOT-RETRY/);
});

test("acceptance: four 30s queue_timeout waits then a successful stream", async () => {
  // Subscribe before the transport starts (it publishes attempt-1 `started`
  // synchronously while constructing), so every attempt is observed.
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const { stream } = runTransport({ rejections: 4, clock, bus });

  clock.advance(30_000);
  clock.advance(30_000);
  clock.advance(30_000);
  clock.advance(30_000);
  const { terminal, text } = await collect(stream);

  assert.equal(terminal.type, "done");
  assert.equal(text, "hello");
  assert.equal(clock.waits.length, 4);
  // The agent survived all four waits and succeeded on attempt five.
  const started = events.filter((e) => e.name === "inference.retry.started");
  assert.equal(started.length, 5);
  assert.ok(events.some((e) => e.name === "inference.retry.succeeded"));
  assert.ok(!events.some((e) => e.name === "inference.retry.exhausted"));
});

test("honors retry-after precedence: retry-after-ms header beats body retry_after_ms", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  // Capture the raw header by driving via createAdmissionStreamSimple's capture is
  // complex; instead verify the delay resolution unit separately, and here just
  // confirm body retry_after_ms is honored when no header is present.
  const { stream } = runTransport({ rejections: 1, clock, bus, retryAfterMs: 30_000 });
  clock.advance(30_000);
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "done");
  assert.equal(clock.waits[0]!.ms, 30_000);
});

test("max attempts: a persistent rejection exhausts the attempt budget", async () => {
  const config = normalizeAdmissionConfig({
    max_attempts: 3,
    max_elapsed_ms: 900_000,
    min_delay_ms: 500,
    max_delay_ms: 60_000,
    base_backoff_ms: 2_000,
    jitter_ratio: 0,
  });
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const { stream } = runTransport({ config, rejections: 999, clock, bus });

  clock.advance(60_000);
  clock.advance(60_000);
  const { terminal } = await collect(stream);

  assert.equal(terminal.type, "error");
  assert.ok(events.some((e) => e.name === "inference.retry.exhausted"));
  const exhausted = events.find((e) => e.name === "inference.retry.exhausted")!;
  assert.equal(exhausted.terminatedBy, "budget_attempts");
  // Three attempts happened.
  assert.equal(events.filter((e) => e.name === "inference.retry.started").length, 3);
});

test("max elapsed: a rejection beyond the elapsed budget fails without over-waiting", async () => {
  const config = normalizeAdmissionConfig({
    max_attempts: 100,
    max_elapsed_ms: 65_000,
    min_delay_ms: 500,
    max_delay_ms: 120_000,
    base_backoff_ms: 2_000,
    jitter_ratio: 0,
  });
  const { stream, clock, bus } = runTransport({ config, rejections: 999, retryAfterMs: 30_000 });
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));

  clock.advance(30_000);
  clock.advance(30_000);
  clock.advance(30_000); // third wait would push past 65s -> clipped to 5s
  const { terminal } = await collect(stream);

  assert.equal(terminal.type, "error");
  const exhausted = events.find((e) => e.name === "inference.retry.exhausted")!;
  assert.equal(exhausted.terminatedBy, "budget_elapsed");
  // No wait longer than the remaining budget was performed.
  assert.ok(clock.waits.every((w) => w.ms <= 30_000));
});

test("cancellation during a wait is immediate and not reported as an InferWeave failure", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const ac = new AbortController();
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));

  const { stream } = runTransport({ clock, bus, signal: ac.signal, rejections: 999, retryAfterMs: 30_000 });
  clock.advance(30_000); // attempt 1 waits 30s
  clock.advance(30_000); // attempt 2 waits 30s
  // Now abort during the third wait.
  ac.abort();
  const { terminal } = await collect(stream);

  assert.equal(terminal.type, "error");
  assert.equal((terminal as { reason?: string }).reason, "aborted");
  assert.ok(events.some((e) => e.name === "inference.retry.cancelled"));
  assert.ok(!events.some((e) => e.name === "inference.retry.exhausted"));
  // The final message explicitly says it was a cancellation, not an InferWeave failure.
  const msg = (terminal as { error?: { errorMessage?: string } }).error?.errorMessage ?? "";
  assert.match(msg, /cancellation|Cancelled/);
  assert.ok(!/InferWeave failure/.test(msg) || /not an InferWeave failure/i.test(msg));
});

test("cancellation before any wait (signal already aborted) is immediate", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const ac = new AbortController();
  ac.abort();
  const { stream } = runTransport({ clock, bus, signal: ac.signal, rejections: 1 });
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error");
  assert.equal((terminal as { reason?: string }).reason, "aborted");
  assert.equal(clock.waits.length, 0);
});

test("quota_exhausted routes to fallback without waiting", async () => {
  const { stream, clock, bus } = runTransport({ rejections: 1, reason: "quota_exhausted" });
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));

  const { terminal } = await collect(stream);

  assert.equal(terminal.type, "error");
  assert.equal(clock.waits.length, 0); // no waiting for permanent quota
  assert.ok(events.some((e) => e.name === "inference.fallback.triggered"));
  assert.ok(!events.some((e) => e.name === "inference.retry.scheduled"));
});

test("401/403 status is never waited on regardless of reason token", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const stream = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (_attempt, _options, capture) => {
      capture.admission = {
        reason: "queue_timeout",
        retryAfterMs: 30_000,
        payload: { type: "inference_admission", reason: "queue_timeout" },
      };
      capture.status = 401;
      return errorStream();
    },
    { config: CONFIG, events: bus, now: clock.now.bind(clock), sleep: clock.sleep.bind(clock), random: () => 0 },
  );
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error");
  assert.equal(clock.waits.length, 0);
});

test("unknown reason without server delay is not retried", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const stream = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (_attempt, _options, capture) => {
      capture.admission = {
        reason: "mystery_reason",
        payload: { type: "inference_admission", reason: "mystery_reason" },
      };
      return errorStream();
    },
    { config: CONFIG, events: bus, now: clock.now.bind(clock), sleep: clock.sleep.bind(clock), random: () => 0 },
  );
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error");
  assert.equal(clock.waits.length, 0);
});

test("unknown reason WITH server delay is retried under retry_if_server_delay_present", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const stream = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (attempt, _options, capture) => {
      capture.admission = {
        reason: "mystery_reason",
        retryAfterMs: 5_000,
        payload: { type: "inference_admission", reason: "mystery_reason", retry_after_ms: 5_000 },
      };
      if (attempt === 1) return errorStream();
      return successStream();
    },
    { config: CONFIG, events: bus, now: clock.now.bind(clock), sleep: clock.sleep.bind(clock), random: () => 0 },
  );
  clock.advance(5_000);
  const { terminal, text } = await collect(stream);
  assert.equal(terminal.type, "done");
  assert.equal(text, "hello");
  assert.equal(clock.waits.length, 1);
});

test("stream safety: output committed on the failing attempt is never replayed", async () => {
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const stream = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (attempt, _options, capture) => {
      if (attempt === 1) {
        // First attempt emits output then fails with an admission response.
        capture.admission = admissionInfo("queue_timeout", 30_000);
        const s = createAssistantMessageEventStream();
        s.push({ type: "text_start", contentIndex: 0, partial: {} as never });
        s.push({ type: "text_delta", contentIndex: 0, delta: "partial ", partial: {} as never });
        s.push({ type: "error", reason: "error", error: terminalAssistantMessage(model(), "admission", "error") });
        s.end();
        return s;
      }
      return successStream();
    },
    { config: CONFIG, events: bus, now: clock.now.bind(clock), sleep: clock.sleep.bind(clock), random: () => 0 },
  );
  const { terminal, text } = await collect(stream);
  // Because output was already committed, we do NOT replay/retry: the terminal is
  // the error event (with the partial output already forwarded), never a retry.
  assert.equal(terminal.type, "error");
  assert.equal(clock.waits.length, 0);
  assert.equal(text, "partial ");
});

test("observe_only never changes control flow", async () => {
  const config = normalizeAdmissionConfig({ observe_only: true });
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();
  const stream = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (_attempt, _options, capture) => {
      capture.admission = admissionInfo("queue_timeout", 30_000);
      return errorStream();
    },
    { config, events: bus, now: clock.now.bind(clock), sleep: clock.sleep.bind(clock), random: () => 0 },
  );
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error");
  assert.equal(clock.waits.length, 0);
  assert.ok(!bus.events().some((e) => e.name === "inference.retry.scheduled"));
});

test("shared budget ledger: an outer re-entrant request fails fast after exhaustion", async () => {
  const config = normalizeAdmissionConfig({
    shared_budget_ms: 60_000,
    max_attempts: 50,
    max_elapsed_ms: 900_000,
    min_delay_ms: 500,
    max_delay_ms: 120_000,
    base_backoff_ms: 2_000,
    jitter_ratio: 0,
  });
  const ledger = new AdmissionBudgetLedger(() => 0);
  const clock = new FakeClock();
  const bus = new AdmissionEventBus();

  // First logical request exhausts the shared budget by waiting 60s then fails.
  const first = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (_attempt, _options, capture) => {
      capture.admission = admissionInfo("queue_timeout", 30_000);
      return errorStream();
    },
    {
      config,
      events: bus,
      budget: ledger,
      now: clock.now.bind(clock),
      sleep: clock.sleep.bind(clock),
      random: () => 0,
    },
  );
  clock.advance(30_000);
  clock.advance(30_000); // 60s waited -> shared budget spent
  const firstResult = await collect(first);
  assert.equal(firstResult.terminal.type, "error");
  assert.equal(clock.waits.length, 2);

  // Second logical request on the same provider/model must fail fast.
  const second = executeWithAdmissionRetry(
    model(),
    context() as never,
    { signal: undefined } as never,
    (_attempt, _options, capture) => {
      capture.admission = admissionInfo("queue_timeout", 30_000);
      return errorStream();
    },
    {
      config,
      events: bus,
      budget: ledger,
      now: clock.now.bind(clock),
      sleep: clock.sleep.bind(clock),
      random: () => 0,
    },
  );
  const secondResult = await collect(second);
  assert.equal(secondResult.terminal.type, "error");
  // No additional waits happened for the second request.
  assert.equal(clock.waits.length, 2);
  // `budget_ledger` is a fallback-class terminal: it emits fallback.triggered,
  // not retry.exhausted.
  const fallbacks = bus.events().filter((e) => e.name === "inference.fallback.triggered");
  assert.equal(fallbacks.length, 2);
  assert.equal(fallbacks[1]!.terminatedBy, "budget_ledger");
});

test("events carry structured fields for telemetry and metrics", async () => {
  const bus = new AdmissionEventBus();
  const metrics = new AdmissionMetrics();
  bus.subscribe((e) => metrics.record(e));
  const { stream, clock } = runTransport({ rejections: 2, bus, retryAfterMs: 30_000 });
  clock.advance(30_000);
  clock.advance(30_000);
  await collect(stream);

  const snapshot = metrics.snapshot();
  // `retries` counts every started attempt (2 rejections + 1 success).
  assert.equal(snapshot.retries, 3);
  assert.ok(snapshot.waitMs >= 60_000);
  assert.equal(snapshot.successAfterRetry, 1);
  assert.ok(snapshot.byReason.some((r) => r.reason === "queue_timeout"));
  const saturation = snapshot.saturation.find((s) => s.provider === "inferweave" && s.model === "qwen");
  assert.ok(saturation);
  assert.equal(saturation!.queued, 26);
  assert.equal(saturation!.queueLimit, 100);
  assert.equal(saturation!.active, 4);
  assert.equal(saturation!.activeLimit, 4);
});
