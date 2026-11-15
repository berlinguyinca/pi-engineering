/**
 * Spec 07 experiment A (deterministic half): inventory the safety invariants in a bounded worker
 * prompt, build a compressed variant, and prove every inventoried token survives.
 *
 * Offline analysis only. Production prompts (`src/workers/prompts.ts`) never call this.
 */

export interface PromptMeasure {
  readonly chars: number;
  readonly words: number;
  /** chars / 4. An approximation, not a tokenizer count: no tokenizer library is a dependency. */
  readonly approxTokens: number;
}

export interface InvariantCheck {
  readonly inventory: readonly string[];
  readonly lost: readonly string[];
}

// Case-insensitive, longest phrase first; the matched text keeps its original case.
const NORMATIVE =
  /\b(?:must not|must|never|always|shall not|shall|should not|should|do not|don't|cannot|avoid|forbidden|refuse|unless|except|without|at most|at least|only|required|nothing|not|no)\b/gi;
const BACKTICKED = /`([^`\n]+)`/g;
const SNAKE_IDENT = /\b[a-z]+(?:_[a-z]+)+\b/g;
const CITATION = /\b[\w./-]+\.[a-z]{1,4}:\d+\b/g;
const ISSUE_REF = /#\d+\b/g;
const NUMBER = /\b\d[\d_,.]*\b/g;

function collect(text: string, re: RegExp, group = 0): string[] {
  return [...text.matchAll(re)].map((m) => String(m[group]));
}

/** Every distinct MUST/NEVER-class token, negation, identifier, citation, issue ref and number. */
export function inventoryInvariants(text: string): string[] {
  const found = new Set<string>([
    ...collect(text, NORMATIVE),
    ...collect(text, BACKTICKED, 1),
    ...collect(text, SNAKE_IDENT),
    ...collect(text, CITATION),
    ...collect(text, ISSUE_REF),
    ...collect(text, NUMBER),
  ]);
  return [...found];
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-token occurrence count (case-sensitive; `not` never matches inside `note`, `nothing`, `cannot`).
 * Dropping one of several occurrences counts as loss. Count-based: it cannot see a clause that was
 * moved, or a negation attached to a different clause.
 */
function occurrences(text: string, token: string): number {
  return [...text.matchAll(new RegExp(`(?<![\\w])${escapeRe(token)}(?![\\w])`, "g"))].length;
}

/** Tokens from the source inventory that appear fewer times in the candidate than in the source. */
export function checkInvariantsSurvive(source: string, candidate: string): InvariantCheck {
  const inventory = inventoryInvariants(source);
  const lost = inventory.filter((t) => occurrences(candidate, t) < occurrences(source, t));
  return { inventory, lost };
}

const ARTICLES = /\b(?:a|an|the)\s+/g;
const FILLER: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bin order to\b/g, "to"],
  [/\bthat is\b/g, "is"],
  [/\bplease\b\s*/gi, ""],
];

/**
 * Deterministic telegraphic variant: drops articles and filler, collapses whitespace. Never touches
 * negations, modals, identifiers or numbers. Line structure is preserved (lists stay lists).
 * Articles are only removed outside backticks so code identifiers stay verbatim.
 */
export function compressPrompt(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(`[^`]*`)/)
        .map((part) => {
          if (part.startsWith("`")) return part;
          let out = part.replace(ARTICLES, "");
          for (const [re, to] of FILLER) out = out.replace(re, to);
          return out.replace(/[ \t]{2,}/g, " ");
        })
        .join("")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function measure(text: string): PromptMeasure {
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  return { chars: text.length, words, approxTokens: Math.ceil(text.length / 4) };
}
