/**
 * Line numbers and change signs for content shown in the panel.
 *
 * A diff without numbers tells you what changed but not where, which is most of
 * the value when the next thing you do is open the file. The layout mirrors what
 * the operator already reads elsewhere: number, sign, then content.
 *
 * ── Which number ────────────────────────────────────────────────────────────
 *
 * A unified diff has two line sequences, and showing the wrong one is worse
 * than showing none. Added and context lines carry the NEW file's number,
 * because that is the file that now exists and the one you will open. Removed
 * lines carry the OLD number, since they have no position in the new file. Both
 * sequences advance independently, which is why the counters are tracked
 * separately rather than derived from the row index.
 *
 * Pure: takes lines, returns rows. No terminal, no colour.
 */

export type GutterKind = "added" | "removed" | "context" | "meta";

export interface GutterRow {
  /** Line number to display, or undefined for hunk headers and file headers. */
  lineNo?: number;
  /** "+", "-" or " ". Empty for meta rows, which are not content. */
  sign: string;
  /** The content, with the diff's leading marker removed. */
  text: string;
  kind: GutterKind;
}

/** `@@ -12,6 +40,9 @@` → the starting line of each side. */
export function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number.parseInt(m[1] as string, 10), newStart: Number.parseInt(m[2] as string, 10) };
}

/**
 * Number the lines of a unified diff.
 *
 * Lines before the first hunk header (`diff --git`, `---`, `+++`) are meta and
 * get no number: they describe the file rather than sit in it.
 */
export function numberDiffLines(lines: readonly string[]): GutterRow[] {
  const rows: GutterRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      inHunk = true;
      rows.push({ sign: "", text: line, kind: "meta" });
      continue;
    }
    if (!inHunk || line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---")) {
      rows.push({ sign: "", text: line, kind: "meta" });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ lineNo: newNo++, sign: "+", text: line.slice(1), kind: "added" });
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ lineNo: oldNo++, sign: "-", text: line.slice(1), kind: "removed" });
      continue;
    }
    // Context advances BOTH sides; showing the new number keeps the column
    // consistent with the added lines around it.
    rows.push({ lineNo: newNo, sign: " ", text: line.startsWith(" ") ? line.slice(1) : line, kind: "context" });
    oldNo++;
    newNo++;
  }
  return rows;
}

/** Number the lines of a plain file, starting at 1. */
export function numberFileLines(lines: readonly string[]): GutterRow[] {
  return lines.map((text, index) => ({ lineNo: index + 1, sign: " ", text, kind: "context" as const }));
}

/** Columns needed for the number column, given the largest number present. */
export function gutterWidth(rows: readonly GutterRow[]): number {
  let widest = 0;
  for (const row of rows) {
    if (row.lineNo !== undefined) widest = Math.max(widest, String(row.lineNo).length);
  }
  // number + space + sign + space. A diff with no numbered rows needs none.
  return widest === 0 ? 0 : widest + 3;
}

/** The gutter text for one row, padded to `width`. */
export function formatGutter(row: GutterRow, width: number): string {
  if (width === 0) return "";
  const numberWidth = width - 3;
  const number = row.lineNo === undefined ? "" : String(row.lineNo);
  return `${number.padStart(numberWidth)} ${row.sign || " "} `;
}
