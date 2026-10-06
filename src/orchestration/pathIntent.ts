/**
 * What a request allows for each filesystem path it names (PR #106 final
 * review C). Structurally fail-safe; it does not try to understand English.
 *
 *  1. Explicit directives win. Lines such as `writable: /a, /b`,
 *     `target: /a`, `read-only: /c`, `readonly:`, `reference:`,
 *     `do not modify:` (also as list items, inside fenced blocks, or as a
 *     header followed by a list) state scope unambiguously. When the request
 *     has a writable directive, nothing else is writable.
 *  2. Otherwise a path is writable only if a mutation verb is directed at it
 *     AND its whole sentence (plus the list intro / markdown header it sits
 *     under) contains no restriction word at all. Any restriction word
 *     (not, never, avoid, skip, keep, leave, read-only, reference, analyze,
 *     copy, from <path>, ...) makes every path in that sentence read-only.
 *     Narrow exception: the verb-directed path's own clause (split on , ; but
 *     and except ( - ) is clean and every restriction word sits in a clause
 *     that names its own path and no pronoun ("Fix /T, but don't touch /R").
 *  3. A path read-only anywhere is read-only everywhere.
 *
 * Anything that is not clearly a grant is read-only; the resolver refuses
 * rather than guessing, and its message points at the directive syntax.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PathMention {
  /** Absolute, lexically normalized path; null when the token cannot be resolved. */
  path: string | null;
  raw: string;
  /** Path-like token that cannot be resolved (`$HOME/x`, `C:\x`, `~user/x`, `../x` outside the launch dir). */
  unresolved: boolean;
  /** Reads like an HTTP route ("/api/v1/users", "the /health endpoint") rather than a filesystem path. */
  routeLike: boolean;
}

export interface RequestAnalysis {
  mentions: PathMention[];
  /** Mention named with a restriction anywhere (directive or inference). */
  tainted: boolean[];
  /** Mention granted write by a directive or by a directed, unrestricted sentence. */
  granted: boolean[];
  /** Mention sits in a sentence with a mutation verb (for refusing unresolvable targets). */
  mutationAimed: boolean[];
  /** The request states scope with explicit directives. */
  hasDirectives: boolean;
  /** Path that both a writable and a read-only directive name. */
  directiveConflict: string | null;
  /** A restriction word refers to the launch directory ("do not modify anything here"). */
  launchRestricted: boolean;
  /** Any restriction word anywhere in the request. */
  anyRestriction: boolean;
  /** Whether mention `index` may become writable (granted, never tainted under any lexical alias). */
  writeEligible(index: number): boolean;
}

const OPEN = "\uE000";
const CLOSE = "\uE001";
const PLACEHOLDER = /\uE000(\d+)\uE001/g;

/** Restriction lexicon: any hit makes the sentence's paths read-only. */
const RESTRICTION =
  /\b(?:not|no|never|nothing|none|nor|neither|dont|cannot|without|avoid\w*|skip\w*|ignor\w*|exclud\w*|except\w*|leav(?:e|es|ing)|left|alone|untouched|unchanged|unmodified|remain\w*|stay\w*|keep\w*|kept|refrain\w*|forbid\w*|prohibit\w*|disallow\w*|reference\w*|inspect\w*|analy[sz]\w*|audit\w*|review\w*|compar\w*|cop(?:y|ies|ied|ying)|mirror\w*|follow\w*|preserve\w*|intact|frozen|protect\w*|restrict\w*)\b|n't\b|\bas[- ]is\b|\bhands[- ]off\b|\boff[- ]limits\b|\bread[- ]?only\b|\bfor context\b|\bas (?:an? |the )?(?:guide|example|template|model|baseline|inspiration)\b|\blook(?:s|ing)? at\b|\bbased on\b|\bfrom\s+["'`]?\uE000/i;
const ONLY = /\bonly\b/i;
/** Broad mutation vocabulary (stems). */
const MUTATION =
  /\b(?:add|creat|install|implement|fix|patch|build|appl|updat|chang|edit|modif|writ|wrote|refactor|renam|delet|remov|migrat|port|upgrad|bump|mov|merg|commit|push|configur|wir|clean|improv|extend|replac|convert|restructur|repair|debug|resolv|harden|set ?up|work|coordinat|integrat|rewrit|optimi[sz]|generat|scaffold|initiali[sz]|bootstrap|introduc|insert|append|tweak|adjust|correct|rework|make|implement|ship|develop|code)\w*\b/i;
const REMOVAL = /\b(?:remov|delet|strip|drop|purg|eras|clean)\w*\b/i;
/** Words that make a restriction clause refer back to another path. */
const PRONOUN =
  /\b(?:it|its|itself|them|they|this|that|these|those|there|here|either|both|all|any|former|latter|first|second|same|above|below|previous|rest|everything|anything|others?)\b/i;
/** Restriction aimed at the launch directory when no path is named. */
const LAUNCH_LOCATION =
  /\b(?:here|this (?:repo|repository|directory|dir|folder|project|workspace|codebase|checkout)|the (?:repo|repository|codebase|workspace|directory|folder|project|code)|anything|everything|any files?|files)\b/i;
const ROUTE_WORD =
  /\b(?:endpoints?|routes?|apis?|urls?|uris?|handlers?|pages?|requests?|get|post|put|patch|delete|head|options|path|webhooks?)\b/i;

const DIRECTIVE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(writable|write|targets?|read[- ]?only|references?|do not modify|don't modify|do-not-modify)(?:\*\*|__)?\s*:\s*(.*)$/i;

function normalizeProse(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

interface Span {
  start: number;
  end: number;
  mention: PathMention;
}

const TRAILING_PROSE = /[,:;!?)]+$/;

function stripTrailing(candidate: string): string {
  // "/repo.Do not …": a sentence glued to the path without a space.
  let stripped = candidate.replace(/\.[A-Z][A-Za-z]*$/, "").replace(TRAILING_PROSE, "");
  while (stripped.endsWith(".") && !stripped.endsWith("/.") && !/(?:^|\/)\.\.$/.test(stripped)) {
    stripped = stripped.slice(0, -1).replace(TRAILING_PROSE, "");
  }
  return stripped;
}

function routeLikeAt(line: string, start: number, end: number, raw: string): boolean {
  if (/^\/(?:api|v\d+)(?:\/|$)|\/v\d+(?:\/|$)|\/:[A-Za-z]|\{[A-Za-z]/.test(raw)) return true;
  const before = line
    .slice(Math.max(0, start - 40), start)
    .split(/\s+/)
    .slice(-3)
    .join(" ");
  const after = line
    .slice(end, end + 40)
    .split(/\s+/)
    .slice(0, 4)
    .join(" ");
  return ROUTE_WORD.test(before) || ROUTE_WORD.test(after);
}

function toMention(raw: string, launchCwd: string, line: string, start: number, end: number): PathMention | null {
  const routeLike = routeLikeAt(line, start, end, raw);
  if (
    /^(?:\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%)[\\/]/.test(raw) ||
    /^[A-Za-z]:\\/.test(raw) ||
    /^~[A-Za-z_]/.test(raw)
  ) {
    return { path: null, raw, unresolved: true, routeLike: false };
  }
  if (raw === "~" || raw.startsWith("~/")) {
    return { path: resolve(join(homedir(), raw.slice(2))), raw, unresolved: false, routeLike: false };
  }
  if (raw.startsWith("./") || raw.startsWith("../") || raw === "." || raw === "..") {
    const path = resolve(launchCwd, raw);
    const inside = !relative(launchCwd, path).startsWith("..") && !isAbsolute(relative(launchCwd, path));
    return inside
      ? { path, raw, unresolved: false, routeLike: false }
      : { path: null, raw, unresolved: true, routeLike: false };
  }
  if (!isAbsolute(raw)) return null;
  // A bare "/" is the filesystem root as a target ('Modify files in "/"'),
  // otherwise prose ('mount the app at "/"').
  if (raw === "/") return { path: "/", raw, unresolved: false, routeLike: true };
  return { path: resolve(raw), raw, unresolved: false, routeLike };
}

/** Path-like tokens of one line, in order. */
function lineMentions(line: string, launchCwd: string): Span[] {
  const spans: Span[] = [];
  const taken: Array<{ start: number; end: number }> = [];
  for (const match of line.matchAll(/(["'`])((?:\/|~\/?|\.\.?\/|\$\{?\w+\}?\/|[A-Za-z]:\\).*?)\1/g)) {
    const end = match.index + match[0].length;
    taken.push({ start: match.index, end });
    const mention = toMention(match[2] ?? "", launchCwd, line, match.index, end);
    if (mention) spans.push({ start: match.index, end, mention });
  }
  const bare =
    /(?<![\w/:.~$\\-])(?:\/[A-Za-z0-9._~]|~(?:[A-Za-z_][\w-]*)?(?=\/|[\s,.;:!?)]|$)|\.\.?\/|\$\{?[A-Za-z_]\w*\}?\/|%[A-Za-z_]\w*%\\|[A-Za-z]:\\)[^\s"'`<>()[\]{}]*/g;
  for (const match of line.matchAll(bare)) {
    if (taken.some((range) => match.index >= range.start && match.index < range.end)) continue;
    const raw = stripTrailing(match[0]);
    if (!raw) continue;
    const mention = toMention(raw, launchCwd, line, match.index, match.index + raw.length);
    if (mention) spans.push({ start: match.index, end: match.index + raw.length, mention });
  }
  return spans.sort((left, right) => left.start - right.start);
}

interface Unit {
  /** Masked, normalized text. */
  text: string;
}

const SENTENCE_SPLIT = /(?<=[.!?;])\s+|(?<=[.!?;])(?=[A-Z])/;
const CLAUSE_SPLIT =
  /\s*[,;()]\s*|\s+(?=(?:but|and|except|excepting|excluding|however|then|while|whereas)\s)|\s+(?=[-\u2013\u2014]{1,2}\s)/i;
const LIST_ITEM = /^(?:[-*+\u2022]|\d+[.)])\s+/;
const PURE_NEGATION = /^(?:\w+[,\s]+)?(?:no|nope|never|don'?t|do not|not)\W*$/i;

function placeholders(text: string): number[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => Number(match[1]));
}

function prose(text: string): string {
  return text.replace(PLACEHOLDER, " ");
}

/** Analyze `request` against the launch directory. Pure: no filesystem access. */
export function analyzeRequest(request: string, launchCwd: string): RequestAnalysis {
  const mentions: PathMention[] = [];
  const directiveWrite = new Set<number>();
  const directiveRead = new Set<number>();
  const maskedLines: Array<{ text: string; directive: boolean }> = [];

  // Pass 1: mask every line; collect directives (a directive with an empty
  // value applies to the list items that follow it).
  let pendingDirective: "write" | "read" | null = null;
  for (const rawLine of request.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      maskedLines.push({ text: "", directive: true });
      continue;
    }
    const spans = lineMentions(rawLine, launchCwd);
    let masked = "";
    let cursor = 0;
    const indices: number[] = [];
    for (const span of spans) {
      masked += normalizeProse(rawLine.slice(cursor, span.start));
      masked += `${OPEN}${mentions.length}${CLOSE}`;
      indices.push(mentions.length);
      mentions.push(span.mention);
      cursor = span.end;
    }
    masked += normalizeProse(rawLine.slice(cursor));
    const directive = DIRECTIVE.exec(rawLine);
    if (directive) {
      const kind = /^(?:writable|write|targets?)$/i.test(directive[1] ?? "") ? "write" : "read";
      for (const index of indices) (kind === "write" ? directiveWrite : directiveRead).add(index);
      pendingDirective = indices.length === 0 ? kind : null;
      maskedLines.push({ text: "", directive: true });
      continue;
    }
    if (pendingDirective && LIST_ITEM.test(masked.trim())) {
      for (const index of indices) (pendingDirective === "write" ? directiveWrite : directiveRead).add(index);
      maskedLines.push({ text: "", directive: true });
      continue;
    }
    if (masked.trim()) pendingDirective = null;
    maskedLines.push({ text: masked, directive: false });
  }

  // Pass 2: units = sentences, each carrying the header and list intro it sits under.
  const units: Unit[] = [];
  let header = "";
  let intro = "";
  for (const { text } of maskedLines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      header = trimmed.replace(/^#{1,6}\s+/, "");
      intro = "";
      units.push({ text: header });
      continue;
    }
    const isItem = LIST_ITEM.test(trimmed);
    const body = trimmed.replace(LIST_ITEM, "");
    const context = [header, isItem ? intro : ""].filter(Boolean).join(": ");
    for (const sentence of body.split(SENTENCE_SPLIT)) {
      if (sentence.trim()) units.push({ text: context ? `${context}: ${sentence}` : sentence });
    }
    if (!isItem) intro = body.replace(/[:.]\s*$/, "");
  }

  const tainted = mentions.map(() => false);
  const granted = mentions.map(() => false);
  const mutationAimed = mentions.map(() => false);
  let launchRestricted = false;
  let anyRestriction = false;
  const onlyTargets: number[] = [];
  let previousPaths: number[] = [];

  for (const unit of units) {
    const text = unit.text;
    const paths = placeholders(text);
    const words = prose(text);
    const restricted = RESTRICTION.test(text);
    const hasOnly = ONLY.test(words) && !/\b(?:not|n't)\s+only\b/i.test(words);
    const mutation = MUTATION.test(words);
    if (restricted || (hasOnly && paths.length === 0)) anyRestriction = true;
    for (const index of paths) if (mutation) mutationAimed[index] = true;

    if (paths.length === 0) {
      if ((restricted || hasOnly) && LAUNCH_LOCATION.test(words)) launchRestricted = true;
      // "Modify /R? No." — a bare negation retracts the previous sentence.
      if (PURE_NEGATION.test(words.trim())) for (const index of previousPaths) tainted[index] = true;
      continue;
    }
    previousPaths = paths;

    if (hasOnly && mutation && !restricted) onlyTargets.push(...paths);

    if (!restricted) {
      if (mutation) for (const index of paths) granted[index] = true;
      continue;
    }

    // Narrow exceptions for a sentence with a restriction word.
    const removalFrom =
      paths.length === 1 && REMOVAL.test(words) && !RESTRICTION.test(text.replace(/\bfrom\s+["'`]?\uE000/gi, " "));
    if (removalFrom) {
      granted[paths[0]!] = true;
      continue;
    }
    const clauses = text.split(CLAUSE_SPLIT).filter((clause) => clause.trim());
    // A clause holding only paths ("…, /b", "and /c") continues the previous
    // clause's list: it inherits its verb and, fail-safe, its restriction.
    let previous = { mutation: false, restricted: false };
    const clauseInfo = clauses.map((clause) => {
      const clauseWords = prose(clause);
      const clausePaths = placeholders(clause);
      const pathOnly = /^[\s,&]*(?:(?:and|or|nor|plus|&)\s*)?[\s,]*$/i.test(clauseWords);
      const clauseRestricted = RESTRICTION.test(clause) || (pathOnly && previous.restricted);
      const clauseMutation = MUTATION.test(clauseWords) || (pathOnly && previous.mutation);
      previous = { mutation: clauseMutation, restricted: clauseRestricted };
      return { clausePaths, restricted: clauseRestricted, clauseMutation, clauseWords };
    });
    const restrictionsAttached = clauseInfo
      .filter((info) => info.restricted)
      .every((info) => info.clausePaths.length > 0 && !PRONOUN.test(info.clauseWords));
    for (const info of clauseInfo) {
      for (const index of info.clausePaths) {
        if (restrictionsAttached && !info.restricted && info.clauseMutation) granted[index] = true;
        else tainted[index] = true;
      }
    }
  }

  // "Only change /T": every other path is read-only.
  if (onlyTargets.length > 0) {
    const onlyPaths = new Set(onlyTargets.map((index) => mentions[index]?.path));
    mentions.forEach((mention, index) => {
      if (!onlyPaths.has(mention.path)) tainted[index] = true;
    });
  }

  const hasDirectives = directiveWrite.size > 0 || directiveRead.size > 0;
  // Directives win over inference: a directive-written path is never tainted
  // by prose; a directive-read path always is.
  const directiveWritePaths = new Set([...directiveWrite].map((index) => mentions[index]?.path));
  mentions.forEach((mention, index) => {
    if (directiveWritePaths.has(mention.path)) tainted[index] = false;
  });
  for (const index of directiveRead) tainted[index] = true;
  let directiveConflict: string | null = null;
  for (const index of directiveWrite) {
    const path = mentions[index]?.path;
    if (path && [...directiveRead].some((other) => mentions[other]?.path === path)) directiveConflict = path;
  }

  const taintedPaths = mentions
    .map((mention, index) => (tainted[index] && mention.path ? mention.path : null))
    .filter((path): path is string => path !== null);
  const writeEligible = (index: number): boolean => {
    const path = mentions[index]?.path;
    if (!path) return false;
    if (taintedPaths.some((excluded) => isWithin(excluded, path))) return false;
    if (directiveWrite.size > 0) return directiveWritePaths.has(path);
    return granted[index] === true || directiveWrite.has(index);
  };

  // A single path in a request without any restriction is its target.
  const distinct = new Set(mentions.map((mention) => mention.path ?? mention.raw));
  if (!hasDirectives && distinct.size === 1 && !anyRestriction && !mentions[0]?.unresolved) {
    mentions.forEach((_, index) => {
      granted[index] = true;
    });
  }
  if (directiveWrite.size > 0) {
    mentions.forEach((_, index) => {
      granted[index] = directiveWrite.has(index);
    });
  }

  return {
    mentions,
    tainted,
    granted,
    mutationAimed,
    hasDirectives,
    directiveConflict,
    launchRestricted,
    anyRestriction,
    writeEligible,
  };
}
