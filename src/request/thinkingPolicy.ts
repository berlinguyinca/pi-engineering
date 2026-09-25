/**
 * Thinking OFF where hidden reasoning would eat the output budget.
 *
 * The metabolomics/InferWeave gateway's models (deepseek v4 flash, qwen3.8
 * flash_next, qwen3.8 27b) think by default on the server. Pi's models.json
 * registers them `reasoning: false`, so Pi never sends a reasoning parameter,
 * yet the reasoning tokens still count against `max_tokens`. Two failures
 * follow on a long conversation:
 *
 * - Pi's compaction asks for at most `min(0.8 * reserveTokens, maxTokens)`
 *   tokens (13,107 by default; half that for a turn-prefix summary) and fails
 *   on stopReason "length". On a ~200k-token conversation the hidden thinking
 *   spends it, so auto-compaction fails, then overflow recovery fails.
 * - Near the context window an ordinary turn has little output room left; it
 *   thinks it away and is cut off after "The".
 *
 * Measured against the gateway: `reasoning_effort: "none"` gives zero
 * reasoning tokens on all three model families, as does the chat template's
 * `enable_thinking: false`; "low" does not reduce reasoning, and "minimal" is
 * a 502 on the qwen models — so only "none" is ever sent.
 *
 * Policy, applied in the provider seam we already own (the gateway
 * stream-retry wrapper and the worker runtime guard), only for openai-
 * completions models on gateways known to accept "none":
 *
 * 1. Pi summarization requests (compaction, turn prefix, branch summary):
 *    thinking off. A summary is a transcription task; thinking buys nothing.
 * 2. Ordinary turns whose remaining output room (context window minus the
 *    estimated input) is under a threshold (32k tokens): thinking off, so a
 *    near-full context still answers instead of spending its last tokens on
 *    reasoning nobody sees. Default on; a turn with room keeps thinking.
 * 3. A reply still cut at "length" with almost no visible text becomes a clear
 *    error instead of a one-word answer.
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";

export interface ThinkingOffConfig {
  /** Thinking off for Pi summarization requests (PI_THINKING_OFF_SUMMARIES). */
  summaries: boolean;
  /** Thinking off when output room is small (PI_THINKING_OFF_LOW_BUDGET). */
  lowOutputBudget: boolean;
  /** "Small" output room, in tokens (PI_THINKING_OFF_LOW_BUDGET_TOKENS). */
  lowOutputBudgetTokens: number;
  /** Gateway hosts known to accept `reasoning_effort: "none"` (PI_THINKING_OFF_GATEWAYS). */
  gatewayHosts: string[];
  /** Provider ids known to accept it (PI_THINKING_OFF_PROVIDERS). */
  providers: string[];
}

export const DEFAULT_THINKING_OFF_CONFIG: ThinkingOffConfig = {
  summaries: true,
  lowOutputBudget: true,
  lowOutputBudgetTokens: 32_768,
  gatewayHosts: ["llm.metabolomics.us"],
  providers: ["metabolomics"],
};

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveThinkingOffConfig(env: Record<string, string | undefined> = process.env): ThinkingOffConfig {
  const tokens = Number(env.PI_THINKING_OFF_LOW_BUDGET_TOKENS);
  return {
    summaries: flag(env.PI_THINKING_OFF_SUMMARIES, DEFAULT_THINKING_OFF_CONFIG.summaries),
    lowOutputBudget: flag(env.PI_THINKING_OFF_LOW_BUDGET, DEFAULT_THINKING_OFF_CONFIG.lowOutputBudget),
    lowOutputBudgetTokens:
      Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : DEFAULT_THINKING_OFF_CONFIG.lowOutputBudgetTokens,
    gatewayHosts: list(env.PI_THINKING_OFF_GATEWAYS, DEFAULT_THINKING_OFF_CONFIG.gatewayHosts),
    providers: list(env.PI_THINKING_OFF_PROVIDERS, DEFAULT_THINKING_OFF_CONFIG.providers),
  };
}

export interface ThinkingModel {
  api?: string;
  provider?: string;
  baseUrl?: string;
  contextWindow?: number;
}

/** Is `model` served by a gateway known to accept `reasoning_effort: "none"`? */
export function acceptsThinkingOff(model: ThinkingModel, config: ThinkingOffConfig): boolean {
  if (model.api !== "openai-completions") return false;
  if (model.provider && config.providers.includes(model.provider.toLowerCase())) return true;
  try {
    return model.baseUrl !== undefined && config.gatewayHosts.includes(new URL(model.baseUrl).host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Pi's SUMMARIZATION_SYSTEM_PROMPT (pi-coding-agent core/compaction/utils.js),
 * used for compaction, turn-prefix and branch summaries. The package does not
 * export it, so its opening sentence is matched — stable wording, and specific
 * enough that no ordinary system prompt starts with it.
 */
const SUMMARIZATION_PROMPT_OPENING = "You are a context summarization assistant.";

export interface ThinkingContext {
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
}

export function isSummarizationRequest(context: ThinkingContext): boolean {
  return (context.systemPrompt ?? "").trimStart().startsWith(SUMMARIZATION_PROMPT_OPENING);
}

/** Estimated input tokens, the way Pi's own compaction estimates them. */
function estimateInputTokens(context: ThinkingContext): number {
  let tokens = Math.ceil((context.systemPrompt?.length ?? 0) / 4);
  for (const message of context.messages) {
    try {
      tokens += estimateTokens(message as never);
    } catch {
      tokens += Math.ceil(JSON.stringify(message ?? "").length / 4);
    }
  }
  if (context.tools?.length) tokens += Math.ceil(JSON.stringify(context.tools).length / 4);
  return tokens;
}

export type ThinkingOffReason = "summarization" | "low-output-budget";

export function thinkingOffReason(
  model: ThinkingModel,
  context: ThinkingContext,
  config: ThinkingOffConfig,
): ThinkingOffReason | undefined {
  if (!acceptsThinkingOff(model, config)) return undefined;
  if (config.summaries && isSummarizationRequest(context)) return "summarization";
  if (config.lowOutputBudget && model.contextWindow) {
    const room = model.contextWindow - estimateInputTokens(context);
    if (room < config.lowOutputBudgetTokens) return "low-output-budget";
  }
  return undefined;
}

/**
 * A copy of `payload` with thinking off: `reasoning_effort: "none"` (never
 * "minimal", which the qwen models reject with a 502), and a chat template's
 * `enable_thinking` switched off when the payload carries one.
 */
export function applyThinkingOff(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>), reasoning_effort: "none" };
  const kwargs = next.chat_template_kwargs;
  if (kwargs && typeof kwargs === "object") {
    next.chat_template_kwargs = { ...(kwargs as Record<string, unknown>), enable_thinking: false };
  }
  return next;
}

interface AssistantLike {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
  usage?: { input?: number; output?: number };
}

const VISIBLE_CHAR_LIMIT = 40;
const MIN_HIDDEN_OUTPUT_TOKENS = 256;

/**
 * Explain a reply cut at "length" that shows almost nothing: the model spent
 * its output allowance on hidden reasoning. Undefined for anything else.
 * Carries "out of budget" (Pi's retry matcher treats it as final) and no
 * digits (which that matcher, lacking word boundaries, could catch).
 */
export function describeHiddenReasoningTruncation(message: AssistantLike | undefined): string | undefined {
  if (!message || message.stopReason !== "length") return undefined;
  const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string }>) : [];
  const visible = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (visible.length > VISIBLE_CHAR_LIMIT) return undefined;
  const output = message.usage?.output ?? 0;
  if (output < Math.max(MIN_HIDDEN_OUTPUT_TOKENS, Math.ceil(visible.length / 4) * 8)) return undefined;
  const shown = visible ? `"${visible}"` : "nothing";
  return `The model was cut off after ${shown}: it spent its whole output allowance on hidden reasoning before answering, so the reply is out of budget as sent. Thinking is switched off automatically for summaries and near-full contexts on gateways that support it; compact the conversation (/compact) or start a new session, then ask again.`;
}

interface AttemptLike<E, R> extends AsyncIterable<E> {
  result(): Promise<R>;
}

/**
 * Wrap a `streamSimple(model, context, options)` with the thinking policy:
 * thinking off in the provider payload when `thinkingOffReason` says so (via
 * pi-ai's `onPayload`, ahead of any user hook, which still sees and may change
 * the final payload), and a hidden-reasoning cut-off turned into a clear error.
 * Models outside the policy's gateways pass through untouched.
 */
export function streamWithThinkingPolicy<
  M extends ThinkingModel,
  C extends ThinkingContext,
  O,
  E extends { type?: string; message?: R },
  R extends AssistantLike,
>(
  base: (model: M, context: C, options?: O) => AttemptLike<E, R>,
  config: ThinkingOffConfig,
): (model: M, context: C, options?: O) => AttemptLike<E, R> {
  return (model, context, options) => {
    if (!acceptsThinkingOff(model, config)) return base(model, context, options);
    const reason = thinkingOffReason(model, context, config);
    const userHook = (options as { onPayload?: (payload: unknown, m: unknown) => unknown } | undefined)?.onPayload;
    const effective = reason
      ? ({
          ...(options ?? {}),
          onPayload: async (payload: unknown, m: unknown) => {
            const off = applyThinkingOff(payload);
            const next = await userHook?.(off, m);
            return next === undefined ? off : next;
          },
        } as O)
      : options;
    const inner = base(model, context, effective);
    const explain = (message: R): R => {
      const described = describeHiddenReasoningTruncation(message);
      return described ? { ...message, stopReason: "error", errorMessage: described } : message;
    };
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of inner) {
          if (event.type === "done" && event.message) {
            const explained = explain(event.message);
            if (explained !== event.message) {
              yield { type: "error", reason: "error", error: explained } as unknown as E;
              continue;
            }
          }
          yield event;
        }
      },
      result: async () => explain(await inner.result()),
    };
  };
}
