/**
 * Custom instructions for every compaction summary (session review).
 *
 * Long sessions drift: after a few compactions the summary's Goal still named
 * the first request of the session while the operator had since handed over a
 * new spec, completed goals were carried forward as if open, and summaries
 * grew with every round. These instructions anchor the Goal on the latest user
 * request, drop finished goals, and cap the summary's length. They are added
 * to whatever focus the caller (e.g. `/compact <focus>`) supplied.
 */

/** Target ceiling for the summary, stated to the summarizer. */
export const SUMMARY_WORD_CAP = 900;
/** Longest slice of the latest request quoted into the instructions. */
const MAX_REQUEST_CHARS = 2_000;

interface EntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** The text of the most recent user message on the branch, if any. */
export function latestUserRequest(entries: readonly unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as EntryLike | undefined;
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = messageText(entry.message.content).trim();
    if (text) return text;
  }
  return undefined;
}

function clip(text: string): string {
  if (text.length <= MAX_REQUEST_CHARS) return text;
  const head = text.slice(0, MAX_REQUEST_CHARS * 0.75);
  const tail = text.slice(-MAX_REQUEST_CHARS * 0.25);
  return `${head}\n[…]\n${tail}`;
}

export function summaryInstructions(entries: readonly unknown[], callerFocus: string | undefined): string {
  const latest = latestUserRequest(entries);
  const parts = [
    latest
      ? `Anchor the summary's Goal on the user's most recent request/spec, quoted between the markers below. It supersedes earlier goals wherever they conflict.\n<<<LATEST USER REQUEST\n${clip(latest)}\nLATEST USER REQUEST>>>`
      : "Anchor the summary's Goal on the user's most recent request.",
    "Drop completed goals from the Goal section: mention finished work at most once, briefly, under progress. Do not carry earlier goals forward as open unless the user is still asking for them.",
    `Keep the whole summary under about ${SUMMARY_WORD_CAP} words: prefer file paths, decisions and next steps over narrative.`,
  ];
  if (callerFocus?.trim()) parts.push(`Additional focus from the caller: ${callerFocus.trim()}`);
  return parts.join("\n\n");
}
