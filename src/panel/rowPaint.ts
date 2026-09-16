/**
 * Colour for tree rows.
 *
 * Kept out of the component for the same reason shaping is: it is a pure
 * function of (text, tone, theme), so the whole colour scheme is testable
 * without a terminal.
 *
 * Two rules hold everywhere here:
 *
 *   1. **Colour never changes text.** Every function returns the same visible
 *      characters it was given. The panel's contract is one line per row, at
 *      most `width` columns, and a painter that inserted or dropped a character
 *      would corrupt the frame rather than decorate it.
 *   2. **Semantic names, never chromatic ones.** The tone says `removed`, the
 *      theme says what colour that is. A hardcoded red is wrong the moment the
 *      operator switches to a light theme, and their theme is the one place
 *      these colours have already been chosen to work together.
 *
 * The scheme itself is the conventional one — added green, modified amber,
 * deleted red, renamed accent, severities as traffic lights — because a file
 * tree with a private colour language is one the operator has to learn.
 */

import type { RowTone } from "./tree.ts";

/** The slice of Pi's Theme this module uses. */
export interface RowTheme {
  fg(colour: string, text: string): string;
}

/** Theme colour for each tone. */
const TONE_COLOUR: Record<RowTone, string> = {
  section: "accent",
  added: "success",
  modified: "warning",
  removed: "error",
  renamed: "accent",
  commit: "muted",
  high: "error",
  medium: "warning",
  low: "dim",
  ok: "success",
  note: "dim",
  error: "error",
};

/** Paint a row's glyph — the marker column, which carries the meaning. */
export function paintGlyph(glyph: string, tone: RowTone | undefined, theme: RowTheme | undefined): string {
  if (!theme || !glyph.trim()) return glyph;
  const colour = tone ? TONE_COLOUR[tone] : "dim";
  return safe(theme, colour, glyph);
}

/**
 * Paint a row's label.
 *
 * Most rows keep the panel's default text colour: colouring every word by its
 * row's tone turns a file list into a rainbow and makes the glyph column —
 * which is where the meaning actually is — stop standing out. What DOES get
 * colour is the part of a label that carries its own meaning: the `+31 -4`
 * counts, a commit's sha and age, a section's count.
 */
export function paintLabel(label: string, tone: RowTone | undefined, theme: RowTheme | undefined): string {
  if (!theme) return label;
  if (tone === "section") return paintSection(label, theme);
  if (tone === "commit") return paintCommit(label, theme);
  if (tone === "error" || tone === "high") return safe(theme, TONE_COLOUR[tone], label);
  if (tone === "note" || tone === "low") return safe(theme, "dim", label);
  return paintCounts(label, theme);
}

/** "Working tree · main +75 -2 (4)" — counts coloured, the name left alone. */
function paintSection(label: string, theme: RowTheme): string {
  const count = /\s\(\d+\)$/.exec(label);
  const head = count ? label.slice(0, count.index) : label;
  const tail = count ? safe(theme, "dim", count[0]) : "";
  return paintCounts(head, theme) + tail;
}

/** "2efa2d3 tint the panel · 14 minutes ago" — sha and age quiet, subject plain. */
function paintCommit(label: string, theme: RowTheme): string {
  const space = label.indexOf(" ");
  if (space < 0) return safe(theme, "accent", label);
  const sha = safe(theme, "accent", label.slice(0, space));
  const rest = label.slice(space);
  const age = / · [^·]+$/.exec(rest);
  if (!age) return sha + rest;
  return sha + rest.slice(0, age.index) + safe(theme, "dim", age[0]);
}

/**
 * Colour a trailing " +31 -4" or " (binary)" and leave the rest.
 *
 * Anchored to the END of the label so a path containing "+" or a subject
 * mentioning "-2" is never mistaken for a change count.
 */
function paintCounts(label: string, theme: RowTheme): string {
  const binary = label.endsWith(" (binary)");
  if (binary) {
    return label.slice(0, -9) + safe(theme, "dim", " (binary)");
  }
  const counts = / \+(\d+) -(\d+)$/.exec(label);
  if (!counts) return label;
  const head = label.slice(0, counts.index);
  const added = safe(theme, "toolDiffAdded", ` +${counts[1]}`);
  const removed = safe(theme, "toolDiffRemoved", ` -${counts[2]}`);
  return head + added + removed;
}

/** A theme that rejects a colour name must not take the frame down with it. */
function safe(theme: RowTheme, colour: string, text: string): string {
  try {
    return theme.fg(colour, text);
  } catch {
    return text;
  }
}
