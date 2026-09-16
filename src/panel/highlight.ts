/**
 * Colouring file and diff content in the panel.
 *
 * Pi's `Theme` already carries every colour this needs — `toolDiffAdded`,
 * `toolDiffRemoved`, `toolDiffContext` and a `syntax*` family — so the panel
 * inherits whatever theme the operator chose instead of inventing a palette
 * that clashes with the rest of the session. No highlighting dependency is
 * added; the repository is meant to stay usable on its own.
 *
 * ── On the accuracy of the syntax pass ──────────────────────────────────────
 *
 * This is a line-oriented approximation, not a parser. It recognises comments,
 * strings, numbers and a keyword set, and it will be wrong about things a real
 * grammar would get right — a keyword inside an identifier-like context, a
 * string spanning lines. That trade is deliberate: a parser per language is a
 * dependency and a maintenance surface, and the value here is scanability, not
 * correctness. What it must never do is change the TEXT, only its colour, so a
 * wrong guess costs a wrong shade and nothing else.
 */

/** The slice of pi's Theme this module uses. */
export interface HighlightTheme {
  fg(color: string, text: string): string;
}

/** Applied per line; the caller supplies pi's Theme. */
export interface HighlightOptions {
  theme: HighlightTheme;
  /** File name, used to pick a keyword set. */
  filename?: string;
}

const KEYWORDS_COMMON = [
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "new",
  "await",
  "async",
  "import",
  "export",
  "from",
  "try",
  "catch",
  "finally",
  "throw",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "super",
  "def",
  "elif",
  "lambda",
  "pass",
  "raise",
  "with",
  "yield",
  "struct",
  "impl",
  "fn",
  "match",
  "use",
  "pub",
  "mut",
  "package",
  "func",
  "go",
  "defer",
  "select",
  "map",
  "range",
  "nil",
];

const KEYWORD_PATTERN = new RegExp(`\\b(${KEYWORDS_COMMON.join("|")})\\b`, "g");

/** Line comment markers by extension. `#` covers shell, python, yaml, toml. */
function commentMarker(filename: string | undefined): string {
  const ext = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (["py", "sh", "bash", "yml", "yaml", "toml", "rb", "pl", "r"].includes(ext)) return "#";
  if (["sql", "lua", "hs"].includes(ext)) return "--";
  return "//";
}

/**
 * Colour one line of source.
 *
 * Order matters: a whole-line comment wins outright, because a `//` line
 * containing the word `return` is a comment, not a keyword.
 */
export function highlightLine(line: string, opts: HighlightOptions): string {
  const { theme } = opts;
  const marker = commentMarker(opts.filename);
  const trimmed = line.trimStart();

  if (trimmed.startsWith(marker) || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return theme.fg("syntaxComment", line);
  }

  // Strings first, and their spans are then left alone: a keyword inside a
  // string literal is text, not a keyword.
  const spans: Array<{ start: number; end: number; colour: string }> = [];
  const stringPattern = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
  let match = stringPattern.exec(line);
  while (match) {
    spans.push({ start: match.index, end: match.index + match[0].length, colour: "syntaxString" });
    match = stringPattern.exec(line);
  }

  const inSpan = (index: number) => spans.some((s) => index >= s.start && index < s.end);

  const numberPattern = /\b\d+(?:\.\d+)?\b/g;
  match = numberPattern.exec(line);
  while (match) {
    if (!inSpan(match.index)) {
      spans.push({ start: match.index, end: match.index + match[0].length, colour: "syntaxNumber" });
    }
    match = numberPattern.exec(line);
  }

  KEYWORD_PATTERN.lastIndex = 0;
  match = KEYWORD_PATTERN.exec(line);
  while (match) {
    if (!inSpan(match.index)) {
      spans.push({ start: match.index, end: match.index + match[0].length, colour: "syntaxKeyword" });
    }
    match = KEYWORD_PATTERN.exec(line);
  }

  if (spans.length === 0) return line;

  // Rebuild left to right. Overlaps are resolved by taking the first span that
  // starts at a position, so the text is never duplicated or dropped.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += line.slice(cursor, span.start);
    out += theme.fg(span.colour, line.slice(span.start, span.end));
    cursor = span.end;
  }
  return out + line.slice(cursor);
}

/** What a diff line is, from its first character. */
export type DiffLineKind = "added" | "removed" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) {
    return "meta";
  }
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/**
 * Colour one diff line.
 *
 * Added and removed lines take the diff colour for the WHOLE line rather than
 * being syntax-highlighted: the question a diff answers is "what changed", and
 * a green line that is also half-green from a string literal answers it less
 * clearly. Context lines get the syntax pass, since that is where reading
 * happens.
 */
export function highlightDiffLine(line: string, opts: HighlightOptions): string {
  const { theme } = opts;
  switch (diffLineKind(line)) {
    case "added":
      return theme.fg("toolDiffAdded", line);
    case "removed":
      return theme.fg("toolDiffRemoved", line);
    case "meta":
      return theme.fg("muted", line);
    default:
      return highlightLine(line, opts);
  }
}

/** Does this look like unified diff output? */
export function looksLikeDiff(lines: readonly string[]): boolean {
  return lines.some((l) => l.startsWith("@@") || l.startsWith("diff --git"));
}
