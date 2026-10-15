/**
 * Resuming a turn whose stream was cut, from the history that is already
 * there. Shared by the interactive extension (src/gateway/afterOutputRetry.ts,
 * which applies the edit as a `context_edit` entry) and the worker executor
 * (which applies it to the agent's message list).
 *
 * The rule: the cut turn's partial assistant message (stopReason "error") is
 * the ONLY thing dropped. Every tool call that executed already has its result
 * in the history and stays, so re-issuing the request on the same history does
 * not replay a side effect. The cut message cannot have executed anything: the
 * agent loop runs a message's tool calls only after the message finishes.
 */

import { isGatewayLinkCut, isTransportDrop } from "../gateway/signals.ts";
import { isTruncatedStream } from "../guard/transient.ts";

export interface AssistantLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

/** An assistant turn that ended in a provider/transport error. */
export function isFailedAssistantMessage(message: AssistantLike | undefined): boolean {
  return message?.role === "assistant" && message.stopReason === "error";
}

/**
 * Error text of a cut stream or dropped connection (not a gateway verdict):
 * "Stream ended without finish_reason", undici "terminated", a link cut.
 */
export function isCutStreamError(text: string | undefined): boolean {
  return isTruncatedStream(text) || isTransportDrop(text) || (text !== undefined && isGatewayLinkCut(text));
}

/**
 * The history to resume from: `messages` without its trailing failed
 * assistant message(s). Returns undefined when the history does not end in a
 * failed assistant message, or the remainder would not end in a toolResult or
 * user message (nothing a provider can continue from).
 */
export function dropFailedTail<T extends AssistantLike>(messages: readonly T[]): T[] | undefined {
  let end = messages.length;
  while (end > 0 && isFailedAssistantMessage(messages[end - 1])) end--;
  if (end === messages.length || end === 0) return undefined;
  const last = messages[end - 1]!.role;
  return last === "toolResult" || last === "user" ? messages.slice(0, end) : undefined;
}

/** Resumes per worker execution before a cut settles as truncated_after_progress. */
export const DEFAULT_STREAM_RESUME_MAX = 3;

/** PI_STREAM_RESUME_MAX: a non-negative integer; 0 disables resuming. */
export function resolveStreamResumeMax(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_STREAM_RESUME_MAX?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_STREAM_RESUME_MAX;
}
