/**
 * Cross-turn repeated-tool-call guard for workers.
 *
 * GenerationGuard only reads text inside ONE generation, and the session-level
 * tool-call guard (src/guard/toolCallGuard.ts) is a host hook for the
 * foreground agent. A worker that re-sends the same tool call every turn (a
 * live run sent the same `bash` heredoc 11 times over 22 minutes, only the
 * scratch file name changing, and never called worker_result) trips neither.
 * This detector watches COMPLETED tool calls across turns.
 *
 * Two completed calls are "the same" when ALL hold:
 *   1. same tool name;
 *   2. same arguments after normalisation: object keys sorted, every run of
 *      whitespace in every string collapsed to one space, ends trimmed;
 *      for `bash` a short scratch file the command itself creates (see
 *      maskScratchNames) is masked, so `cat > pa.mjs <<EOF ... node pa.mjs` and
 *      the same command with `pb.mjs` compare equal;
 *   3. the same result text (same normalisation, same scratch-name masking) and
 *      the same isError flag.
 * Condition 3 is what keeps polling safe: the same status command whose output
 * changes is progress, not a loop.
 *
 * The streak is the number of consecutive "same" completed calls. It resets on
 * any call that is not the same (a different tool, different args, different
 * output) and on any file-changing tool call (edit, write, ...), so re-running
 * a test command after an edit never counts. Reaching `limit` trips the guard.
 */

/** Tools that change files: executing one always resets the streak. */
export const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "apply_patch",
  "notebook_edit",
  "notebookedit",
]);

export interface ToolLoopTrip {
  tool: string;
  count: number;
  limit: number;
  /** The last call's arguments, JSON, truncated. */
  lastArgs: string;
}

const MAX_ARG_CHARS = 200;
/** Result text longer than this is compared by its head and tail plus length. */
const RESULT_KEY_CHARS = 4000;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Mask scratch files a bash command creates: a bare file name (no directory) of
 * at most 4 stem characters that is the target of `>`, `>>` or `tee`
 * (`cat > pa.mjs <<EOF`). Every occurrence of that exact name is replaced by
 * `<scratch>.ext`. Names with a directory, longer stems, or files that are only
 * read are never masked, so `cat a.txt` vs `cat b.txt` stay different.
 */
export function maskScratchNames(text: string, command: string): string {
  const names = new Set<string>();
  for (const m of command.matchAll(/(?:>>?|\btee(?:\s+-a)?)\s*([A-Za-z0-9_]{1,4})\.([A-Za-z0-9]{1,5})(?![\w./-])/g)) {
    names.add(`${m[1]}.${m[2]}`);
  }
  let out = text;
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    out = out.replace(
      new RegExp(`(?<![\\w./-])${name.slice(0, dot)}\\.${name.slice(dot + 1)}(?![\\w-])`, "g"),
      `<scratch>.${name.slice(dot + 1)}`,
    );
  }
  return out;
}

function normalizeValue(v: unknown, command: string | undefined): unknown {
  if (typeof v === "string") return collapse(command ? maskScratchNames(v, command) : v);
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x, command));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, normalizeValue(x, command)]),
    );
  }
  return v;
}

/** Comparison key for one completed call. Exported for tests. */
export function callKey(tool: string, args: unknown, resultText: string, isError: boolean): string {
  const command =
    tool === "bash" && args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string"
      ? (args as { command: string }).command
      : undefined;
  let result = collapse(command ? maskScratchNames(resultText, command) : resultText);
  if (result.length > RESULT_KEY_CHARS) {
    result = `${result.slice(0, RESULT_KEY_CHARS / 2)}…${result.length}…${result.slice(-RESULT_KEY_CHARS / 2)}`;
  }
  return JSON.stringify([tool, normalizeValue(args, command), result, isError]);
}

export class ToolLoopDetector {
  private key: string | undefined;
  private count = 0;

  /** @param limit consecutive identical completed calls that trip the guard (>= 2) */
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  /** Record one COMPLETED tool call; returns a trip when the streak reaches the limit. */
  observe(tool: string, args: unknown, resultText: string, isError: boolean): ToolLoopTrip | undefined {
    if (FILE_CHANGING_TOOLS.has(tool.toLowerCase())) {
      this.key = undefined;
      this.count = 0;
      return undefined;
    }
    const key = callKey(tool, args, resultText, isError);
    if (key === this.key) this.count += 1;
    else {
      this.key = key;
      this.count = 1;
    }
    if (this.count < this.limit) return undefined;
    let lastArgs: string;
    try {
      lastArgs = JSON.stringify(args) ?? "";
    } catch {
      lastArgs = String(args);
    }
    if (lastArgs.length > MAX_ARG_CHARS) lastArgs = `${lastArgs.slice(0, MAX_ARG_CHARS)}…`;
    return { tool, count: this.count, limit: this.limit, lastArgs };
  }
}

/** Text of a tool result's content parts (the agent loop's `{content:[{type:"text",text}]}`). */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : "",
    )
    .join("\n");
}
