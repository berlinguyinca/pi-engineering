/**
 * A decision to drop an identifier must be backed by a reference sweep, and the
 * sweep must be clean where users read or type (issue #510).
 *
 * `ledger claim add --kind decision --claim "drop \`room join\`, it duplicates
 * \`herdr join\`"` was accepted with no `references` evidence attached, and the
 * completion gate never asked for one, so a mission could "complete" while
 * `docs/cli.md` and a CLI label still told users to run the command being
 * removed. This module decides, from the recorded `references` evidence and the
 * sweep artifact it points at, whether such a decision may complete: no sweep
 * blocks, and a sweep whose hits land in user-facing text blocks.
 *
 * A hit is user-facing when it is inside a string literal in a code file, or
 * anywhere in a document, config or template. A hit in a comment or in plain
 * code is not user-facing and does not block. One readable sweep with no
 * user-facing hit satisfies the decision; the gate is conservative and blocks on
 * an unreadable artifact.
 *
 * Known limit, stated rather than hidden: a hit on a line that only continues a
 * multi-line template literal (no quote on that line) reads as plain code. A
 * sweep of a repo with such literals should be re-recorded with `grep -Fn`
 * against the whole file, or the artifact widened to carry context.
 */
import type { Evidence } from "../core/types.ts";

/** A decision that removes something the user types or reads. */
const DROP_VERB =
  /\b(drop|drops|dropped|dropping|remove|removes|removed|removing|delete|deletes|deleted|deleting|retire|retires|retired|retiring|rename|renames|renamed|renaming|alias(?:es)?\s+away)\b/i;

/** Backticked or quoted spans — the way a decision names the thing it drops. */
const QUOTED_SPAN = /`([^`\n]{2,60})`|"([^"\n]{2,60})"|'([^'\n]{2,60})'/g;

/** A bare token that only ever names code: a path, a dotted name, camelCase, SCREAMING_CASE, snake_case. */
const BARE_CODE =
  /\b(?:[\w][\w.@/\-]*[.\/@][\w][\w.@/\-]*|[a-z][\w]*_[\w]*|[a-z][a-z0-9]*[A-Z][\w]*|[A-Z][A-Z0-9_]{1,})\b/g;

/** Files whose text is what a user reads or configures. */
const USER_FACING_FILE =
  /\.(md|mdx|markdown|rst|adoc|asciidoc|txt|text|html?|xml|po|pot|json|jsonc|ya?ml|toml|ini|cfg|conf|properties|tpl|tmpl|hbs|ejs|vue|svelte)$/i;

/** Files where only the quoted text reaches a user. */
const CODE_FILE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|cxx|cs|swift|scala|pl|pm|lua|ex|exs|erl|dart|sh|bash|zsh|fish|ps1|sql|r|jl|zig|nim|v|dart)$/i;

/** An identifier-shaped span: characters an identifier is made of, at most three words. */
const IDENTIFIER_CHARS = /^[\w][\w.@/\-]*(?:[ \t]+[\w][\w.@/\-]*){0,2}$/;

function codeShaped(span: string): boolean {
  const trimmed = span.trim();
  if (!IDENTIFIER_CHARS.test(trimmed)) return false;
  // Punctuation that only appears in a name, or a short all-lowercase pair that
  // reads as a subcommand (`room join`). Longer prose stays prose.
  if (/[.@/_\-]|::/.test(trimmed)) return true;
  if (/[a-z][a-z0-9]*[A-Z]/.test(trimmed)) return true;
  const words = trimmed.split(/[ \t]+/);
  return words.length <= 2 && words.every((word) => /^[a-z][a-z0-9]*$/.test(word));
}

/**
 * The identifier a decision drops: the first name it speaks after the verb. In
 * `drop \`room join\`, it duplicates \`herdr join\`` that is `room join` — the
 * thing being removed, not the thing that survives.
 */
export function droppedIdentifier(text: string): string | null {
  const verb = DROP_VERB.exec(text);
  if (!verb) return null;
  const named: Array<{ at: number; name: string }> = [];
  for (const match of text.matchAll(QUOTED_SPAN)) {
    const span = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (codeShaped(span)) named.push({ at: match.index, name: span.replace(/\s+/g, " ") });
  }
  for (const match of text.matchAll(BARE_CODE)) {
    const span = match[0].trim();
    if (codeShaped(span)) named.push({ at: match.index, name: span });
  }
  if (named.length === 0) return null;
  named.sort((a, b) => a.at - b.at);
  const after = named.find((entry) => entry.at >= (verb.index ?? 0) + verb[0].length);
  return (after ?? named[0])!.name;
}

export type SweepHitKind = "string literal" | "document" | "comment" | "code";
export interface SweepHit {
  path: string;
  line: number;
  kind: SweepHitKind;
}

/** Parse one sweep-artifact line: `path:lineno:text`, `path:lineno`, or bare text. */
export function parseSweepLine(line: string): { path: string; lineNo: number; text: string | null } | null {
  const withText = /^(.+?):(\d+):(.*)$/.exec(line);
  if (withText) return { path: withText[1]!, lineNo: Number(withText[2]), text: withText[3]! };
  const bare = /^(.+?):(\d+):?$/.exec(line);
  if (bare) return { path: bare[1]!, lineNo: Number(bare[2]), text: null };
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** The quote (or comment) a code line is inside of at `index`, scanning from the line start. */
function stateAt(text: string, index: number): "'" | '"' | "`" | "//" | "/*" | null {
  let open: "'" | '"' | "`" | null = null;
  for (let i = 0; i < index && i < text.length; i++) {
    const char = text[i]!;
    if (open) {
      if (char === "\\") i++;
      else if (char === open) open = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") open = char;
    else if (char === "/" && text[i + 1] === "/") return "//";
    else if (char === "/" && text[i + 1] === "*") return "/*";
  }
  return open;
}

/** How a hit reads to whoever sees the file: quoted text and prose reach users. */
function hitKind(path: string, text: string | null, identifier: string): SweepHitKind {
  if (USER_FACING_FILE.test(path)) return "document";
  if (text === null) return "document"; // a file-name-only sweep line cannot prove otherwise
  if (!CODE_FILE.test(path)) return "document"; // unknown file type: assume it is read
  const at = text.indexOf(identifier);
  const state = at === -1 ? null : stateAt(text, at);
  if (state === "//" || state === "/*") return "comment";
  if (state) return "string literal";
  return "code";
}

/** Every hit in a sweep artifact that a user would read or type. */
export function userFacingHits(artifactLines: ReadonlyArray<string>, identifier: string): SweepHit[] {
  const hits: SweepHit[] = [];
  for (const line of artifactLines) {
    const parsed = parseSweepLine(line);
    if (!parsed) continue;
    const occurrences = parsed.text === null ? 1 : countOccurrences(parsed.text, identifier);
    if (occurrences === 0) continue;
    const kind = hitKind(parsed.path, parsed.text, identifier);
    if (kind === "comment" || kind === "code") continue;
    hits.push({ path: parsed.path, line: parsed.lineNo, kind });
  }
  return hits;
}

/** Total hits in the artifact, so a record's own claimed count can be checked. */
export function sweepHitCount(artifactLines: ReadonlyArray<string>, identifier: string): number {
  let count = 0;
  for (const line of artifactLines) {
    const parsed = parseSweepLine(line);
    if (!parsed) continue;
    count += parsed.text === null ? 1 : countOccurrences(parsed.text, identifier);
  }
  return count;
}

/** A decision under test, the evidence attached to it, and how to read what it points at. */
export interface SweepRecord {
  /** The decision text (a ledger `decision` claim, or a candidate reason). */
  statement: string;
  /** Evidence attached to that decision. */
  evidence: ReadonlyArray<Evidence>;
  /** Read a recorded sweep artifact, or null when it cannot be read. */
  readArtifact: (artifact: string) => string[] | null;
}

/**
 * Why a drop decision may not complete yet: no sweep was recorded, the sweep
 * cannot be read, its own hit count disagrees with its artifact, or its hits
 * still sit in text a user reads or types.
 */
export function referenceSweepBlockers(record: SweepRecord): string[] {
  const identifier = droppedIdentifier(record.statement);
  if (!identifier) return [];
  const sweeps = record.evidence.filter((entry) => entry.type === "references");
  if (sweeps.length === 0) {
    return [
      `decision drops "${identifier}" with no reference sweep: attach one (type=references, a grep artifact over the repo and its hit count) before completing`,
    ];
  }
  const blockers: string[] = [];
  for (const sweep of sweeps) {
    if (sweep.artifacts.length === 0) {
      blockers.push(`reference sweep for "${identifier}" names no artifact to read`);
      continue;
    }
    let satisfied = false;
    for (const artifact of sweep.artifacts) {
      const lines = record.readArtifact(artifact);
      if (lines === null) {
        blockers.push(`reference sweep artifact ${artifact} for "${identifier}" cannot be read`);
        continue;
      }
      const counted = sweepHitCount(lines, identifier);
      const claimed = sweep.summary.hits;
      if (typeof claimed === "number" && claimed !== counted) {
        blockers.push(
          `reference sweep artifact ${artifact} lists ${counted} hit(s) for "${identifier}", the record claims ${claimed}`,
        );
      }
      const hits = userFacingHits(lines, identifier);
      if (hits.length > 0) {
        const where = hits
          .slice(0, 5)
          .map((hit) => `${hit.path}:${hit.line} (${hit.kind})`)
          .join(", ");
        blockers.push(
          `decision drops "${identifier}" but user-facing text still names it — ${where}${
            hits.length > 5 ? ` (+${hits.length - 5} more)` : ""
          }`,
        );
      } else {
        satisfied = true;
      }
    }
    if (satisfied) return [];
  }
  return blockers;
}
