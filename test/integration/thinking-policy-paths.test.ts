/**
 * Thinking OFF on both live paths, observed in pi-ai's REAL payload.
 *
 * A native provider whose `streamSimple` is pi-ai's own openai-completions
 * implementation builds the actual request body; `onPayload` captures it and
 * aborts before any network I/O. Pi's real compaction code (`generateSummary`)
 * drives the summarization request through the guarded `streamSimple`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple as openAiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";
import { ModelRegistry, ModelRuntime, generateSummary } from "@earendil-works/pi-coding-agent";
import { installGatewayStreamRetry, resetGatewayStreamRetry } from "../../src/gateway/installStreamRetry.ts";
import { resolveThinkingOffConfig } from "../../src/request/thinkingPolicy.ts";
import { PiWorkerExecutor } from "../../src/workers/PiWorkerExecutor.ts";

const API = "openai-completions";

function model(provider: string, baseUrl: string) {
  return {
    id: "qwen3.8-flash_next-modality-text-quant-q4_k_xl",
    name: "probe",
    api: API,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
  };
}
const METABOLOMICS = model("metabolomics", "https://llm.metabolomics.us/v1");
const ELSEWHERE = model("elsewhere", "https://api.example.invalid/v1");

/** A native provider backed by pi-ai's real openai-completions transport. */
function realProvider(
  m: ReturnType<typeof model>,
  streamSimple: (...args: never[]) => unknown = openAiStreamSimple as never,
) {
  return {
    id: m.provider,
    name: m.provider,
    auth: {
      apiKey: {
        name: "API key",
        login: async () => ({ type: "api_key", key: "k" }),
        check: async () => ({ type: "api_key", source: "environment" }),
        resolve: async () => ({ auth: { apiKey: "k" } }),
      },
    },
    getModels: () => [m],
    stream: () => {
      throw new Error("streamSimple only");
    },
    streamSimple,
  };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thinking-policy-"));
  const previous = process.env.QWEN_NODES_FILE;
  process.env.QWEN_NODES_FILE = join(dir, "no-nodes.json");
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.QWEN_NODES_FILE;
    else process.env.QWEN_NODES_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function interactiveRuntime(
  dir: string,
  m: ReturnType<typeof model>,
  streamSimple?: (...args: never[]) => unknown,
) {
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(realProvider(m, streamSimple) as never);
  resetGatewayStreamRetry();
  installGatewayStreamRetry(
    new ModelRegistry(runtime) as never,
    { provider: m.provider, api: API },
    {
      createStream: () => createAssistantMessageEventStream() as never,
      hold: async () => {},
      errorMessage: (_m, error) => ({ stopReason: "error", errorMessage: String(error) }),
      thinkingPolicy: resolveThinkingOffConfig({}),
    },
  );
  return runtime;
}

/** Run Pi's real compaction summarization through `runtime`, returning the body pi-ai built. */
async function summarizationPayload(
  runtime: ModelRuntime,
  m: ReturnType<typeof model>,
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const streamFn = (mm: unknown, c: unknown, o: Record<string, unknown> = {}) =>
    runtime.streamSimple(
      mm as never,
      c as never,
      {
        ...o,
        apiKey: "k",
        onPayload: (params: Record<string, unknown>) => {
          payload = params;
          throw new Error("captured");
        },
      } as never,
    );
  await generateSummary(
    [{ role: "user", content: [{ type: "text", text: "summarize me" }], timestamp: 1 }] as never,
    m as never,
    16_384,
    "k",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    streamFn as never,
  ).catch(() => undefined);
  assert.ok(payload, "pi-ai built the request body");
  return payload;
}

async function ordinaryPayload(runtime: ModelRuntime, m: ReturnType<typeof model>): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  await runtime
    .streamSimple(
      m as never,
      { systemPrompt: "You are Pi.", messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
      {
        apiKey: "k",
        onPayload: (params: Record<string, unknown>) => {
          payload = params;
          throw new Error("captured");
        },
      } as never,
    )
    .result();
  assert.ok(payload);
  return payload;
}

test("interactive: Pi's compaction request to the metabolomics gateway carries reasoning_effort 'none'", async () => {
  await withDir(async (dir) => {
    const runtime = await interactiveRuntime(dir, METABOLOMICS);
    const payload = await summarizationPayload(runtime, METABOLOMICS);
    assert.equal(payload.reasoning_effort, "none");
    const ordinary = await ordinaryPayload(runtime, METABOLOMICS);
    assert.equal(ordinary.reasoning_effort, undefined, "an ordinary turn with room to spare is untouched");
  });
});

test("interactive: another provider's compaction request is untouched", async () => {
  await withDir(async (dir) => {
    const runtime = await interactiveRuntime(dir, ELSEWHERE);
    const payload = await summarizationPayload(runtime, ELSEWHERE);
    assert.equal(payload.reasoning_effort, undefined);
  });
});

test("worker: the guarded runtime sends thinking off for summarization too", async () => {
  await withDir(async (dir) => {
    const executor = new PiWorkerExecutor({ agentDir: dir, thinkingPolicy: resolveThinkingOffConfig({}) });
    const runtime = await executor.getModelRuntime();
    runtime.registerNativeProvider(realProvider(METABOLOMICS) as never);
    const payload = await summarizationPayload(runtime, METABOLOMICS);
    assert.equal(payload.reasoning_effort, "none");
  });
});

function cutOffProvider(output: number) {
  return () => {
    const s = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "The" }],
      api: API,
      provider: METABOLOMICS.provider,
      model: METABOLOMICS.id,
      usage: {
        input: 20_000,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20_000 + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "length",
      timestamp: 1,
    };
    queueMicrotask(() => {
      s.push({ type: "start", partial: { ...message, content: [] } } as never);
      s.push({ type: "text_delta", contentIndex: 0, delta: "The", partial: message } as never);
      s.push({ type: "done", reason: "length", message } as never);
    });
    return s;
  };
}

async function cutOffResult(dir: string, output: number) {
  const runtime = await interactiveRuntime(dir, METABOLOMICS, cutOffProvider(output) as never);
  return runtime
    .streamSimple(METABOLOMICS as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never, {
      apiKey: "k",
    })
    .result();
}

test("interactive: a clamped 'length' stop reaches Pi unchanged, so its compact-and-retry still fires", async () => {
  await withDir(async (dir) => {
    const result = await cutOffResult(dir, 13_107);
    assert.equal(result.stopReason, "length");
    assert.equal(isRecoverableLength(result, METABOLOMICS.maxTokens), true, "Pi's own recovery applies");
  });
});

test("interactive: a 'length' stop that spent the whole allowance on hidden reasoning is explained", async () => {
  await withDir(async (dir) => {
    const result = await cutOffResult(dir, METABOLOMICS.maxTokens);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /hidden reasoning/i);
  });
});
