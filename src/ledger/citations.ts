/**
 * Citation resolution (issue #508).
 *
 * A review or a claim that says `roomClient.ts:184` is making a checkable
 * assertion: that file existed, that line existed, and at the commit under
 * review it said what the sentence says it said. None of that was ever checked,
 * which is how a review cited `roomClient.ts:183-186` for text that lives on
 * line 184 and asserted a delegation that existed only in a header comment.
 *
 * This module resolves citations against a fixed commit (or a work tree) and
 * reports the ones that do not resolve. It checks structure — file present,
 * line in range — and, when the citing sentence names identifiers in backticks,
 * that at least one of them actually appears in the cited range. A citation that
 * resolves structurally but contains none of the tokens the sentence attributes
 * to it is reported: that is the off-by-N / wrong-line class of error.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeGit } from "../git/safeGit.ts";

/** One `path/to/file.ts:12` or `path/to/file.ts:12-15` reference found in text. */
export interface Citation {
  /** The matched text, exactly as it appeared. */
  raw: string;
  /** Repository-relative path as written (never resolved through `..`). */
  file: string;
  line: number;
  /** Inclusive end of a range; equal to `line` for a single-line citation. */
  lineEnd: number;
}

/** A citation plus what resolving it against the tree established. */
export interface CitationCheck extends Citation {
  fileExists: boolean;
  lineInRange: boolean;
  /** The cited range's text (truncated), so a reviewer can see what was matched. */
  lineText?: string;
  /** Total lines in the file, for the out-of-range message. */
  fileLines?: number;
  /** A token the citing sentence attributed to this range was found inside it. */
  tokenMatched: boolean;
  /** Identifier tokens the sentence named (empty: nothing to match). */
  tokens: string[];
}

/** The outcome of resolving every citation in one body of text. */
export interface CitationReport {
  /** The commit (or `"worktree"`) the citations were resolved against. */
  atRef: string;
  checked: number;
  /** Citations that resolved completely. */
  resolved: number;
  /** Human-readable problems, one per failing citation. */
  unresolved: string[];
  checks: CitationCheck[];
}

/** Read a repository-relative file at the ref under review; null when absent. */
export type CitationReader = (file: string) => Promise<string | null>;

/** Path-like token followed by `:line` or `:line-line`. */
const CITATION_RE =
  /(?<![\w/.-])([A-Za-z0-9_.-][A-Za-z0-9_./-]*\.[A-Za-z][A-Za-z0-9]{0,7}):(\d{1,7})(?:-(\d{1,7}))?\b/g;

/** Machine URIs and URLs are references, not file:line citations. */
const NOT_A_FILE = /:\/|^[a-z][a-z0-9+.-]*:\/\//i;

/** Extract every `path:line[-line]` citation in `text`, deduplicated. */
export function extractCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const file = match[1]!;
    if (NOT_A_FILE.test(file) || file.includes("..")) continue;
    const line = Number(match[2]);
    const lineEnd = match[3] ? Number(match[3]) : line;
    if (!Number.isFinite(line) || line < 1) continue;
    const key = `${file}:${line}-${lineEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: match[0], file, line, lineEnd: Math.max(line, lineEnd) });
  }
  return out;
}

/** Identifier-like tokens in backticks inside the sentence that carries `raw`. */
function sentenceTokens(text: string, citation: Citation): string[] {
  const at = text.indexOf(citation.raw);
  if (at < 0) return [];
  const start = Math.max(
    0,
    ...[text.lastIndexOf(".", at), text.lastIndexOf("!", at), text.lastIndexOf("\n", at), text.lastIndexOf("|", at)],
  );
  const endRel = text.slice(at).search(/[.!?]\s|\n|$/);
  const sentence = text.slice(start, at + (endRel < 0 ? 0 : endRel + 1));
  const tokens: string[] = [];
  for (const quoted of sentence.matchAll(/`([^`\n]{3,60})`/g)) {
    const inner = quoted[1]!.trim();
    // `foo.bar()` and `foo()` are cited as the symbol; match on its last segment.
    const symbol =
      inner
        .replace(/\(.*\)$/, "")
        .split(".")
        .pop() ?? inner;
    if (/^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(symbol) && !tokens.includes(symbol)) tokens.push(symbol);
  }
  return tokens;
}

const RANGE_PREVIEW_CHARS = 320;

/** Resolve every citation in `text` against `read`. */
export async function resolveCitations(
  text: string,
  read: CitationReader,
  opts?: { atRef?: string },
): Promise<CitationReport> {
  const atRef = opts?.atRef ?? "worktree";
  const citations = extractCitations(text);
  const checks: CitationCheck[] = [];
  const unresolved: string[] = [];
  const fileCache = new Map<string, Promise<string | null>>();
  for (const citation of citations) {
    let loaded = fileCache.get(citation.file);
    if (!loaded) {
      loaded = read(citation.file).catch(() => null);
      fileCache.set(citation.file, loaded);
    }
    const content = await loaded;
    const tokens = sentenceTokens(text, citation);
    const check: CitationCheck = {
      ...citation,
      fileExists: content !== null,
      lineInRange: false,
      tokenMatched: tokens.length === 0,
      tokens,
    };
    if (content !== null) {
      const lines = content.split("\n");
      // A trailing newline is a line terminator, not an extra empty line: a
      // 4-line file must not be reported as having 5.
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      check.fileLines = lines.length;
      check.lineInRange = citation.line <= lines.length;
      const from = Math.max(1, citation.line);
      const to = Math.min(lines.length, citation.lineEnd);
      if (check.lineInRange) {
        const range = lines.slice(from - 1, to).join("\n");
        check.lineText = range.length > RANGE_PREVIEW_CHARS ? `${range.slice(0, RANGE_PREVIEW_CHARS)}…` : range;
        check.tokenMatched = tokens.length === 0 || tokens.some((t) => range.includes(t));
      }
    }
    checks.push(check);
    if (!check.fileExists) unresolved.push(`${citation.raw}: no such file at ${atRef}`);
    else if (!check.lineInRange)
      unresolved.push(
        `${citation.raw}: line ${citation.line} is past the file end (${check.fileLines} lines) at ${atRef}`,
      );
    else if (!check.tokenMatched)
      unresolved.push(
        `${citation.raw}: the sentence attributes ${tokens.map((t) => `\`${t}\``).join(", ")} to this range and none of them appears in it`,
      );
  }
  return {
    atRef,
    checked: checks.length,
    resolved: checks.length - unresolved.length,
    unresolved,
    checks: checks.map((c) => ({ ...c, lineText: undefined })),
  };
}

/** Compact summary for a log line or a review record. */
export function citationSummary(report: CitationReport): string {
  if (report.checked === 0) return `no citations to resolve (at ${report.atRef})`;
  if (report.unresolved.length === 0) return `all ${report.checked} citation(s) resolve at ${report.atRef}`;
  return `${report.unresolved.length} of ${report.checked} citation(s) do not resolve at ${report.atRef}: ${report.unresolved.slice(0, 3).join("; ")}${report.unresolved.length > 3 ? `; +${report.unresolved.length - 3} more` : ""}`;
}

/** Read repository-relative paths from a working tree. */
export function fileSystemReader(root: string): CitationReader {
  return async (file) => {
    try {
      return await readFile(join(root, file), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * Read repository-relative paths out of a commit, the way `git show <ref>:<path>`
 * does. Reading through the work tree instead would check the wrong bytes
 * whenever the review runs while the checkout is dirty or on another branch.
 *
 * The call goes through `safeGit` with `cwd: root` (issue #512): starting git in
 * a foreign working directory — or pointing `--git-dir` at a repository from one
 * — makes it read that other work tree, and a citation check run that way
 * resolves against the wrong content. `safeGit` also neutralises repository-local
 * git drivers, hooks and helpers a worker could plant in the tree under review.
 */
export function gitObjectReader(root: string, ref: string): CitationReader {
  return async (file) => {
    const result = await safeGit(["show", `${ref}:${file}`], {
      cwd: root,
      timeoutMs: 10_000,
      maxBuffer: 8 << 20,
    });
    return result.code === 0 ? result.stdout : null;
  };
}
