/**
 * Row matching for the panel's vim-style search. Pure, and deliberately small.
 *
 * The design spec pointed at Pi's `findAltScreenSearchMatches` /
 * `AltScreenSearchIndex`. Those are not reusable here for two reasons, both
 * checked against the installed package rather than assumed:
 *
 *   1. They are not exported from `@earendil-works/pi-tui` — they are reachable
 *      only by deep-importing `dist/alt-screen-search.js`, which works today
 *      only because the package publishes no `exports` map.
 *   2. They answer a different question. They return per-row/column *segments*
 *      for highlighting a fullscreen transcript; the panel needs "which row is
 *      match N" so `n`/`N` can move a cursor.
 *
 * Matching is literal substring, never a RegExp, so a query like `config.ts`
 * means what the operator typed rather than treating `.` as any character.
 */

/** Smartcase: a lowercase query is case-insensitive; any uppercase makes it exact. */
function isCaseSensitive(query: string): boolean {
  return /[A-Z]/.test(query);
}

/**
 * Indices of every row whose label contains the query, in row order.
 *
 * A blank query matches nothing rather than everything: "no query" and "every
 * row" are different answers, and the second one is never what was wanted.
 */
export function findMatches(rows: readonly { label: string }[], query: string): number[] {
  const needle = query.trim();
  if (!needle) return [];
  const sensitive = isCaseSensitive(needle);
  const target = sensitive ? needle : needle.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const label = rows[i]?.label ?? "";
    const haystack = sensitive ? label : label.toLowerCase();
    if (haystack.includes(target)) matches.push(i);
  }
  return matches;
}

/**
 * Step to the next/previous match index, wrapping around.
 *
 * `current` is a position in `matches`, not a row index. Returns -1 when there
 * is nothing to step through.
 */
export function stepMatch(matches: readonly number[], current: number, direction: -1 | 1): number {
  if (matches.length === 0) return -1;
  const from = current < 0 ? 0 : current % matches.length;
  return (from + direction + matches.length) % matches.length;
}

/** The live search, while the prompt is open. */
export interface SearchState {
  query: string;
  /** Row indices that match, recomputed as the query changes. */
  matches: number[];
  /** Position within `matches`, or -1. */
  index: number;
  /** Selection to restore if the search is cancelled. */
  restoreSelection: number;
}
