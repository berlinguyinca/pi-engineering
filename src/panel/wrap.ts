/**
 * Word wrapping for the panel's prose pane.
 *
 * The tree is made of single lines that get truncated; a narrative is a
 * paragraph, and truncating it to one line would throw away most of what it
 * says. This wraps instead.
 *
 * Deliberately simple: it breaks on spaces and hard-breaks a word longer than
 * the column. Anything cleverer — hyphenation, locale-aware breaking — would be
 * a dependency and a source of surprises in a pane whose whole job is to be
 * glanceable.
 *
 * Every measurement here is VISIBLE width, never `String.length`. A fresh
 * review found this measuring UTF-16 units, which is the same number for ASCII
 * and wrong for everything else: a CJK character occupies two columns and one
 * unit, an emoji two columns and two units. The narrative is model-generated
 * prose, so it is exactly the text most likely to contain them — a 50-character
 * line of CJK came back 102 columns wide in a 60-column pane, which does not
 * merely look wrong, it corrupts the frame around it.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Cut `text` to at most `width` visible columns, returning the piece taken and
 * what is left.
 *
 * Character by character, because there is no arithmetic that maps a column
 * count back to an index when characters have different widths.
 */
function splitAtWidth(text: string, width: number): { head: string; rest: string } {
  let head = "";
  let used = 0;
  // Iterating the string yields code POINTS, so a surrogate pair is never cut
  // down the middle into two invalid halves.
  for (const char of text) {
    const w = visibleWidth(char);
    if (used + w > width) break;
    head += char;
    used += w;
  }
  // A single character wider than the whole column: take it anyway and let the
  // caller's clamp trim it, rather than looping forever on a word that can
  // never fit.
  if (head.length === 0) return { head: truncateToWidth(text, width, ""), rest: "" };
  return { head, rest: text.slice(head.length) };
}

/** Wrap `text` to `width` columns. Never returns a line wider than `width`. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return [];

  const lines: string[] = [];
  let line = "";

  /** Place a word on an empty line, breaking it at the column if it must be. */
  const place = (word: string): string => {
    let rest = word;
    while (visibleWidth(rest) > width) {
      const cut = splitAtWidth(rest, width);
      lines.push(cut.head);
      if (cut.rest === rest) return ""; // cannot make progress; drop the remainder
      rest = cut.rest;
    }
    return rest;
  };

  for (const word of collapsed.split(" ")) {
    if (line.length === 0) {
      // A word wider than the column has to be broken somewhere, and breaking
      // at the edge is the only option that never overflows.
      line = place(word);
      continue;
    }
    if (visibleWidth(line) + 1 + visibleWidth(word) <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    // Re-handle the word with an empty line, so an over-long word after a
    // break is still split rather than pushed out whole.
    line = place(word);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Wrap, then keep only the LAST `max` lines.
 *
 * The end of a narrative is the current state of the work; the beginning is
 * where it started. In a pane too small for both, the end is what the operator
 * needs.
 */
export function wrapTail(text: string, width: number, max: number): string[] {
  const all = wrapText(text, width);
  return max <= 0 ? [] : all.slice(Math.max(0, all.length - max));
}
