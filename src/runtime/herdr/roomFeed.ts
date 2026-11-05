/**
 * Pure room-feed logic for the native Pi room client: cursor + de-duplication, SSE frame parsing, and terminal
 * rendering at three verbosities. No I/O, no timers.
 *
 * Herdr's room feed is ordered by a server-assigned `sequence` that is shared by every room, so a room's own
 * sequences are NOT contiguous and a "missing number" is never a gap. Gap recovery is therefore done by re-reading
 * from the last cursor (the server returns everything after it), never by counting.
 */

export type Verbosity = "simple" | "activity" | "expert";
export const VERBOSITIES: readonly Verbosity[] = ["simple", "activity", "expert"];

export interface RoomEvent {
  sequence: number;
  event_id: string;
  event_type: string;
  created_at?: string;
  room_id?: string;
  sender?: { type?: string; id?: string };
  text?: string;
  in_reply_to?: string | null;
  artifact_ids?: string[];
  mentions_me?: boolean;
  task?: { task_id?: string; status?: string; text?: string; target_agent_id?: string | null };
  actor_user_id?: string | null;
  actor_agent_id?: string | null;
  [k: string]: unknown;
}

export type Accept = "new" | "duplicate" | "invalid";

const MAX_SEEN = 4096;

export class RoomFeed {
  cursor: number;
  private readonly seen = new Set<string>();

  constructor(cursor = 0) {
    this.cursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  }

  /** Classify one event; a `new` event advances the cursor. Never throws. */
  accept(ev: unknown): Accept {
    if (!ev || typeof ev !== "object") return "invalid";
    const e = ev as Partial<RoomEvent>;
    if (typeof e.event_id !== "string" || typeof e.event_type !== "string") return "invalid";
    if (!Number.isSafeInteger(e.sequence) || (e.sequence as number) < 0) return "invalid";
    const seq = e.sequence as number;
    if (seq <= this.cursor || this.seen.has(e.event_id)) return "duplicate";
    this.seen.add(e.event_id);
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.cursor = seq;
    return "new";
  }

  /**
   * The server answered with a cursor BEHIND ours (its log was restored or truncated). Adopt the server's so the
   * feed does not wait for sequences that will never come; the caller must tell the user. True when it regressed.
   */
  adoptServerCursor(next: unknown): boolean {
    if (!Number.isSafeInteger(next) || (next as number) < 0 || (next as number) >= this.cursor) return false;
    this.cursor = next as number;
    this.seen.clear();
    return true;
  }
}

/** Incremental SSE parser: feed text chunks, get the JSON `data:` payloads. Comments (keep-alives) are dropped. */
export class SseParser {
  private buf = "";
  static readonly MAX_BUFFER = 1024 * 1024;

  /** Throws RangeError when one frame exceeds MAX_BUFFER (a hostile or broken stream). */
  push(chunk: string): unknown[] {
    this.buf += chunk.replace(/\r\n/g, "\n");
    if (this.buf.length > SseParser.MAX_BUFFER) throw new RangeError("sse frame too large");
    const out: unknown[] = [];
    let i = this.buf.indexOf("\n\n");
    while (i >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) {
        try {
          out.push(JSON.parse(data));
        } catch {
          // a malformed frame is skipped; the cursor re-read recovers anything it carried
        }
      }
      i = this.buf.indexOf("\n\n");
    }
    return out;
  }
}

// C0/C1 controls (keeping \n and \t), DEL, zero-width and bidi override characters: a room message is untrusted text
// and must not be able to move the cursor, recolour the terminal or reorder what the user reads.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// A whole escape sequence is removed first so its printable tail does not survive.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escape sequences is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

export function safeText(text: unknown, max = 4000): string {
  const s = typeof text === "string" ? text : "";
  const clean = s.replace(ANSI, "").replace(UNSAFE, "");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const TASK_FINAL = new Set(["completed", "done", "failed", "rejected", "cancelled", "blocked", "needs_input"]);

function who(ev: RoomEvent): string {
  const s = ev.sender;
  if (s?.id) return safeText(`${s.type && s.type !== "user" ? `${s.type}:` : ""}${s.id}`, 80);
  return safeText(ev.actor_agent_id ?? ev.actor_user_id ?? "system", 80);
}

function clock(ev: RoomEvent): string {
  const t = typeof ev.created_at === "string" ? ev.created_at : "";
  const m = /T(\d\d:\d\d)/.exec(t);
  return m ? (m[1] as string) : "--:--";
}

/**
 * One terminal line (or block) for an event, or null when this verbosity hides it.
 *  - simple:   chat, plus a task only when it needs attention or has finished;
 *  - activity: + every task change and other room activity as a quiet one-liner;
 *  - expert:   + sequence and event id on everything, and events of any type.
 */
export function renderEvent(ev: RoomEvent, level: Verbosity): string | null {
  const expert = level === "expert" ? ` #${ev.sequence} ${safeText(ev.event_id, 64)}` : "";
  if (ev.event_type === "message") {
    const body = safeText(ev.text).split("\n").join("\n    ");
    const me = ev.mentions_me ? " (mentions you)" : "";
    const arts = ev.artifact_ids?.length
      ? ` [${ev.artifact_ids.length} artifact${ev.artifact_ids.length > 1 ? "s" : ""}]`
      : "";
    return `${clock(ev)} ${who(ev)}${me}: ${body}${arts}${expert}`;
  }
  if (ev.event_type === "task_created" || ev.event_type === "task_updated") {
    const t = ev.task ?? {};
    const status = safeText(t.status ?? "pending", 24);
    if (level === "simple" && !TASK_FINAL.has(status)) return null;
    return `${clock(ev)} · task ${status}: ${safeText(t.text ?? "", 160)}${expert}`;
  }
  if (level === "simple") return null;
  return `${clock(ev)} · ${safeText(ev.event_type.replace(/_/g, " "), 60)}${expert}`;
}
