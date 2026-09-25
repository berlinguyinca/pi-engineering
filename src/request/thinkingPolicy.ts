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
 * 2. Ordinary turns whose real output allowance is small: thinking off, so a
 *    near-full context still answers instead of spending its last tokens on
 *    reasoning nobody sees. The allowance is the `max_tokens` pi-ai actually
 *    puts in the payload — `min(maxTokens, window - input - safety)`, already
 *    clamped by pi-ai — read inside `onPayload`; without one it is estimated as
 *    `min(model.maxTokens, window - input)`. Threshold 16k tokens: pi-ai's own
 *    "high" thinking budget and Pi's default compaction reserve, and above the
 *    8–13k tokens these models were measured spending on hidden reasoning — an
 *    allowance below it can be consumed by thinking alone. Default on; a turn
 *    with room keeps thinking, and overriding a reasoning level the user set is
 *    logged.
 * 3. A reply cut at "length" with almost no visible text becomes a clear error
 *    instead of a one-word answer — but ONLY when it spent the model's whole
 *    `maxTokens`. A shorter (window-clamped) length stop is exactly what Pi's
 *    own recovery handles (`isRecoverableLength`: output < model.maxTokens →
 *    drop the message, compact, retry once), so it is left untouched.
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { emitTelemetry } from "../telemetry/sink.ts";

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
  lowOutputBudgetTokens: 16_384,
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
  maxTokens?: number;
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

/**
 * The system prompt of a provider context, in either shape pi-ai has used:
 * `context.systemPrompt` (≤ 0.85), or a leading `{ role: "system" }` message
 * (0.87+, where `normalizeContext` folds the prompt and tools into the
 * transcript — the shape Pi's compaction now sends).
 */
export function systemPromptText(context: ThinkingContext): string {
  if (typeof context.systemPrompt === "string") return context.systemPrompt;
  const first = context.messages[0] as { role?: string; content?: unknown } | undefined;
  if (first?.role !== "system") return "";
  if (typeof first.content === "string") return first.content;
  if (!Array.isArray(first.content)) return "";
  return (first.content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

export function isSummarizationRequest(context: ThinkingContext): boolean {
  return systemPromptText(context).trimStart().startsWith(SUMMARIZATION_PROMPT_OPENING);
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

/**
 * @param allowance the provider-clamped output allowance (`max_tokens` from
 *   the payload) when known; otherwise it is estimated.
 */
export function thinkingOffReason(
  model: ThinkingModel,
  context: ThinkingContext,
  config: ThinkingOffConfig,
  allowance?: number,
): ThinkingOffReason | undefined {
  if (!acceptsThinkingOff(model, config)) return undefined;
  if (config.summaries && isSummarizationRequest(context)) return "summarization";
  if (config.lowOutputBudget) {
    const room = allowance ?? estimatedAllowance(model, context);
    if (room !== undefined && room < config.lowOutputBudgetTokens) return "low-output-budget";
  }
  return undefined;
}

function estimatedAllowance(model: ThinkingModel, context: ThinkingContext): number | undefined {
  // The window term may be zero or negative (an overfull context): that is the
  // smallest allowance of all, not a missing one.
  const window = model.contextWindow ? model.contextWindow - estimateInputTokens(context) : undefined;
  const candidates = [model.maxTokens && model.maxTokens > 0 ? model.maxTokens : undefined, window].filter(
    (n): n is number => typeof n === "number",
  );
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/** The output allowance pi-ai wrote into an openai-completions payload. */
function payloadAllowance(payload: unknown): number | undefined {
  const p = payload as { max_tokens?: unknown; max_completion_tokens?: unknown } | null;
  const n = p?.max_tokens ?? p?.max_completion_tokens;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** A reasoning level the caller asked for, as it appears in the payload. */
function requestedReasoning(payload: unknown): string | undefined {
  const p = payload as { reasoning_effort?: unknown; chat_template_kwargs?: { enable_thinking?: unknown } } | null;
  if (typeof p?.reasoning_effort === "string" && p.reasoning_effort !== "none") return p.reasoning_effort;
  if (p?.chat_template_kwargs?.enable_thinking === true) return "on";
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
 * Explain a reply cut at "length" that shows almost nothing because the model
 * spent its WHOLE output allowance (`maxTokens`) on hidden reasoning.
 * Undefined for anything else — in particular for a length stop below
 * `maxTokens`, which Pi recovers from itself (compact and retry), and when the
 * allowance is unknown.
 * Carries "out of budget" (Pi's retry matcher treats it as final) and no
 * digits (which that matcher, lacking word boundaries, could catch).
 */
export function describeHiddenReasoningTruncation(
  message: AssistantLike | undefined,
  maxTokens: number | undefined,
): string | undefined {
  if (!message || message.stopReason !== "length") return undefined;
  if (!maxTokens || maxTokens <= 0 || (message.usage?.output ?? 0) < maxTokens) return undefined;
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
    const userHook = (options as { onPayload?: (payload: unknown, m: unknown) => unknown } | undefined)?.onPayload;
    // Decided inside onPayload, where the provider-clamped max_tokens — the
    // real output allowance — is known.
    const effective = {
      ...(options ?? {}),
      onPayload: async (payload: unknown, m: unknown) => {
        const reason = thinkingOffReason(model, context, config, payloadAllowance(payload));
        const edited = reason ? applyThinkingOff(payload) : payload;
        const requested = requestedReasoning(payload);
        if (reason === "low-output-budget" && requested) {
          emitTelemetry({
            level: "info",
            key: "thinking-off:low-output-budget",
            text: `Thinking off for this turn: reasoning "${requested}" overridden, only about ${payloadAllowance(payload) ?? "a few thousand"} output tokens are left, which hidden reasoning would use up.`,
          });
        }
        const next = await userHook?.(edited, m);
        return next === undefined ? edited : next;
      },
    } as O;
    const inner = base(model, context, effective);
    const explain = (message: R): R => {
      const described = describeHiddenReasoningTruncation(message, model.maxTokens);
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
