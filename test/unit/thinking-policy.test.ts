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
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import {
  applyThinkingOff,
  describeHiddenReasoningTruncation,
  isSummarizationRequest,
  resolveThinkingOffConfig,
  thinkingOffReason,
} from "../../src/request/thinkingPolicy.ts";

const METABOLOMICS = {
  id: "qwen3.8-27b-modality-vision-quant-q8_k_xl",
  provider: "metabolomics",
  api: "openai-completions",
  baseUrl: "https://llm.metabolomics.us/v1",
  contextWindow: 262_144,
  maxTokens: 32_768,
};
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
  assert.equal(config.lowOutputBudgetTokens, 32_768);
  assert.ok(config.gatewayHosts.includes("llm.metabolomics.us"));
  assert.ok(config.providers.includes("metabolomics"));

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

test("policy: an ordinary turn keeps thinking unless the output room left is small", () => {
  const config = resolveThinkingOffConfig({});
  assert.equal(thinkingOffReason(METABOLOMICS, { messages: [user("hi")] }, config), undefined);
  // ~240k tokens of input in a 262k window: under 32k left for thinking + answer.
  const nearFull = { messages: [user("word ".repeat(240_000))] };
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

test("a 'length' stop with almost no visible text is explained, not shown as 'The'", () => {
  const cut = {
    role: "assistant",
    stopReason: "length",
    content: [{ type: "text", text: "The" }],
    usage: { input: 240_000, output: 13_107 },
  };
  const explained = describeHiddenReasoningTruncation(cut);
  assert.ok(explained);
  assert.match(explained, /hidden reasoning/i);
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: explained } as never), false);
  assert.doesNotMatch(explained, /\d{3}/, "no digit runs Pi's retry matcher could catch");

  const real = { ...cut, content: [{ type: "text", text: "A full paragraph of real answer text that was cut off." }] };
  assert.equal(describeHiddenReasoningTruncation(real), undefined);
  assert.equal(describeHiddenReasoningTruncation({ ...cut, stopReason: "stop" }), undefined);
  assert.equal(describeHiddenReasoningTruncation({ ...cut, usage: { input: 10, output: 3 } }), undefined);
});
