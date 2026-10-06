/**
 * Interactive-path retries for failures that showed NOTHING to the operator,
 * against a real local OpenAI-compatible HTTP server (session review):
 *
 *   - "Stream ended without finish_reason" with no output and the SDK's
 *     "Request timed out." are retried on the short budget (8 attempts / 5 min);
 *   - an IW-ACT-RETRY-ALTERNATE hold does not wait silently for 12 hours: the
 *     wait advises an alternate model and is capped well below the long horizon;
 *   - IW-ACT-DO-NOT-RETRY still surfaces immediately.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";
import { type GatewayWaitSignal, describeGatewayWait } from "../../src/gateway/signals.ts";
import {
  ALTERNATE_MODEL_MAX_ELAPSED_MS,
  DEFAULT_GATEWAY_MAX_ELAPSED_MS,
  SHORT_TRANSIENT_MAX_ATTEMPTS,
} from "../../src/gateway/streamRetry.ts";

type Step =
  | { kind: "ok" }
  | { kind: "no-finish" }
  | { kind: "slow"; delayMs: number }
  | { kind: "json"; status: number; body: unknown };

const script: Step[] = [];
let fallback: Step = { kind: "ok" };
let requests = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => {
    requests++;
    const step = script.shift() ?? fallback;
    const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" };
    const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const ok = () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "fine" }, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.end("data: [DONE]\n\n");
    };
    if (step.kind === "ok") return ok();
    if (step.kind === "no-finish") {
      // A 200 head, then the stream closes before any token or finish_reason.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
      return;
    }
    if (step.kind === "slow") {
      const timer = setTimeout(ok, step.delayMs);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(step.status, { "content-type": "application/json" });
    res.end(JSON.stringify(step.body));
  });
});

let baseUrl = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function harness(opts: { now?: () => number; onHold?: (s: GatewayWaitSignal) => void; hold?: () => void } = {}) {
  script.length = 0;
  fallback = { kind: "ok" };
  requests = 0;
  const dir = mkdtempSync(join(tmpdir(), "gw-empty-"));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("gw", {
    baseUrl,
    apiKey: "k",
    api: "openai-completions",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 1024,
      },
    ],
  } as never);
  const registry = new ModelRegistry(runtime);
  resetGatewayStreamRetry();
  installGatewayStreamRetry(registry as never, { provider: "gw", api: "openai-completions" }, {
    createStream: () => createAssistantMessageEventStream() as never,
    hold: async () => {
      opts.hold?.();
    },
    ...(opts.onHold ? { onHold: (info: { signal: GatewayWaitSignal }) => opts.onHold?.(info.signal) } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    errorMessage: (_m: unknown, error: unknown) => ({
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    }),
    signalOf: (o: unknown) => (o as { signal?: AbortSignal } | undefined)?.signal,
  } as never);
  const model = runtime.getModel("gw", "m");
  const call = async (extra: Record<string, unknown> = {}) =>
    (await runtime
      .streamSimple(
        model as never,
        { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
        {
          apiKey: "k",
          ...extra,
        } as never,
      )
      .result()) as { stopReason?: string; errorMessage?: string };
  return { call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("'Stream ended without finish_reason' with no output is retried", async () => {
  const h = await harness();
  try {
    script.push({ kind: "no-finish" }, { kind: "no-finish" });
    const result = await h.call();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requests, 3, "two empty truncations, then the answer");
  } finally {
    h.cleanup();
  }
});

test("'Request timed out.' with no output is retried", async () => {
  const h = await harness();
  try {
    script.push({ kind: "slow", delayMs: 2_000 }, { kind: "slow", delayMs: 2_000 });
    const result = await h.call({ timeoutMs: 150 });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requests, 3, "two timeouts, then the answer");
  } finally {
    h.cleanup();
  }
});

test("an empty failure that never clears stops on the short budget", async () => {
  const h = await harness();
  try {
    fallback = { kind: "no-finish" };
    const result = await h.call();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /finish_reason/);
    assert.equal(requests, SHORT_TRANSIENT_MAX_ATTEMPTS, "short budget, not the 12h long-wait horizon");
  } finally {
    h.cleanup();
  }
});

const alternateBody = {
  error: {
    type: "inferweave_backpressure",
    reason: "capacity_unavailable",
    message: "no worker for model m",
    action: "retry_alternate",
    action_code: "IW-ACT-RETRY-ALTERNATE",
    retryable: true,
    replay_safe: true,
    request_state: "not_started",
    scope: "model",
    retry_after_ms: 60_000,
  },
};

test("IW-ACT-RETRY-ALTERNATE advises an alternate model and caps the wait well below 12h", async () => {
  let clock = 0;
  const holds: GatewayWaitSignal[] = [];
  const h = await harness({
    now: () => clock,
    // Each hold "takes" its wait on the injected clock; nothing really sleeps.
    hold: () => {
      clock += 60_000;
    },
    onHold: (s) => holds.push(s),
  });
  try {
    fallback = { kind: "json", status: 503, body: alternateBody };
    const result = await h.call();
    assert.equal(result.stopReason, "error");
    assert.ok(ALTERNATE_MODEL_MAX_ELAPSED_MS <= DEFAULT_GATEWAY_MAX_ELAPSED_MS / 12, "cap is well below 12h");
    assert.ok(clock <= ALTERNATE_MODEL_MAX_ELAPSED_MS, `waited ${clock}ms`);
    assert.ok(holds.length >= 3, "a few holds happen before giving up");
    assert.match(result.errorMessage ?? "", /alternate model/i, "the final error advises switching models");
    assert.match(describeGatewayWait(holds.at(-1)!), /alternate model/i, "the status line advises it while waiting");
  } finally {
    h.cleanup();
  }
});

test("IW-ACT-DO-NOT-RETRY surfaces immediately", async () => {
  const h = await harness();
  try {
    fallback = {
      kind: "json",
      status: 503,
      body: {
        error: {
          ...alternateBody.error,
          action: "do_not_retry",
          action_code: "IW-ACT-DO-NOT-RETRY",
          retryable: false,
        },
      },
    };
    const result = await h.call();
    assert.equal(result.stopReason, "error");
    assert.equal(requests, 1, "no retry");
  } finally {
    h.cleanup();
  }
});
