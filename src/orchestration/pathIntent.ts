/**
 * What a request asks of each filesystem path it names (PR #106 final review).
 *
 * Design, fail-safe by construction:
 *
 *  1. Exclusions win, globally. A path written in ANY exclusion position
 *     anywhere in the request (a negated mutation verb before it, "except",
 *     "but not", or a clause that calls it read-only / unchanged / reference /
 *     off-limits / "leave … alone") is excluded, whatever other mentions say.
 *  2. A path is writable only on a positive grant: a mutation verb governs it
 *     (or it is a destination: "into X", "… of A in X"). Reference verbs and
 *     prepositions ("copy", "follow", "analyze", "from X", "based on X") make it
 *     a reference. With no verb at all it is neutral; the resolver promotes a
 *     single neutral repository to the target and treats everything else as
 *     read-only.
 *  3. Negation scope is not cut by commas, parentheticals, "please",
 *     "under any circumstances" or emphasis: it runs from the negation to the
 *     end of its clause. Clauses split only at explicit connectives ("and"
 *     followed by a new verb phrase, "but", "while", ", then", "using", …).
 *
 * The classifier works on a masked copy of the request in which every path
 * mention is replaced by a placeholder, so path characters (dots, commas,
 * spaces in quoted paths) never interfere with sentence or clause splitting.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface PathMention {
  /** Absolute path (tilde and relative paths expanded). */
  path: string;
  start: number;
  end: number;
}

export type PathRole = "positive" | "reference" | "neutral";

export interface PathIntent {
  mention: PathMention;
  role: PathRole;
  /** Named in an exclusion position: never writable. */
  excluded: boolean;
  /** Excluded by "do not touch/use/access": not even a read root. */
  hardExcluded: boolean;
}

const OPEN = "\uE000";
const CLOSE = "\uE001";
const PLACEHOLDER = /\uE000(\d+)\uE001/g;

const TRAILING_PROSE = /[,:;!?]+$/;

function stripUnquotedPunctuation(candidate: string): string {
  let stripped = candidate.replace(TRAILING_PROSE, "");
  while (stripped.endsWith(".") && !stripped.endsWith("/.") && stripped !== "." && stripped !== "..") {
    stripped = stripped.slice(0, -1);
  }
  return stripped.replace(TRAILING_PROSE, "");
}

function expandPath(raw: string, launchCwd: string): string | null {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw.startsWith("./") || raw.startsWith("../")) return resolve(launchCwd, raw);
  return isAbsolute(raw) ? raw : null;
}

/** Absolute, `~`, `~/…`, `./…` and `../…` paths, quoted (any of "'`) or bare. */
export function extractPathMentions(request: string, launchCwd: string): PathMention[] {
  const mentions: PathMention[] = [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  for (const match of request.matchAll(/(["'`])((?:\/|~\/|~(?=["'`])|\.\.?\/).*?)\1/gs)) {
    const end = match.index + match[0].length;
    quotedRanges.push({ start: match.index, end });
    const path = expandPath(match[2] ?? "", launchCwd);
    if (path) mentions.push({ path, start: match.index, end });
  }
  const bare = /(?<![\w/:.~-])(?:\/[A-Za-z0-9._~]|~(?=\/|[\s,.;:!?)]|$)|\.\.?\/)[^\s"'`<>()[\]{}]*/g;
  for (const match of request.matchAll(bare)) {
    if (quotedRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
    const candidate = stripUnquotedPunctuation(match[0]);
    if (candidate === "/" || candidate.length === 0) continue;
    const path = expandPath(candidate, launchCwd);
    if (path) mentions.push({ path, start: match.index, end: match.index + candidate.length });
  }
  return mentions.sort((left, right) => left.start - right.start);
}

/**
 * Canonical prose: compatibility-normalized (full-width letters), invisible
 * characters removed, typographic apostrophes folded, so look-alike text
 * cannot hide a negation.
 */
function normalizeProse(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function mask(request: string, mentions: PathMention[]): string {
  let masked = "";
  let cursor = 0;
  mentions.forEach((mention, index) => {
    masked += normalizeProse(request.slice(cursor, mention.start));
    masked += `${OPEN}${index}${CLOSE}`;
    cursor = mention.end;
  });
  masked += normalizeProse(request.slice(cursor));
  // "don't just read X" / "not only X" is emphasis, not a negation.
  return masked.replace(/(?:\bnot|n't)\s+(?:just|only|merely|simply)\s+[\w-]+/gi, " ");
}

/**
 * Blocks: one per line, except that the items of a markdown list belong to the
 * header line that introduces them ("DO NOT MODIFY:" / "## Read-only"), so a
 * header's cue reaches every listed path.
 */
function blocks(masked: string): string[] {
  const out: string[] = [];
  let headerOpen = false;
  for (const line of masked.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      headerOpen = false;
      continue;
    }
    const isItem = /^(?:[-*+\u2022]|\d+[.)])\s+/.test(trimmed);
    if (isItem && headerOpen && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${trimmed.replace(/^(?:[-*+\u2022]|\d+[.)])\s+/, "")}`;
      continue;
    }
    const content = trimmed.replace(/^(?:[-*+\u2022]|\d+[.)])\s+/, "");
    out.push(content);
    headerOpen = !isItem && (/:\s*$/.test(trimmed) || /^#{1,6}\s/.test(trimmed));
  }
  return out;
}

const SENTENCE_SPLIT = /(?<=[.!?;])\s+/;
const CLAUSE_SPLIT =
  /\s+(?:but|yet|while|whereas|however|so|then|using|and then|and also)\s+|\s+and\s+(?!\uE000)|,\s*(?=(?:and\s+)?(?:then|but|keeping|leaving|while|so|however|yet|using)\b)|\s+[\u2014\u2013-]{1,2}\s+/i;

const NEGATION = /\bnot\b|n't\b|\bnever\b|\bno\b|\bwithout\b|\bavoid(?:ing)?\b|\bnor\b|\bdont\b/gi;
const NEGATABLE_VERB =
  /^(?:touch(?:es|ed|ing)?|modif(?:y|ies|ied|ying|ications?)|chang(?:e|es|ed|ing)|edit(?:s|ed|ing)?|alter(?:s|ed|ing)?|writ(?:e|es|ing|ten)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|mutat(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|refactor(?:s|ed|ing)?|rewrit(?:e|es|ing|ten)|commit(?:s|ted|ting)?|push(?:es|ed|ing)?|us(?:e|es|ed|ing)|access(?:es|ed|ing)?|make|making)$/i;
const HARD_VERB = /^(?:touch(?:es|ed|ing)?|us(?:e|es|ed|ing)|access(?:es|ed|ing)?)$/i;
/** Words after a negation that show it is not about mutating a path ("do not stop until …"). */
const NEGATION_BLOCKER =
  /^(?:until|unless|before|after|if|when|whenever|stop|forget|hesitate|wait|worry|longer|matter|fail|regress(?:ion)?|break)$/i;
const MAX_NEGATION_GAP = 8;
const EXCEPT = /\b(?:except|excluding|other than|apart from|save for)\b/gi;
/** "but not X", "not in X": a bare negation directly before a path (only prepositions/articles between). */
const BARE_NOT_BEFORE_PATH =
  /\bnot\s+(?:(?:in|to|into|inside|under|within|on|at|for|from|with|the|a|an|any|of)\s+){0,2}["'`]?(?=\uE000)/gi;
/** Clause-wide state cues: every path in the clause is excluded (read-only). */
const STATE_CUE =
  /\bread[- ]?only\b|\breference\b|\bfor context\b|\bas context\b|\buntouched\b|\bunchanged\b|\bunmodified\b|\bintact\b|\bas[- ]is\b|\bleave\b.*\balone\b|\bleft alone\b|\boff[- ]limits\b|\bfrozen\b|\b(?:must|should|shall|will|to|has to|needs to)\s+stay\b|\bstays?\s+(?:the same|put)\b|\bas (?:a |an |the )?(?:guide|example|template|model|baseline|inspiration)\b/i;
const PASSIVE_PROHIBITION =
  /\b(?:not|never|no)\b.*\bbe\s+(?:modified|changed|touched|edited|altered|written|updated|mutated|deleted|removed|refactored)\b|\b(?:not|never)\s+(?:to\s+)?(?:be\s+)?(?:modified|changed|touched|edited|altered|written to|updated|mutated)\b/i;

const MUTATION_VERB =
  /\b(?:modify|modifies|edit|change|write|delete|remove|create|refactor|implement|fix|update|rewrite|build|add|patch|work|commit|apply|coordinate|integrate|migrate|upgrade|bump|rename|move|merge|install|configure|wire|clean|optimi[sz]e|improve|extend|replace|convert|restructure|port|backport|repair|debug|resolve|address|harden|set up|setup|review)\b/gi;
const REFERENCE_VERB =
  /\b(?:copy|mirror|follow|imitate|replicate|emulate|analy[sz]e|inspect|examine|read|study|consult|compare|learn|look at|see|check out)\b/gi;
const COPY_VERB = /^(?:copy|mirror|follow|imitate|replicate|emulate|port|backport|apply|move)$/i;
const REMOVAL_VERB = /^(?:remove|delete|clean|strip|drop|purge|erase)$/i;
const DESTINATION_LOCAL = /\b(?:into|onto)\s+(?:[^\s\uE000]+\s+){0,3}$/i;
const COPY_DESTINATION_LOCAL = /\b(?:in|to|inside|within|under)\s+(?:the\s+)?(?:[^\s\uE000]+\s+)?$/i;
const REFERENCE_LOCAL =
  /\b(from|like|than|versus|vs\.?|based on|modell?ed (?:on|after)|inspired by|according to|similar to|same as)\s+(?:[^\s\uE000]+\s+){0,3}$/i;

interface ClausePath {
  index: number;
  position: number;
  end: number;
}

function placeholders(clause: string): ClausePath[] {
  return [...clause.matchAll(PLACEHOLDER)].map((match) => ({
    index: Number(match[1]),
    position: match.index,
    end: match.index + match[0].length,
  }));
}

/** Paths a negation/except operator at `at` reaches: those after it, or all when none follow and no mutation precedes. */
function scoped(clause: string, paths: ClausePath[], at: number): ClausePath[] {
  const after = paths.filter((path) => path.position > at);
  if (after.length > 0) return after;
  const mutationBefore = [...clause.slice(0, paths[0]?.position ?? 0).matchAll(MUTATION_VERB)].length > 0;
  return mutationBefore ? [] : paths;
}

function lastVerb(text: string): { verb: string; kind: "mutation" | "reference" } | null {
  let best: { verb: string; kind: "mutation" | "reference"; at: number } | null = null;
  for (const match of text.matchAll(MUTATION_VERB)) {
    if (!best || match.index >= best.at) best = { verb: match[0], kind: "mutation", at: match.index };
  }
  for (const match of text.matchAll(REFERENCE_VERB)) {
    if (!best || match.index >= best.at) best = { verb: match[0], kind: "reference", at: match.index };
  }
  return best ? { verb: best.verb, kind: best.kind } : null;
}

function classifyClause(clause: string, intents: PathIntent[]): void {
  const paths = placeholders(clause);
  if (paths.length === 0) return;
  const exclude = (path: ClausePath, hard: boolean) => {
    const intent = intents[path.index]!;
    intent.excluded = true;
    if (hard) intent.hardExcluded = true;
  };

  // Clause-wide state cues ("read-only", "unchanged", "leave X alone", …).
  const prose = clause.replace(PLACEHOLDER, " ");
  if (STATE_CUE.test(prose) || PASSIVE_PROHIBITION.test(prose)) for (const path of paths) exclude(path, false);

  // Negated mutation verbs: scope runs from the negation to the clause end.
  for (const match of clause.matchAll(NEGATION)) {
    const tail = clause.slice(match.index + match[0].length);
    const words = tail
      .split(/[\s,()]+/)
      .map((word) => word.replace(/^["'`*_]+|["'`*_.!?;:]+$/g, ""))
      .filter(Boolean);
    for (let i = 0; i < Math.min(words.length, MAX_NEGATION_GAP + 1); i++) {
      const word = words[i]!;
      if (word.includes(OPEN) || NEGATION_BLOCKER.test(word)) break;
      if (NEGATABLE_VERB.test(word)) {
        for (const path of scoped(clause, paths, match.index)) exclude(path, HARD_VERB.test(word));
        break;
      }
    }
  }
  for (const match of clause.matchAll(EXCEPT)) {
    for (const path of scoped(clause, paths, match.index)) exclude(path, false);
  }
  for (const match of clause.matchAll(BARE_NOT_BEFORE_PATH)) {
    for (const path of paths.filter((candidate) => candidate.position >= match.index + match[0].length)) {
      exclude(path, false);
      break;
    }
  }

  // Role from the governing verb / preposition.
  paths.forEach((path, position) => {
    const intent = intents[path.index]!;
    const previous = paths[position - 1];
    const local = clause.slice(previous ? previous.end : 0, path.position);
    const verb = lastVerb(clause.slice(0, path.position));
    let role: PathRole = "neutral";
    const referenceLocal = REFERENCE_LOCAL.exec(local);
    if (DESTINATION_LOCAL.test(local)) role = "positive";
    else if (previous && verb && COPY_VERB.test(verb.verb) && COPY_DESTINATION_LOCAL.test(local)) role = "positive";
    else if (referenceLocal) {
      role =
        referenceLocal[1]?.toLowerCase() === "from" && verb && REMOVAL_VERB.test(verb.verb) ? "positive" : "reference";
    } else if (verb) role = verb.kind === "mutation" ? "positive" : "reference";
    // Strongest role wins across mentions of the same placeholder (one per index).
    intent.role = role;
  });
}

/** Classify every path mention of `request`. */
export function classifyPathIntents(request: string, launchCwd: string): PathIntent[] {
  const mentions = extractPathMentions(request, launchCwd);
  const intents: PathIntent[] = mentions.map((mention) => ({
    mention,
    role: "neutral",
    excluded: false,
    hardExcluded: false,
  }));
  for (const block of blocks(mask(request, mentions))) {
    for (const sentence of block.split(SENTENCE_SPLIT)) {
      for (const clause of sentence.split(CLAUSE_SPLIT)) {
        if (clause) classifyClause(clause, intents);
      }
    }
  }
  return intents;
}
