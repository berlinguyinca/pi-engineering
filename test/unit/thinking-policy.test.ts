/**
 * Thinking OFF where hidden reasoning eats the output budget.
 *
 * The metabolomics gateway's models think by default server-side, and Pi's
 * models.json registers them `reasoning: false`, so Pi never sends a reasoning
 * parameter — yet reasoning tokens count against max_tokens. Pi's compaction
 * asks for at most 0.8 x reserveTokens (13,107 by default) and fails on
 * stopReason "length"; on a ~200k-token conversation the hidden thinking
 * exhausts that, so auto-compaction fails, then overflow recovery fails, and a
 * near-full turn answers "The" before being cut off.
 *
 * Measured against the gateway: `reasoning_effort: "none"` gives zero
 * reasoning tokens on all three model families; "low" does not reduce it and
 * "minimal" is a 502 on the qwen models.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { runWithInferenceInvocation } from "../../src/inference/inferenceContext.ts";
import {
  applyThinkingOff,
  describeHiddenReasoningTruncation,
  isSummarizationRequest,
  resolveThinkingOffConfig,
  streamWithThinkingPolicy,
  thinkingOffReason,
} from "../../src/request/thinkingPolicy.ts";
import { setTelemetrySink } from "../../src/telemetry/sink.ts";

/** The 27B model the operator directive protects: thinking is never turned off for it. */
const QWEN27 = {
  id: "qwen3.8-27b-modality-vision-quant-q8_k_xl",
  provider: "metabolomics",
  api: "openai-completions",
  baseUrl: "https://llm.example.com/v1",
  contextWindow: 262_144,
  maxTokens: 32_768,
  compat: { supportsReasoningEffort: true },
};
/** The other gateway model family: the thinking-off policy applies to it unchanged. */
const METABOLOMICS = {
  id: "deepseek_v4-flash-modality-text-quant-mxfp4",
  provider: "metabolomics",
  api: "openai-completions",
  baseUrl: "https://llm.example.com/v1",
  contextWindow: 100_000,
  maxTokens: 32_768,
  compat: { supportsReasoningEffort: true },
};
const NODE_ONLY = { ...METABOLOMICS, compat: { supportsReasoningEffort: false } };
const ELSEWHERE = { ...METABOLOMICS, provider: "openai", baseUrl: "https://api.openai.com/v1" };

/** Pi's own summarization request, captured from its real compaction code. */
async function piSummarizationContext(): Promise<{ systemPrompt?: string; messages: unknown[] }> {
  let captured: { systemPrompt?: string; messages: unknown[] } | undefined;
  const streamFn = (_m: unknown, context: { systemPrompt?: string; messages: unknown[] }) => {
    captured = context;
    throw new Error("captured");
  };
  await generateSummary(
    [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] as never,
    METABOLOMICS as never,
    16_384,
    "k",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    streamFn as never,
  ).catch(() => undefined);
  assert.ok(captured, "Pi built a summarization request");
  return captured;
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

test("config: summaries and low-budget turns default on; env can turn each off", () => {
  const config = resolveThinkingOffConfig({});
  assert.equal(config.summaries, true);
  assert.equal(config.lowOutputBudget, true);
  assert.equal(config.lowOutputBudgetTokens, 16_384);
  assert.ok(config.gatewayHosts.includes("llm.example.com"));
  assert.ok(config.providers.includes("metabolomics"));
  assert.deepEqual(config.thinkingOnModels, ["qwen3.8-27b"], "the 27B family is protected by default");

  const off = resolveThinkingOffConfig({
    PI_THINKING_OFF_SUMMARIES: "0",
    PI_THINKING_OFF_LOW_BUDGET: "false",
    PI_THINKING_OFF_LOW_BUDGET_TOKENS: "16000",
    PI_THINKING_OFF_GATEWAYS: "gw.example:8443, other.example",
  });
  assert.equal(off.summaries, false);
  assert.equal(off.lowOutputBudget, false);
  assert.equal(off.lowOutputBudgetTokens, 16_000);
  assert.deepEqual(off.gatewayHosts, ["gw.example:8443", "other.example"]);
  assert.deepEqual(off.thinkingOnModels, ["qwen3.8-27b"], "unrelated env vars leave the override alone");

  const overridden = resolveThinkingOffConfig({ PI_THINKING_ON_MODELS: "My-Model, other" });
  assert.deepEqual(overridden.thinkingOnModels, ["my-model", "other"], "comma-separated, lowercased");
  assert.deepEqual(
    resolveThinkingOffConfig({ PI_THINKING_ON_MODELS: "" }).thinkingOnModels,
    [],
    "empty list disables the default",
  );
});

test("detection: Pi's real compaction request is a summarization request; a normal turn is not", async () => {
  assert.equal(isSummarizationRequest(await piSummarizationContext()), true);
  assert.equal(isSummarizationRequest({ systemPrompt: "You are Pi.", messages: [user("hi")] }), false);
  assert.equal(isSummarizationRequest({ messages: [user("hi")] }), false);
});

test("policy: summarization on the metabolomics gateway → thinking off; elsewhere untouched", async () => {
  const config = resolveThinkingOffConfig({});
  const summary = await piSummarizationContext();
  assert.equal(thinkingOffReason(METABOLOMICS, summary, config), "summarization");
  assert.equal(thinkingOffReason(ELSEWHERE, summary, config), undefined, "only gateways known to accept 'none'");
  assert.equal(thinkingOffReason({ ...METABOLOMICS, api: "anthropic-messages" }, summary, config), undefined);
  assert.equal(
    thinkingOffReason(METABOLOMICS, summary, resolveThinkingOffConfig({ PI_THINKING_OFF_SUMMARIES: "0" })),
    undefined,
  );
});

test("override: qwen3.8-27b keeps thinking on for mission roles, summarization, and low budgets — never off", async () => {
  const config = resolveThinkingOffConfig({});
  const summary = await piSummarizationContext();
  const ordinary = { systemPrompt: "You are Pi.", messages: [user("hi")] };
  // Interactive contexts: every off-reason the policy knows must stay off for the 27B model.
  assert.equal(thinkingOffReason(QWEN27, summary, config), undefined, "summarization stays on");
  assert.equal(thinkingOffReason(QWEN27, ordinary, config, 4_000), undefined, "low budget stays on");
  assert.equal(thinkingOffReason(QWEN27, ordinary, config, 999_999), undefined, "roomy turns stay on");
  // Mission roles: the unconditional rule yields to the model override.
  await runWithInferenceInvocation({ role: "implementer" }, async () => {
    assert.equal(thinkingOffReason(QWEN27, ordinary, config, 4_000), undefined, "mission role stays on");
    assert.equal(thinkingOffReason(QWEN27, summary, config), undefined, "mission-role summarization stays on");
  });
  // Other model families on the same gateway are untouched by the override.
  await runWithInferenceInvocation({ role: "implementer" }, async () => {
    assert.equal(thinkingOffReason(METABOLOMICS, ordinary, config, 4_000), "mission-role", "deepseek still off");
  });
});

test("override: PI_THINKING_ON_MODELS replaces the default; an unrelated fragment re-exposes the 27B model", async () => {
  await runWithInferenceInvocation({ role: "implementer" }, async () => {
    const ordinary = { systemPrompt: "You are Pi.", messages: [user("hi")] };
    const otherOnly = resolveThinkingOffConfig({ PI_THINKING_ON_MODELS: "some-other-model" });
    assert.equal(
      thinkingOffReason(QWEN27, ordinary, otherOnly, 4_000),
      "mission-role",
      "default no longer protects the 27B",
    );
    const added = resolveThinkingOffConfig({ PI_THINKING_ON_MODELS: "qwen3.8-27b, some-other-model" });
    assert.equal(thinkingOffReason(QWEN27, ordinary, added, 4_000), undefined, "explicit fragment still protects it");
    assert.equal(
      thinkingOffReason({ ...QWEN27, id: "some-other-model-v1" }, ordinary, added, 4_000),
      undefined,
      "the added fragment protects its model",
    );
  });
});

test("override: a mission-role turn on a protected model sends no thinking-off fields and logs the override", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  try {
    let sent: Record<string, unknown> | undefined;
    const base = (_m: unknown, _c: unknown, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => {
        sent = (await options?.onPayload?.({ max_tokens: 4_000, reasoning_effort: "high" }, QWEN27)) as never;
        return { stopReason: "stop" };
      },
    });
    await runWithInferenceInvocation({ role: "implementer" }, async () => {
      await streamWithThinkingPolicy(base as never, resolveThinkingOffConfig({}))(
        QWEN27,
        { messages: [user("hi")] } as never,
        {} as never,
      ).result();
    });
    assert.deepEqual(sent, { max_tokens: 4_000, reasoning_effort: "high" }, "the payload is untouched");
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /thinking: on \(model override\) · implementer/);
  } finally {
    uninstall();
  }
});

test("policy: an ordinary turn keeps thinking unless its real output allowance is small", () => {
  const config = resolveThinkingOffConfig({});
  assert.equal(thinkingOffReason(METABOLOMICS, { messages: [user("hi")] }, config), undefined);
  // The provider-clamped max_tokens from the payload is the real allowance.
  assert.equal(thinkingOffReason(METABOLOMICS, { messages: [user("hi")] }, config, 12_000), "low-output-budget");
  assert.equal(thinkingOffReason(METABOLOMICS, { messages: [user("hi")] }, config, 30_000), undefined);
  // Without a payload value: min(model.maxTokens, window - input). ~250k
  // tokens of input in a 262k window leaves ~12k.
  const nearFull = { messages: [user("word ".repeat(200_000))] };
  // A small model.maxTokens is an allowance too, whatever the window says.
  assert.equal(
    thinkingOffReason({ ...METABOLOMICS, maxTokens: 8_192 }, { messages: [user("hi")] }, config),
    "low-output-budget",
  );
  assert.equal(thinkingOffReason(METABOLOMICS, nearFull, config), "low-output-budget");
  assert.equal(thinkingOffReason(ELSEWHERE, nearFull, config), undefined);
  assert.equal(
    thinkingOffReason(METABOLOMICS, nearFull, resolveThinkingOffConfig({ PI_THINKING_OFF_LOW_BUDGET: "0" })),
    undefined,
  );
});

test("payload: reasoning_effort 'none' (never 'minimal'), and the chat-template switch agrees", () => {
  assert.deepEqual(applyThinkingOff({ model: "m", messages: [] }), {
    model: "m",
    messages: [],
    reasoning_effort: "none",
  });
  for (const effort of ["minimal", "low", "high"]) {
    assert.equal(
      (applyThinkingOff({ reasoning_effort: effort }) as { reasoning_effort: string }).reasoning_effort,
      "none",
    );
  }
  const templated = applyThinkingOff({ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }) as {
    chat_template_kwargs: Record<string, unknown>;
  };
  assert.deepEqual(templated.chat_template_kwargs, { enable_thinking: false, preserve_thinking: true });
  const original = { reasoning_effort: "high" };
  applyThinkingOff(original);
  assert.equal(original.reasoning_effort, "high", "the payload is copied, not mutated");
});

test("a 'length' stop Pi can recover from is left alone for Pi's compact-and-retry", () => {
  // Near the window pi-ai clamps max_tokens below model.maxTokens; Pi's
  // isRecoverableLength (output < model.maxTokens) then compacts and retries.
  const clamped = {
    role: "assistant",
    stopReason: "length",
    content: [{ type: "text", text: "The" }],
    usage: { input: 240_000, output: 13_107 },
  };
  assert.equal(describeHiddenReasoningTruncation(clamped, 32_768), undefined);
  assert.equal(isRecoverableLength(clamped as never, 32_768), true);
  assert.equal(describeHiddenReasoningTruncation(clamped, undefined), undefined, "unknown allowance: leave it");
});

test("a 'length' stop that spent the WHOLE allowance with almost no visible text is explained", () => {
  const cut = {
    role: "assistant",
    stopReason: "length",
    content: [{ type: "text", text: "The" }],
    usage: { input: 20_000, output: 32_768 },
  };
  assert.equal(isRecoverableLength(cut as never, 32_768), false, "Pi will not recover this one");
  const explained = describeHiddenReasoningTruncation(cut, 32_768);
  assert.ok(explained);
  assert.match(explained, /hidden reasoning/i);
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: explained } as never), false);
  assert.doesNotMatch(explained, /\d{3}/, "no digit runs Pi's retry matcher could catch");

  const real = { ...cut, content: [{ type: "text", text: "A full paragraph of real answer text that was cut off." }] };
  assert.equal(describeHiddenReasoningTruncation(real, 32_768), undefined);
  assert.equal(describeHiddenReasoningTruncation({ ...cut, stopReason: "stop" }, 32_768), undefined);
});

test("overriding a reasoning level the user set, for a small allowance, is logged", async () => {
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  try {
    let sent: Record<string, unknown> | undefined;
    const base = (_m: unknown, _c: unknown, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => {
        sent = (await options?.onPayload?.({ max_tokens: 9_000, reasoning_effort: "high" }, METABOLOMICS)) as never;
        return { stopReason: "stop" };
      },
    });
    const wrapped = streamWithThinkingPolicy(base as never, resolveThinkingOffConfig({}));
    await wrapped(METABOLOMICS, { systemPrompt: "You are Pi.", messages: [user("hi")] }, {} as never).result();
    assert.equal(sent?.reasoning_effort, "none");
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /reasoning "high" overridden/);

    // Room to spare: the user's level stands and nothing is logged.
    notices.length = 0;
    const roomy = (_m: unknown, _c: unknown, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => {
        sent = (await options?.onPayload?.({ max_tokens: 32_768, reasoning_effort: "high" }, METABOLOMICS)) as never;
        return { stopReason: "stop" };
      },
    });
    await streamWithThinkingPolicy(roomy as never, resolveThinkingOffConfig({}))(
      METABOLOMICS,
      { systemPrompt: "You are Pi.", messages: [user("hi")] },
      {} as never,
    ).result();
    assert.equal(sent?.reasoning_effort, "high");
    assert.deepEqual(notices, []);
  } finally {
    uninstall();
  }
});

test("interactive summarization and low-budget turns: no reasoning_effort unless compat grants it", async () => {
  const sendTo = async (
    m: { compat?: { supportsReasoningEffort?: boolean } },
    context: { systemPrompt?: string; messages: unknown[] },
    max: number,
  ) => {
    let sent: Record<string, unknown> | undefined;
    const base = (_m: unknown, _c: unknown, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => {
        sent = (await options?.onPayload?.({ max_tokens: max }, m)) as never;
        return { stopReason: "stop" };
      },
    });
    await streamWithThinkingPolicy(base as never, resolveThinkingOffConfig({}))(
      m,
      context as never,
      {} as never,
    ).result();
    assert.ok(sent);
    return sent;
  };
  const summary = await piSummarizationContext();
  const ordinary = { systemPrompt: "You are Pi.", messages: [user("hi")] };
  for (const [context, max] of [
    [summary, 13_107],
    [ordinary, 9_000],
  ] as const) {
    const nodeOnly = await sendTo(NODE_ONLY, context, max);
    assert.deepEqual(nodeOnly.chat_template_kwargs, { enable_thinking: false });
    assert.equal("reasoning_effort" in nodeOnly && nodeOnly.reasoning_effort !== undefined, false);
    const granted = await sendTo(METABOLOMICS, context, max);
    assert.deepEqual(granted.chat_template_kwargs, { enable_thinking: false });
    assert.equal(granted.reasoning_effort, "none");
  }
});

test("planner role keeps thinking on even with a low allowance or a summarization prompt", async () => {
  const config = resolveThinkingOffConfig({});
  const summary = await piSummarizationContext();
  const ordinary = { systemPrompt: "You are Pi.", messages: [user("hi")] };
  await runWithInferenceInvocation({ role: "planner" }, async () => {
    assert.equal(thinkingOffReason(METABOLOMICS, ordinary, config, 4_000), undefined);
    assert.equal(thinkingOffReason(METABOLOMICS, summary, config, 4_000), undefined);
    let sent: Record<string, unknown> | undefined;
    const base = (_m: unknown, _c: unknown, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => ({
      async *[Symbol.asyncIterator]() {},
      result: async () => {
        sent = (await options?.onPayload?.({ max_tokens: 4_000 }, METABOLOMICS)) as never;
        return { stopReason: "stop" };
      },
    });
    await streamWithThinkingPolicy(base as never, config)(METABOLOMICS, ordinary as never, {} as never).result();
    assert.deepEqual(sent, { max_tokens: 4_000 });
  });
  await runWithInferenceInvocation({ role: "implementer" }, async () => {
    assert.equal(thinkingOffReason(METABOLOMICS, ordinary, config, 4_000), "mission-role");
  });
});

test("override: the 27B model on a non-policy gateway is also never touched", async () => {
  const config = resolveThinkingOffConfig({});
  await runWithInferenceInvocation({ role: "implementer" }, async () => {
    const ordinary = { systemPrompt: "You are Pi.", messages: [user("hi")] };
    assert.equal(
      thinkingOffReason(
        { ...QWEN27, provider: "openai", baseUrl: "https://api.openai.com/v1" },
        ordinary,
        config,
        4_000,
      ),
      undefined,
    );
  });
});
