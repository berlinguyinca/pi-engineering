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

/**
 * STRONG exclusion words: they taint every path of their sentence (subject
 * to two narrow exceptions, see analyzeRequest).
 */
const STRONG =
  /\b(?:do not|don'?t|dont|never|must not|mustn'?t|should not|shouldn'?t|shall not|may not|cannot|can'?t|won'?t|will not|avoid\w*|skip\w*|ignor\w*|exclud\w*|except\w*|untouched|unchanged|unmodified|refrain\w*|forbid\w*|prohibit\w*|disallow\w*|reference\w*|intact|frozen|off[- ]limits|hands[- ]off|read[- ]?only|as[- ]is|for context|not allowed|not permitted|under no circumstances|in no case|by no means|at no point|under any circumstances)\b|\bleave\b.*\balone\b|\bleft alone\b|\b(?:must|should|shall|will|to|has to|needs? to)\s+(?:stay|remain)\b|\bstays?\b|\bremains?\s+(?:as|the same|unchanged|untouched|intact)\b|\bkeep\b.*\b(?:as[- ]is|unchanged|intact|the same|untouched)\b|\bnot\s+(?:to\s+)?be\s+(?:modified|changed|touched|edited|altered|written|updated|mutated|deleted|removed)\b|\bas (?:an? |the )?(?:guide|example|template|model|baseline|inspiration)\b/i;
/** Weak exclusionary words: they taint a path only when they directly govern it. */
const WEAK_EXCLUSION = /^(?:no|not|nothing|none|neither|nor|without|longer|\w+n't)$/i;
/** Weak reference words: a governed path is a source, unless it is its sentence's only path and a mutation follows. */
const WEAK_REFERENCE =
  /^(?:review\w*|analy[sz]\w*|inspect\w*|audit\w*|look\w*|compar\w*|cop(?:y|ies|ied|ying)|mirror\w*|follow\w*|based|study|studying|consult\w*|port\w*)$/i;
/** How many tokens before a path a weak word may sit and still govern it. */
const GOVERNING_WINDOW = 4;
/** A negation right after a path ("/R is not …", "/R isn't …") governs it. */
const TRAILING_NEGATION = /^(?:not|never|\w+n't)$/i;
const TRAILING_WINDOW = 2;

/**
 * Result and conditional clauses ("so it no longer crashes", "so that it does
 * not leak", "to not use", "only if") describe the outcome of the change, not
 * an exclusion: their negation is dropped before any restriction test. A
 * path inside the clause keeps the negation (fail-safe).
 */
function neutralizeResultClauses(text: string): string {
  return text
    .replace(
      /\b(so(?: that)?|such that|unless|if|whether|to)\s+((?:[^\s\uE000]+\s+){0,3}?)(?:not|never|no longer)\b/gi,
      "$1 $2",
    )
    .replace(/\b(so(?: that)?|such that|unless|if|whether)\s+((?:[^\s\uE000]+\s+){0,3}?)(\w+)n't\b/gi, "$1 $2$3");
}
const FROM_PATH = /\bfrom\s+["'`]?\uE000(\d+)\uE001/gi;
const ONLY_PATH = /\bonly\s+(?:[^\s\uE000]+\s+){0,2}["'`]?\uE000(\d+)\uE001/gi;
/** Broad mutation vocabulary (stems). */
const MUTATION =
  /\b(?:add|creat|install|implement|fix|patch|build|appl|updat|chang|edit|modif|writ|wrote|refactor|renam|delet|remov|migrat|port|upgrad|bump|mov|merg|commit|push|configur|wir|clean|improv|extend|replac|convert|restructur|repair|debug|resolv|harden|set ?up|work|coordinat|integrat|rewrit|optimi[sz]|generat|scaffold|initiali[sz]|bootstrap|introduc|insert|append|tweak|adjust|correct|rework|make|ship|develop|code|finish|complete|continue|land|wire)\w*\b/i;
const REMOVAL = /\b(?:remov|delet|strip|drop|purg|eras|clean)\w*\b/i;
/** Words that make a restriction clause refer back to a path (or the repository itself). */
const PRONOUN =
  /\b(?:it|its|itself|them|they|this|these|those|there|here|either|both|former|latter|everything|anything|others?|repo|repos|repository|repositories|codebase|project|directory|folder|workspace|checkout|tree|files?)\b/i;
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
  /** Header / list intro the unit sits under. */
  context: string;
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
      units.push({ text: header, context: "" });
      continue;
    }
    const isItem = LIST_ITEM.test(trimmed);
    const body = trimmed.replace(LIST_ITEM, "");
    const context = [header, isItem ? intro : ""].filter(Boolean).join(": ");
    for (const sentence of body.split(SENTENCE_SPLIT)) {
      if (sentence.trim()) units.push({ text: context ? `${context}: ${sentence}` : sentence, context });
    }
    if (!isItem) intro = body.replace(/[:.]\s*$/, "");
  }

  const tainted = mentions.map(() => false);
  const granted = mentions.map(() => false);
  const mutationAimed = mentions.map(() => false);
  const mutationLed = mentions.map(() => false);
  let launchRestricted = false;
  const onlyTargets: number[] = [];
  let previousPaths: number[] = [];
  // A bare "/" counts as a path only when a mutation verb leads it ('Modify files in "/"').
  const distinctPaths = new Set(
    mentions.filter((mention) => mention.raw !== "/").map((mention) => mention.path ?? mention.raw),
  );
  /** Every strong hit of the request sits in a pathless clause about something else. */
  let strongAboutOtherThings = true;

  for (const unit of units) {
    const text = neutralizeResultClauses(unit.text);
    const paths = placeholders(text);
    const words = prose(text);
    const strong = STRONG.test(words);
    const mutation = MUTATION.test(words);
    for (const index of paths) if (mutation) mutationAimed[index] = true;

    if (paths.length === 0) {
      if (strong && LAUNCH_LOCATION.test(words)) launchRestricted = true;
      // "Modify /R? No." — a bare negation retracts the previous sentence.
      if (PURE_NEGATION.test(words.trim())) for (const index of previousPaths) tainted[index] = true;
      // "Fix /T. Do not modify it." — a pathless restriction that points back at a path.
      if (strong && PRONOUN.test(words.replace(/\b(?:anything|everything|nothing) else\b/gi, " "))) {
        strongAboutOtherThings = false;
        tainted.fill(true);
      }
      continue;
    }
    previousPaths = paths;

    const clauses = text.split(CLAUSE_SPLIT).filter((clause) => clause.trim());

    // A header or list intro with any restriction word taints the whole list under it.
    if (unit.context) {
      const contextWords = prose(neutralizeResultClauses(unit.context));
      const contextTokens = contextWords.split(/\s+/).map((token) => token.replace(/[^\w']/g, ""));
      if (
        STRONG.test(contextWords) ||
        contextTokens.some((token) => WEAK_EXCLUSION.test(token) || WEAK_REFERENCE.test(token))
      ) {
        for (const index of paths) tainted[index] = true;
      }
    }

    // Path-local rules: "from /R" is a source; weak words govern the path right after them.
    const sentencePaths = new Set(paths.map((index) => mentions[index]?.path ?? mentions[index]?.raw));
    const removalOfSinglePath = sentencePaths.size === 1 && REMOVAL.test(words);
    if (!removalOfSinglePath) for (const match of text.matchAll(FROM_PATH)) tainted[Number(match[1])] = true;
    for (const match of text.matchAll(ONLY_PATH)) if (mutation) onlyTargets.push(Number(match[1]));
    for (const clause of clauses) {
      for (const match of clause.matchAll(PLACEHOLDER)) {
        const index = Number(match[1]);
        const lead = clause.slice(0, match.index).split(OPEN).at(-1) ?? "";
        const tokens = lead
          .split(/\s+/)
          .map((token) => token.replace(/^["'`(*_]+|["'`)*_.,:;!?]+$/g, ""))
          .filter(Boolean)
          .slice(-GOVERNING_WINDOW);
        if (tokens.some((token) => WEAK_EXCLUSION.test(token))) tainted[index] = true;
        if (tokens.some((token) => MUTATION.test(token))) mutationLed[index] = true;
        const trail = clause
          .slice(match.index + match[0].length)
          .split(OPEN)[0]!
          .split(/\s+/)
          .map((token) => token.replace(/^["'`(*_]+|["'`)*_.,:;!?]+$/g, ""))
          .filter(Boolean)
          .slice(0, TRAILING_WINDOW);
        if (trail.some((token) => TRAILING_NEGATION.test(token))) tainted[index] = true;
        if (tokens.some((token) => WEAK_REFERENCE.test(token)) && !(sentencePaths.size === 1 && mutation)) {
          tainted[index] = true;
        }
      }
    }

    if (!strong) {
      if (mutation) for (const index of paths) granted[index] = true;
      continue;
    }

    // A clause holding only paths ("…, /b", "and /c") continues the previous
    // clause's list: it inherits its verb and, fail-safe, its restriction.
    let previous = { mutation: false, restricted: false };
    const clauseInfo = clauses.map((clause) => {
      const clauseWords = prose(clause);
      const clausePaths = placeholders(clause);
      const pathOnly = /^[\s,&]*(?:(?:and|or|nor|plus|&)\s*)?[\s,]*$/i.test(clauseWords);
      const clauseRestricted = STRONG.test(clauseWords) || (pathOnly && previous.restricted);
      const clauseMutation = MUTATION.test(clauseWords) || (pathOnly && previous.mutation);
      previous = { mutation: clauseMutation, restricted: clauseRestricted };
      const aboutRepository = PRONOUN.test(clauseWords.replace(/\b(?:anything|everything|nothing) else\b/gi, " "));
      return { clausePaths, restricted: clauseRestricted, clauseMutation, aboutRepository };
    });
    const restrictedClauses = clauseInfo.filter((info) => info.restricted);
    // Exception 1: each restriction sits in its own clause, naming its own path.
    const attachedToOtherPaths = restrictedClauses.every(
      (info) => info.clausePaths.length > 0 && !info.aboutRepository,
    );
    // Exception 2: the restriction is about a non-path object ("do not change the public API").
    const aboutOtherThings = restrictedClauses.every((info) => info.clausePaths.length === 0 && !info.aboutRepository);
    if (!aboutOtherThings) strongAboutOtherThings = false;
    for (const info of clauseInfo) {
      for (const index of info.clausePaths) {
        if (info.restricted) tainted[index] = true;
        else if (attachedToOtherPaths && info.clauseMutation) granted[index] = true;
        else if (aboutOtherThings && distinctPaths.size === 1) {
          if (mutation) granted[index] = true;
        } else tainted[index] = true;
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

  // A single path the request does not restrict is its target, verb or not;
  // restrictions about other things ("do not change the public API") only
  // count when exactly one path is named.
  const singleUntainted =
    !hasDirectives &&
    distinctPaths.size === 1 &&
    !mentions[0]?.unresolved &&
    strongAboutOtherThings &&
    tainted.every((value) => !value);
  if (singleUntainted) {
    mentions.forEach((_, index) => {
      granted[index] = true;
    });
  }
  mentions.forEach((mention, index) => {
    if (mention.raw === "/" && !directiveWrite.has(index)) granted[index] = mutationLed[index] === true;
  });
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
    anyRestriction: !strongAboutOtherThings || tainted.some(Boolean),
    writeEligible,
  };
}
