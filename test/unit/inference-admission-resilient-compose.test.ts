import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeAdmissionConfig } from "../../src/inference/admissionConfig.ts";
import { AdmissionEventBus } from "../../src/inference/admissionEvents.ts";
import { createAdmissionStreamSimple, terminalAssistantMessage } from "../../src/inference/admissionTransport.ts";
import { currentInferenceInvocation, runWithInferenceInvocation } from "../../src/inference/inferenceContext.ts";

/**
 * Composition contract between the unified resilient runtime layer and the
 * admission provider wrapper (one canonical retry authority).
 *
 * The resilient runtime marks its invocations `resilient:true` via the
 * async-local inference context. The admission wrapper must then OBSERVE
 * (record saturation / gate) but NOT run its own retry loop — otherwise the
 * same rejection is retried twice (double retry). Callers OUTSIDE a resilient
 * invocation (e.g. autoTune, the narrator) keep full admission retry.
 */

const SAFE_CAPTURE = {
  reason: "NO_CONTEXT_CAPACITY",
  retryable: true,
  replay_safe: true,
  request_state: "queued",
  action: "backoff",
  action_code: "IW-ACT-BACKOFF",
};

function model(id = "qwen"): Model<Api> {
  return { api: "openai-completions", provider: "inferweave", id } as unknown as Model<Api>;
}

function context(): unknown {
  return {};
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
    } as never,
  });
  s.end();
  return s;
}

/** A stream that emits its error only after `after` resolves, so the admission capture is populated first. */
function rejectionStream(
  after: Promise<unknown>,
  message = "admission rejected",
): ReturnType<typeof createAssistantMessageEventStream> {
  const s = createAssistantMessageEventStream();
  void after.then(() => {
    s.push({ type: "error", reason: "error", error: terminalAssistantMessage(model(), message, "error") });
    s.end();
  });
  return s;
}

/** A base fetch that reports one retryable InferWeave admission rejection. */
const rejectFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      type: "inferweave_backpressure",
      ...SAFE_CAPTURE,
      retry_after_ms: 1,
      active: 4,
      active_limit: 4,
      queued: 26,
      queue_limit: 100,
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

/** Delegate: rejects on the first attempt (via the capture fetch), succeeds after. */
function rejectionThenSuccessDelegate() {
  let attempts = 0;
  return (
    _m: Model<Api>,
    _c: unknown,
    options: { fetch?: typeof fetch } | undefined,
  ): ReturnType<typeof createAssistantMessageEventStream> => {
    attempts += 1;
    if (attempts === 1) {
      const fetchFn: typeof fetch = options?.fetch ?? (globalThis.fetch as typeof fetch);
      return rejectionStream(fetchFn("https://example.invalid/", {}).catch(() => null));
    }
    return successStream();
  };
}

async function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<{ terminal: AssistantMessageEvent; text: string }> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { delta?: string }).delta ?? "")
    .join("");
  return { terminal: events[events.length - 1]!, text };
}

test("resilient marker propagates through the async-local inference context", () => {
  assert.equal(currentInferenceInvocation()?.resilient, undefined);
  let seen: boolean | undefined;
  runWithInferenceInvocation({ resilient: true, role: "implementer" }, () => {
    seen = currentInferenceInvocation()?.resilient;
  });
  assert.equal(seen, true);
  assert.equal(currentInferenceInvocation()?.resilient, undefined);
});

test("inside a resilient invocation, admission observes (no retry) but records saturation", async () => {
  const bus = new AdmissionEventBus();
  let saturation: unknown = null;
  const config = normalizeAdmissionConfig({
    max_attempts: 3,
    min_delay_ms: 0,
    max_delay_ms: 0,
    honor_retry_after: true,
  });
  const wrapper = createAdmissionStreamSimple({
    config,
    events: bus,
    onSaturation: (_ref, sat) => {
      saturation = sat;
    },
    delegate: rejectionThenSuccessDelegate() as never,
  });

  const stream = runWithInferenceInvocation({ resilient: true, role: "implementer" }, () =>
    wrapper(model(), context() as never, { fetch: rejectFetch, sessionId: "s" } as never),
  );

  const { terminal } = await collect(stream);
  assert.equal(terminal.type, "error", "observe-only resilient mode must forward, not retry");
  assert.ok(
    !bus.events().some((e) => e.name === "inference.retry.scheduled"),
    "no admission retry scheduled under resilient layer",
  );
  assert.ok(saturation, "saturation is still recorded so the router keeps its load signal");
});

test("outside a resilient invocation, admission retries a retryable rejection", async () => {
  const bus = new AdmissionEventBus();
  const config = normalizeAdmissionConfig({
    max_attempts: 3,
    min_delay_ms: 0,
    max_delay_ms: 0,
    honor_retry_after: true,
  });
  const wrapper = createAdmissionStreamSimple({
    config,
    events: bus,
    delegate: rejectionThenSuccessDelegate() as never,
  });

  const stream = wrapper(model(), context() as never, { fetch: rejectFetch, sessionId: "s" } as never);
  // Let the single retry's 30s retry-after wait resolve.
  const { terminal, text } = await collect(stream);
  assert.equal(terminal.type, "done", "non-resilient caller keeps admission retry and succeeds");
  assert.equal(text, "hello");
  assert.ok(
    bus.events().some((e) => e.name === "inference.retry.scheduled"),
    "admission retry ran outside the resilient layer",
  );
});
