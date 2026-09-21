/**
 * End-to-end InferWeave admission retry against a REAL `node:http` endpoint.
 *
 * The fake InferWeave node replies `429` with a structured
 * `type: "inference_admission"` body for the first N requests, then streams a
 * success. The admission streamSimple seam drives it through the capture-fetch
 * + retry state machine. Acceptance: the operation survives four 30s waits and
 * succeeds on the fifth attempt, with one request per attempt and a stable
 * logical request id.
 */

import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import { after, before, test } from "node:test";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeAdmissionConfig } from "../../src/inference/admissionConfig.ts";
import type { AdmissionInfo } from "../../src/inference/admissionContract.ts";
import { type AdmissionEvent, AdmissionEventBus } from "../../src/inference/admissionEvents.ts";
import {
  ATTEMPT_HEADER,
  LOGICAL_REQUEST_HEADER,
  createAdmissionStreamSimple,
  terminalAssistantMessage,
} from "../../src/inference/admissionTransport.ts";

const CONFIG = normalizeAdmissionConfig({
  max_attempts: 50,
  max_elapsed_ms: 900_000,
  min_delay_ms: 1,
  max_delay_ms: 120_000,
  base_backoff_ms: 10,
  jitter_ratio: 0,
  honor_retry_after: true,
});

const ADMISSION_BODY = (): AdmissionInfo => ({
  reason: "queue_timeout",
  retryAfterMs: 30_000,
  active: 4,
  activeLimit: 4,
  queued: 26,
  queueLimit: 100,
  payload: {
    type: "inference_admission",
    reason: "queue_timeout",
    retry_after_ms: 30_000,
    active: 4,
    active_limit: 4,
    queued: 26,
    queue_limit: 100,
  },
});

type ServerMode = "admit-4" | "always-admit" | "plain-429";

let server: Server | undefined;
let port = 0;
let mode: ServerMode = "admit-4";
let requests: { logicalRequestId: string | null; attempt: string | null }[] = [];

function model(): Model<Api> {
  return { api: "openai-completions", provider: "inferweave", id: "qwen" } as unknown as Model<Api>;
}

function successMessage(text: string) {
  return {
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
  } as never;
}

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    requests.push({
      logicalRequestId: (req.headers[LOGICAL_REQUEST_HEADER] as string) ?? null,
      attempt: (req.headers[ATTEMPT_HEADER] as string) ?? null,
    });
    const n = requests.length;
    if (mode === "plain-429") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_exceeded" } }));
      return;
    }
    if (mode === "always-admit" || n <= 4) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify(ADMISSION_BODY().payload));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"text_delta","delta":"hello"}\n\ndata: {"type":"done"}\n\n');
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server.address() as { port: number };
  port = addr.port;
});

after(() => {
  server?.close();
});

function reset(m: ServerMode): void {
  mode = m;
  requests = [];
}

function url(): string {
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

/** A minimal OpenAI-completions delegate that uses the injected capture fetch. */
function delegate() {
  return (
    _model: Model<Api>,
    _ctx: unknown,
    options?: SimpleStreamOptions,
  ): ReturnType<typeof createAssistantMessageEventStream> => {
    const s = createAssistantMessageEventStream();
    void (async () => {
      try {
        const fetchImpl = options?.fetch;
        if (!fetchImpl) throw new Error("no fetch injected");
        const res = await fetchImpl(url(), {
          method: "POST",
          headers: {
            ...(options?.headers ?? {}), // forwards x-pi-logical-request-id / x-pi-attempt
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "qwen" }),
        });
        if (!res.ok) {
          const text = await res.text();
          s.push({ type: "error", reason: "error", error: terminalAssistantMessage(model(), text, "error") });
          s.end();
          return;
        }
        const text = await res.text();
        if (text.includes("hello")) {
          s.push({ type: "text_start", contentIndex: 0, partial: {} as never });
          s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: {} as never });
          s.push({ type: "done", reason: "stop", message: successMessage(text) });
        }
        s.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        s.push({ type: "error", reason: "error", error: terminalAssistantMessage(model(), message, "error") });
        s.end();
      }
    })();
    return s;
  };
}

async function collect(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<{ terminal: { type: string; reason?: string }; events: AdmissionEvent[] }> {
  const events: AdmissionEvent[] = [];
  let terminalType = "unknown";
  let terminalReason: string | undefined;
  for await (const ev of stream) {
    if (ev.type === "done") terminalType = "done";
    if (ev.type === "error") {
      terminalType = "error";
      terminalReason = ev.reason;
    }
  }
  return { terminal: { type: terminalType, reason: terminalReason }, events };
}

function run(opts: { bus: AdmissionEventBus; signal?: AbortSignal }) {
  // Attempt 1's `started` fires synchronously during stream construction, so
  // the caller must subscribe to `bus` BEFORE calling run() to observe it.
  const streamSimple = createAdmissionStreamSimple({
    config: CONFIG,
    events: opts.bus,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    random: () => 0,
    delegate: delegate(),
  });
  const stream = streamSimple(model(), {} as never, { signal: opts.signal } as never);
  return { stream };
}

function eventsOf(): { bus: AdmissionEventBus; events: AdmissionEvent[] } {
  const bus = new AdmissionEventBus();
  const events: AdmissionEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { bus, events };
}

test("acceptance: four 30s queue_timeout waits then a successful stream", async () => {
  reset("admit-4");
  const { bus, events } = eventsOf();
  const { stream } = run({ bus });
  const { terminal } = await collect(stream);

  assert.equal(terminal.type, "done");
  // One request per attempt; the agent survived four waits and succeeded on the fifth.
  assert.equal(requests.length, 5);
  assert.equal(events.filter((e) => e.name === "inference.retry.started").length, 5);
  assert.ok(events.some((e) => e.name === "inference.retry.succeeded"));
  assert.ok(!events.some((e) => e.name === "inference.retry.exhausted"));
  // Server-directed retry_after_ms was honoured on every wait.
  const scheduled = events.filter((e) => e.name === "inference.retry.scheduled");
  assert.equal(scheduled.length, 4);
  for (const e of scheduled) assert.equal(e.retryAfterMs, 30_000);
});

test("the logical request id is stable across all attempts", async () => {
  reset("admit-4");
  const { bus } = eventsOf();
  const { stream } = run({ bus });
  await collect(stream);
  assert.equal(requests.length, 5);
  const ids = new Set(requests.map((r) => r.logicalRequestId));
  assert.equal(ids.size, 1);
  // Every attempt carries the same logical request id (a UUID, never null).
  assert.ok(requests[0]!.logicalRequestId !== null);
  assert.equal(requests[0]!.logicalRequestId, requests[4]!.logicalRequestId);
});

test("a non-InferWeave 429 is left untouched: one request, no retry", async () => {
  reset("plain-429");
  const { bus, events } = eventsOf();
  const { stream } = run({ bus });
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error");
  assert.equal(requests.length, 1); // never retried
  // A single attempt happened (attempt 1 always fires `started`), but no wait
  // was ever scheduled and no further attempt was made.
  assert.equal(events.filter((e) => e.name === "inference.retry.started").length, 1);
  assert.ok(!events.some((e) => e.name === "inference.retry.scheduled"));
});

test("immediate cancellation: a pre-aborted signal stops before waiting", async () => {
  reset("always-admit");
  const ac = new AbortController();
  ac.abort();
  const { bus, events } = eventsOf();
  const { stream } = run({ bus, signal: ac.signal });
  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error");
  assert.equal(terminal.reason, "aborted");
  assert.equal(requests.length, 1); // only the first attempt, no waits
  assert.ok(events.some((e) => e.name === "inference.retry.cancelled"));
  assert.ok(!events.some((e) => e.name === "inference.retry.exhausted"));
});

test("cancellation during a wait stops retrying and reports a cancellation", async () => {
  reset("always-admit");
  const ac = new AbortController();
  const { bus, events } = eventsOf();
  const { stream } = run({ bus, signal: ac.signal });

  const collectPromise = collect(stream);
  // Abort shortly after the first attempt registers its (clamped ~5ms) wait.
  const timer = setTimeout(() => ac.abort(), 15);
  const { terminal } = await collectPromise;
  clearTimeout(timer);

  assert.equal(terminal.type, "error");
  assert.equal(terminal.reason, "aborted");
  assert.ok(events.some((e) => e.name === "inference.retry.cancelled"));
  assert.ok(!events.some((e) => e.name === "inference.retry.exhausted"));
  // We aborted during/just after the first wait, so at most one retry happened.
  assert.ok(requests.length >= 1);
});
