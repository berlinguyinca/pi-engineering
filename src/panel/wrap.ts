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
 */

/** Wrap `text` to `width` columns. Never returns a line wider than `width`. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return [];

  const lines: string[] = [];
  let line = "";

  for (const word of collapsed.split(" ")) {
    if (line.length === 0) {
      // A word wider than the column has to be broken somewhere, and breaking
      // at the edge is the only option that never overflows.
      if (word.length > width) {
        let rest = word;
        while (rest.length > width) {
          lines.push(rest.slice(0, width));
          rest = rest.slice(width);
        }
        line = rest;
      } else {
        line = word;
      }
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = "";
    // Re-handle the word with an empty line, so an over-long word after a
    // break is still split rather than pushed out whole.
    if (word.length > width) {
      let rest = word;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      line = rest;
    } else {
      line = word;
    }
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
