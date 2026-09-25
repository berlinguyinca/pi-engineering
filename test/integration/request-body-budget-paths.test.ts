/**
 * The request-body guard on BOTH live paths, against a real Pi ModelRuntime.
 *
 * Interactive turns reach the provider through the gateway stream-retry
 * wrapper (installGatewayStreamRetry); fresh-context workers reach it through
 * PiWorkerExecutor's own ModelRuntime. A probe native provider stands in for
 * the gateway and records exactly what it was asked to send.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  generateSummary,
} from "@earendil-works/pi-coding-agent";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";
import {
  REQUEST_LIMIT_HEADER,
  advertisedRequestLimit,
  estimateRequestBodyBytes,
  requestBodyLimit,
  resetAdvertisedRequestLimits,
  resolveRequestBodyBudgetConfig,
} from "../../src/request/bodyBudget.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";
import { pngImage } from "../support/images.ts";

const API = "openai-completions";
const BASE_URL = "https://gateway.invalid/v1";
const MODEL = {
  id: "probe-vision",
  name: "Probe",
  api: API,
  provider: "probe",
  baseUrl: BASE_URL,
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 100,
};

interface Seen {
  messages: Array<{ role: string; content: Array<{ type: string; text?: string; data?: string }> }>;
}

function probeProvider(opts: { error?: string; header?: string; errors?: Array<string | undefined> } = {}) {
  const seen: Seen[] = [];
  return {
    seen,
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
        throw new Error("streamSimple only");
      },
      streamSimple: (
        _model: unknown,
        context: Seen,
        options?: { onResponse?: (r: unknown, m: unknown) => unknown },
      ) => {
        seen.push(context);
        const error = opts.errors ? opts.errors[seen.length - 1] : opts.error;
        const s = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          await options?.onResponse?.(
            { status: error ? 413 : 200, headers: opts.header ? { [REQUEST_LIMIT_HEADER]: opts.header } : {} },
            MODEL,
          );
          // The 200 head arrives before the gateway's verdict on a relayed body.
          s.push({ type: "start", partial: { stopReason: "stop", content: [] } } as never);
          if (error) {
            s.push({
              type: "error",
              reason: "error",
              error: { stopReason: "error", errorMessage: error },
            } as never);
          } else {
            s.push({
              type: "done",
              reason: "stop",
              message: { stopReason: "stop", content: [{ type: "text", text: "ok" }] },
            } as never);
          }
        });
        return s;
      },
    },
  };
}

/** Eight old images plus a newest one, well over a 1 MB budget. */
function heavyContext() {
  const messages: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `t${i}` }, pngImage(260, 260, 260, i + 1)],
      timestamp: 1,
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "seen" }],
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
      stopReason: "stop",
      timestamp: 1,
    });
  }
  const newest = pngImage(260, 260, 260, 99);
  messages.push({ role: "user", content: [{ type: "text", text: "latest" }, newest], timestamp: 1 });
  return { context: { systemPrompt: "sys", messages }, newest };
}

const BUDGET = { maxBytes: 1_000_000, headroom: 1, fallbackMaxBytes: 1_000_000 };

async function withRuntime(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "request-budget-"));
  const previous = process.env.QWEN_NODES_FILE;
  process.env.QWEN_NODES_FILE = join(dir, "no-nodes.json");
  resetAdvertisedRequestLimits();
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.QWEN_NODES_FILE;
    else process.env.QWEN_NODES_FILE = previous;
    resetAdvertisedRequestLimits();
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertReduced(seen: Seen | undefined, newestData: string): void {
  assert.ok(seen, "the provider was called");
  const texts = seen.messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text ?? ""));
  assert.ok(
    texts.some((t) => t.startsWith("[image omitted to fit the request size limit")),
    "oldest images dropped",
  );
  const last = seen.messages.at(-1)?.content.find((b) => b.type === "image");
  assert.equal(last?.data, newestData, "the newest image is sent intact");
}

test("interactive path: the installed wrapper sends a reduced COPY and learns the advertised cap", async () => {
  await withRuntime(async (dir) => {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const probe = probeProvider({ header: String(32 * 1024 * 1024) });
    runtime.registerNativeProvider(probe.provider as never);
    resetGatewayStreamRetry();
    installGatewayStreamRetry(
      new ModelRegistry(runtime) as never,
      { provider: "probe", api: API },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async () => {},
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
        requestBodyBudget: BUDGET,
      },
    );
    const { context, newest } = heavyContext();
    const snapshot = JSON.stringify(context);
    const result = await runtime.streamSimple(MODEL as never, context as never, { apiKey: "k" }).result();

    assert.equal(result.stopReason, "stop");
    assertReduced(probe.seen[0], newest.data);
    assert.equal(JSON.stringify(context), snapshot, "the session transcript is untouched");
    assert.equal(advertisedRequestLimit(BASE_URL), 32 * 1024 * 1024, "the response header was recorded");
  });
});

test("interactive path: newest content over budget fails fast, never reaching the gateway", async () => {
  await withRuntime(async (dir) => {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const probe = probeProvider();
    runtime.registerNativeProvider(probe.provider as never);
    resetGatewayStreamRetry();
    installGatewayStreamRetry(
      new ModelRegistry(runtime) as never,
      { provider: "probe", api: API },
      {
        createStream: () => createAssistantMessageEventStream() as never,
        hold: async () => {},
        errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
        requestBodyBudget: BUDGET,
      },
    );
    const context = { messages: [{ role: "user", content: "x".repeat(1_200_000), timestamp: 1 }] };
    const result = await runtime.streamSimple(MODEL as never, context as never, { apiKey: "k" }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /request body too large/i);
    assert.equal(probe.seen.length, 0, "an unsendable request is not sent");
  });
});

async function interactiveRuntime(dir: string, probe: ReturnType<typeof probeProvider>, holds: number[] = []) {
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(probe.provider as never);
  resetGatewayStreamRetry();
  installGatewayStreamRetry(
    new ModelRegistry(runtime) as never,
    { provider: "probe", api: API },
    {
      createStream: () => createAssistantMessageEventStream() as never,
      hold: async (signal) => {
        holds.push(signal.retryAfterMs);
      },
      errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
      requestBodyBudget: { maxBytes: undefined, headroom: 0.85, fallbackMaxBytes: 10 * 1024 * 1024 },
    },
  );
  return runtime;
}

test("interactive path: a gateway 413 lowers the learned cap, re-fits, and resends exactly once", async () => {
  await withRuntime(async (dir) => {
    const probe = probeProvider({ errors: ["413 http: request body too large", undefined] });
    const holds: number[] = [];
    const runtime = await interactiveRuntime(dir, probe, holds);
    // ~2.4 MB: under the 10 MiB fallback, over what the 413 teaches us.
    const { context, newest } = heavyContext();
    const result = await runtime.streamSimple(MODEL as never, context as never, { apiKey: "k" }).result();

    assert.equal(probe.seen.length, 2, "one resend, after re-fitting");
    assert.deepEqual(holds, [], "not a gateway wait");
    assert.equal(result.stopReason, "stop");
    const first = estimateRequestBodyBytes(probe.seen[0] as never);
    const second = estimateRequestBodyBytes(probe.seen[1] as never);
    assert.ok(second <= first * 0.8, `the resend is smaller (${second} vs ${first})`);
    assertReduced(probe.seen[1], newest.data);
    const learned = requestBodyLimit(resolveRequestBodyBudgetConfig({}), { baseUrl: BASE_URL, id: MODEL.id });
    assert.ok(learned.maxBytes < 10 * 1024 * 1024, "the lowered cap is remembered");
  });
});

test("interactive path: a second 413 is final, explained, and not retried again", async () => {
  await withRuntime(async (dir) => {
    const probe = probeProvider({ error: "413 http: request body too large" });
    const holds: number[] = [];
    const runtime = await interactiveRuntime(dir, probe, holds);
    const { context } = heavyContext();
    const result = await runtime.streamSimple(MODEL as never, context as never, { apiKey: "k" }).result();
    assert.equal(probe.seen.length, 2, "one resend at most");
    assert.deepEqual(holds, []);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /413 http: request body too large/);
    assert.match(result.errorMessage ?? "", /MiB/);
  });
});

test("interactive path: a 413 on a body under 1 MiB teaches nothing and is not resent", async () => {
  await withRuntime(async (dir) => {
    const probe = probeProvider({ error: "413 http: request body too large" });
    const runtime = await interactiveRuntime(dir, probe);
    const context = { messages: [{ role: "user", content: "small", timestamp: 1 }] };
    const result = await runtime.streamSimple(MODEL as never, context as never, { apiKey: "k" }).result();
    assert.equal(probe.seen.length, 1, "no resend");
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /out of budget/);
    const limit = requestBodyLimit(resolveRequestBodyBudgetConfig({}), { baseUrl: BASE_URL, id: MODEL.id });
    assert.equal(limit.source, "fallback", "no process-wide cap learned from a tiny body");
  });
});

test("compaction: summarization calls go through the same guarded streamSimple", async () => {
  await withRuntime(async (dir) => {
    const executor = new PiWorkerExecutor({ agentDir: dir, requestBodyBudget: BUDGET });
    const runtime = await executor.getModelRuntime();
    const probe = probeProvider();
    runtime.registerNativeProvider(probe.provider as never);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: MODEL as never,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } }),
      tools: [],
    });
    // A conversation whose summarization prompt alone exceeds the 1 MB budget:
    // the guard must refuse it before the provider sees it.
    const huge = [{ role: "user", content: [{ type: "text", text: "y".repeat(1_500_000) }], timestamp: 1 }];
    await assert.rejects(
      generateSummary(
        huge as never,
        MODEL as never,
        1000,
        "k",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        session.agent.streamFunction,
      ),
      /request body too large/i,
    );
    assert.equal(probe.seen.length, 0, "the summarization request never left the process");
    session.dispose();
  });
});

test("worker path: PiWorkerExecutor's runtime is guarded the same way", async () => {
  await withRuntime(async (dir) => {
    const executor = new PiWorkerExecutor({ agentDir: dir, requestBodyBudget: BUDGET });
    const runtime = await executor.getModelRuntime();
    const probe = probeProvider();
    runtime.registerNativeProvider(probe.provider as never);
    const { context, newest } = heavyContext();
    const snapshot = JSON.stringify(context);
    const result = await runtime.streamSimple(MODEL as never, context as never, { apiKey: "k" }).result();

    assert.equal(result.stopReason, "stop");
    assertReduced(probe.seen[0], newest.data);
    assert.equal(JSON.stringify(context), snapshot);
  });
});
