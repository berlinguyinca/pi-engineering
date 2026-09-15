/**
 * Streaming-text extraction for the GenerationGuard.
 *
 * Pi's `message_update` carries BOTH the accumulated partial message and the
 * incremental stream event that produced it. The guard's budgets are
 * incremental, so it must be fed the delta — feeding `message.content` on every
 * update charges each token once per streaming event (quadratic growth), which
 * trips `excessive_narration` after a couple of hundred real tokens.
 *
 * The delta lives under a different field depending on which layer emits the
 * event (`assistantMessageEvent` in the extension API, `event` in the
 * agent-core harness stream consumed by `session.subscribe`), so both spellings
 * are read here, in one place, rather than in each call site.
 */

/** What the guard should be charged for one streaming update. */
export type GuardFeed =
  /** An incremental chunk: charge it directly. */
  | { kind: "delta"; text: string }
  /** No delta available: charge the unseen tail of the accumulated text. */
  | { kind: "snapshot"; text: string };

interface StreamEvent {
  type?: string;
  delta?: string;
}

/** Read the stream event under either of the two field names Pi uses. */
function streamEvent(event: unknown): StreamEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as { assistantMessageEvent?: unknown; event?: unknown };
  const candidate = e.assistantMessageEvent ?? e.event;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as StreamEvent;
}

/** Concatenate the text blocks of an assistant message's content. */
export function assistantMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  return text;
}

/**
 * Decide what (if anything) a streaming update contributes to the guard.
 *
 * Returns `null` for updates that carry no new assistant TEXT — thinking and
 * tool-call deltas, and the bookkeeping start/end events. Thinking tokens are
 * deliberately excluded: the thresholds are calibrated to visible narration.
 */
export function guardFeedFor(event: unknown, content: unknown): GuardFeed | null {
  const se = streamEvent(event);
  if (se?.type === "text_delta") {
    return typeof se.delta === "string" && se.delta.length > 0 ? { kind: "delta", text: se.delta } : null;
  }
  if (se?.type !== undefined) {
    // A known non-text stream event (thinking_*, toolcall_*, text_start/end,
    // start/done). Nothing new to charge.
    return null;
  }
  // No recognizable stream event (e.g. a `message_end`-shaped payload, or a
  // future event shape): fall back to snapshot accounting, which diffs against
  // what the guard has already consumed.
  const text = assistantMessageText(content);
  return text ? { kind: "snapshot", text } : null;
}
