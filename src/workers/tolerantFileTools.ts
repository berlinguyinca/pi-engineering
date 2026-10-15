import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * File tools for mission workers. They wrap Pi's built-in `read` and `edit`
 * (same names, so they replace the built-ins in the session) rather than
 * patching Pi: `read` numbers its lines, and `edit` retries a missed exact
 * match with whitespace-normalised matching before failing with candidate lines
 * the model can copy from.
 */

type TextBlock = { type: string; text?: string };
type ToolResult = { content: TextBlock[]; details?: unknown };
type EditPair = { oldText: string; newText: string };

const NOTICE_TAIL = /\n\n(\[(?:Showing lines|\d+ more lines)[^\n]*\])$/;

/** Pi's `read`, with every returned text line prefixed by `<line number><TAB>`. */
export function createNumberedReadTool(cwd: string): ToolDefinition {
  const base = createReadToolDefinition(cwd) as unknown as ToolDefinition;
  return {
    ...base,
    description: `${base.description} Every line is prefixed with its 1-based line number and a tab; the prefix is not part of the file, so leave it out of edit oldText.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = (await base.execute(toolCallId, params, signal, onUpdate, ctx)) as ToolResult;
      const block = result.content[0];
      if (result.content.length !== 1 || block?.type !== "text" || typeof block.text !== "string") return result;
      if (block.text.startsWith("[Line ")) return result;
      const notice = NOTICE_TAIL.exec(block.text);
      const body = notice ? block.text.slice(0, notice.index) : block.text;
      if (body.length === 0) return result;
      const offset = (params as { offset?: number }).offset;
      const first = offset && offset > 0 ? offset : 1;
      const numbered = body
        .split("\n")
        .map((line, index) => `${first + index}\t${line}`)
        .join("\n");
      return { ...result, content: [{ ...block, text: notice ? `${numbered}\n\n${notice[1]}` : numbered }] };
    },
  } as ToolDefinition;
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? "";
const bigrams = (text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
};

/** Dice coefficient of two strings' character bigrams (1 = identical). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

const MAX_CANDIDATE_LINES = 20;
const MAX_LINE_CHARS = 200;
const MAX_ERROR_CHARS = 4096;

/** Numbered lines from `from` (0-based), capped per candidate; long lines are clipped. */
const numbered = (lines: string[], from: number, count: number): string => {
  const shown = Math.min(count, MAX_CANDIDATE_LINES);
  const out = lines
    .slice(from, from + shown)
    .map(
      (line, index) =>
        `${from + index + 1}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line}`,
    );
  if (count > shown) out.push(`... (${count - shown} more lines)`);
  return out.join("\n");
};

/** A match with two lines of context on each side, so repeated matches can be told apart. */
const withContext = (lines: string[], start: number, count: number): string => {
  const from = Math.max(0, start - 2);
  return numbered(lines, from, Math.min(count, MAX_CANDIDATE_LINES) + (start - from) + 2);
};

const capped = (message: string): Error =>
  new Error(message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}\n... (truncated)` : message);

function trimmedWindows(fileLines: string[], oldKeys: string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + oldKeys.length <= fileLines.length; start++) {
    if (oldKeys.every((key, i) => fileLines[start + i]?.trim() === key)) starts.push(start);
  }
  return starts;
}

function closestCandidates(fileLines: string[], oldLines: string[]): string {
  const anchor = oldLines.find((line) => line.trim().length > 0)?.trim() ?? "";
  const anchorOffset = oldLines.findIndex((line) => line.trim().length > 0);
  const scored = fileLines
    .map((line, index) => ({ index, score: similarity(anchor, line.trim()) }))
    .filter((entry) => entry.score >= 0.4)
    .sort((x, y) => y.score - x.score || x.index - y.index);
  const picked: number[] = [];
  for (const entry of scored) {
    const start = Math.max(0, entry.index - anchorOffset);
    if (picked.every((other) => Math.abs(other - start) >= oldLines.length)) picked.push(start);
    if (picked.length === 2) break;
  }
  if (picked.length === 0) return "No similar lines were found in the file.";
  return picked
    .map(
      (start) =>
        `Closest candidate (lines ${start + 1}-${Math.min(fileLines.length, start + oldLines.length)}):\n${numbered(fileLines, start, oldLines.length)}`,
    )
    .join("\n\n");
}

/**
 * Why indentation cannot be mapped safely, or undefined when it can: the same
 * model-side indent landing on different file indents (a flattened block), or a
 * window that mixes tab and space indentation.
 */
function unsafeIndentation(oldLines: string[], fileWindow: string[]): string | undefined {
  const seen = new Map<string, string>();
  let tabs = false;
  let spaces = false;
  for (const [i, line] of oldLines.entries()) {
    if (line.trim().length === 0) continue;
    const fileIndent = indentOf(fileWindow[i] ?? "");
    if (fileIndent.includes("\t")) tabs = true;
    if (fileIndent.includes(" ")) spaces = true;
    const previous = seen.get(indentOf(line));
    if (previous !== undefined && previous !== fileIndent)
      return "the indentation in oldText does not follow the file's nesting";
    seen.set(indentOf(line), fileIndent);
  }
  return tabs && spaces ? "the matched lines mix tab and space indentation" : undefined;
}

/** Re-indent `newText` from the model's indentation onto the file's, using the matched line pairs. */
function reindent(newText: string, oldLines: string[], fileWindow: string[]): string {
  const map = new Map<string, string>();
  oldLines.forEach((line, i) => {
    if (line.trim().length > 0) map.set(indentOf(line), indentOf(fileWindow[i] ?? ""));
  });
  if ([...map].every(([from, to]) => from === to)) return newText;
  return newText
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return line;
      const indent = indentOf(line);
      const exact = map.get(indent);
      if (exact !== undefined) return exact + line.slice(indent.length);
      const prefix = [...map.keys()].filter((key) => indent.startsWith(key)).sort((x, y) => y.length - x.length)[0];
      return prefix === undefined ? line : (map.get(prefix) ?? "") + line.slice(prefix.length);
    })
    .join("\n");
}

type Resolution = { edit: EditPair; tolerant: boolean };

function resolveEdit(content: string, edit: EditPair, index: number, path: string): Resolution {
  const oldText = edit.oldText.replace(/\r\n/g, "\n");
  const label = `edits[${index}].oldText in ${path}`;
  const fileLines = content.split("\n");
  if (oldText.length > 0) {
    const first = content.indexOf(oldText);
    if (first !== -1) {
      if (content.indexOf(oldText, first + 1) === -1) return { edit, tolerant: false };
      const starts = trimmedWindows(
        fileLines,
        oldText.split("\n").map((l) => l.trim()),
      ).slice(0, 5);
      throw capped(
        `${label} matches more than one place; add surrounding lines so it is unique.\n${starts.map((s) => withContext(fileLines, s, 1)).join("\n--\n")}`,
      );
    }
  }
  const oldLines = oldText.split("\n");
  while (oldLines.length > 1 && oldLines[oldLines.length - 1]?.trim() === "") oldLines.pop();
  const keys = oldLines.map((line) => line.trim());
  const starts = keys.every((key) => key === "") ? [] : trimmedWindows(fileLines, keys);
  if (starts.length > 1) {
    throw capped(
      `${label} matches ${starts.length} places once whitespace is ignored; add surrounding lines so it is unique. Candidate lines:\n${starts
        .slice(0, 5)
        .map((s) => numbered(fileLines, s, oldLines.length))
        .join("\n--\n")}`,
    );
  }
  const start = starts[0];
  if (start === undefined) {
    throw capped(
      `No unique match for ${label}, even ignoring whitespace. ${closestCandidates(fileLines, oldLines)}\nRe-read the file (read shows line numbers) and copy the text exactly.`,
    );
  }
  const window = fileLines.slice(start, start + oldLines.length);
  const unsafe = unsafeIndentation(oldLines, window);
  if (unsafe) {
    throw capped(
      `No safe match for ${label}: ${unsafe}, so the replacement cannot be re-indented reliably. Copy the lines exactly, indentation included:\n${numbered(fileLines, start, oldLines.length)}`,
    );
  }
  const trailingNewline = oldText.endsWith("\n") && edit.newText.endsWith("\n");
  const newText = reindent(trailingNewline ? edit.newText.slice(0, -1) : edit.newText, oldLines, window);
  return { edit: { oldText: window.join("\n"), newText }, tolerant: true };
}

/** Pi's `edit`, retried with whitespace-normalised matching when an exact match misses. */
export function createTolerantEditTool(cwd: string): ToolDefinition {
  const base = createEditToolDefinition(cwd) as unknown as ToolDefinition;
  return {
    ...base,
    description: `${base.description} If oldText differs from the file only in whitespace (trailing spaces, indentation width, line endings) the edit is still applied; otherwise the error quotes the closest lines with their line numbers.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { path: string; edits: EditPair[] };
      let content: string;
      try {
        const raw = await readFile(resolve(ctx?.cwd || cwd, input.path), "utf-8");
        content = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
      } catch {
        // Missing or unreadable file: the built-in tool reports it.
        return base.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      const resolved = input.edits.map((edit, index) => resolveEdit(content, edit, index, input.path));
      const result = (await base.execute(
        toolCallId,
        { ...input, edits: resolved.map((r) => r.edit) },
        signal,
        onUpdate,
        ctx,
      )) as ToolResult;
      const adjusted = resolved.flatMap((r, i) => (r.tolerant ? [i] : []));
      if (adjusted.length === 0) return result;
      const note = ` Whitespace-normalised matching was applied to edit(s) ${adjusted.join(", ")}.`;
      return {
        ...result,
        content: result.content.map((block, i) =>
          i === 0 && block.type === "text" ? { ...block, text: (block.text ?? "") + note } : block,
        ),
      };
    },
  } as ToolDefinition;
}
