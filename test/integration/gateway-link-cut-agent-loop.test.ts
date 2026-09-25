/**
 * A gateway link cut through the REAL composition: a native provider behind
 * `ModelRuntime.streamSimple`, wrapped by `installGatewayStreamRetry`, consumed
 * by pi-agent-core's own agent loop.
 *
 * The loop turns the first `start` into `message_start` and pushes a partial
 * assistant message into the context. A retried attempt that leaked its
 * `start` would show up here as a second assistant message — so this is where
 * the one-start rule is proven, not against a fake sink.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";

const API = "anthropic-messages";
const LINK_CUT =
  "Connection lost: the route serving this model ended before the response did; the response is incomplete. Please retry your request: it is routed afresh.";

const MODEL = {
  id: "probe-model",
  name: "Probe",
  api: API,
  provider: "probe",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

function message(content: unknown[], stopReason: string, errorMessage?: string) {
  return {
    role: "assistant",
    content,
    api: API,
    provider: "probe",
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/** Attempt 1: 200 head (`start`), then the cut. Attempt 2: a clean answer. */
function probeProvider() {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      id: "probe",
      name: "Probe",
      auth: {
        apiKey: {
          name: "API key",
          login: async () => ({ type: "api_key", key: "k" }),
          check: async () => ({ type: "api_key", source: "environment" }),
          resolve: async () => ({ auth: { apiKey: "k" } }),
        },
      },
      getModels: () => [MODEL],
      stream: () => {
        throw new Error("the agent loop uses streamSimple; stream must not be reached");
      },
      streamSimple: () => {
        const attempt = calls++;
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          s.push({ type: "start", partial: message([], "stop") } as never);
          if (attempt === 0) {
            const failed = message([], "error", LINK_CUT);
            s.push({ type: "error", reason: "error", error: failed } as never);
            return;
          }
          const partial = message([{ type: "text", text: "ok" }], "stop");
          s.push({ type: "text_start", contentIndex: 0, partial } as never);
          s.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial } as never);
          s.push({ type: "text_end", contentIndex: 0, content: "ok", partial } as never);
          s.push({ type: "done", reason: "stop", message: partial } as never);
        });
        return s;
      },
    },
  };
}

test("agent loop: a link cut after the 200 head is retried with exactly one assistant message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-link-cut-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const probe = probeProvider();
    runtime.registerNativeProvider(probe.provider as never);
    resetGatewayStreamRetry();
    const holds: number[] = [];
    const installed = installGatewayStreamRetry(
      new ModelRegistry(runtime) as never,
      { provider: "probe", api: API },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async (signal) => {
          holds.push(signal.retryAfterMs);
        },
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
        signalOf: (options) => (options as { signal?: AbortSignal } | undefined)?.signal,
      },
    );
    assert.equal(installed, "installed");

    const events: Array<{ type: string; message?: { role?: string } }> = [];
    const messages = await runAgentLoop(
      [{ role: "user", content: "hi", timestamp: Date.now() }] as never,
      { systemPrompt: "", messages: [], tools: [] } as never,
      { model: MODEL, convertToLlm: (m: unknown[]) => m } as never,
      async (event) => {
        events.push(event as never);
      },
      undefined,
      ((m: never, c: never, o: Record<string, unknown>) => runtime.streamSimple(m, c, { ...o, apiKey: "k" })) as never,
    );

    assert.equal(probe.calls(), 2, "the cut attempt was replayed");
    assert.deepEqual(holds, [1_000]);
    const assistantStarts = events.filter((e) => e.type === "message_start" && e.message?.role === "assistant");
    assert.equal(assistantStarts.length, 1, "exactly one start reached the agent loop");
    const assistants = (messages as Array<{ role: string; stopReason?: string }>).filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]?.stopReason, "stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
