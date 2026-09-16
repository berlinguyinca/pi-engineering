/**
 * Panel component — paints rows and moves a cursor. Nothing else.
 *
 * All shaping lives in `tree.ts`, so this file stays small enough to reason
 * about and the interesting behaviour is testable without a terminal. The one
 * hard contract it owns is Pi's: every line returned by `render(width)` must
 * be at most `width` visible columns, and there is exactly one line per row —
 * the panel truncates, it never wraps.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PanelState } from "./PanelState.ts";
import { type CopyResult, copyToTerminal } from "./clipboard.ts";
import type { ContentView } from "./content.ts";
import { type GutterKind, formatGutter, gutterWidth, numberDiffLines, numberFileLines } from "./gutter.ts";

/** ANSI full reset, as emitted by `Theme.fg`. */
const RESET = "\u001b[0m";

/** The panel's left edge, and the columns it costs (glyph + space). */
const BORDER_GLYPH = "│";
const BORDER_WIDTH = 2;

/**
 * Share of the panel given to the narrative pane.
 *
 * A third: enough for a few sentences of arc, not so much that the tree — the
 * part you act on — has to scroll to show a handful of files.
 */
const NARRATIVE_SHARE = 1 / 3;
/** Below this the split is abandoned: two cramped panes are worse than one. */
const MIN_SPLIT_HEIGHT = 12;
import { highlightLine, looksLikeDiff } from "./highlight.ts";
import {
  DEFAULT_LAYOUT,
  type PanelLayout,
  type PanelLayoutPatch,
  type PanelTabId,
  stepTab,
  stepWidth,
} from "./layout.ts";
import { paintGlyph, paintLabel } from "./rowPaint.ts";
import { type SearchState, findMatches, stepMatch } from "./search.ts";
import { type PanelRow, type RowPayload, buildRows, clampSelection, renderTabBar } from "./tree.ts";
import { wrapTail } from "./wrap.ts";

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KEY_ESCAPE = "\x1b";
const KEY_TAB = "\t";
const KEY_SHIFT_TAB = "\x1b[Z";
const KEY_BACKSPACE = "\x7f";
const KEY_ENTER = "\r";

export interface PanelComponentOptions {
  state: PanelState;
  /** Requested when the component needs a repaint. */
  requestRender: () => void;
  /** Open a file or diff row; the controller supplies the reader. */
  openRow?: (payload: RowPayload) => void;
  /** Close the panel (escape with no content view open). */
  onClose?: () => void;
  /** Layout to open with (tab, width, expansion). Defaults apply when omitted. */
  layout?: PanelLayout;
  /** Called whenever the operator changes tab, width, or expansion. */
  onLayoutChange?: (layout: PanelLayoutPatch) => void;
  /**
   * Rows the panel should occupy, when known.
   *
   * An overlay is exactly as tall as the lines its component returns, so a
   * panel with two rows of content renders as two rows floating in the corner
   * rather than a column. Padding to this height is what makes it a panel.
   */
  fillHeight?: () => number | undefined;
  /** Pi's Theme, when the session has one. Absent in tests and headless runs. */
  theme?: { fg(colour: string, text: string): string; getBgAnsi?(colour: string): string };
  /**
   * Whether the panel currently holds the keyboard.
   *
   * The panel is registered `nonCapturing`, so arrows and enter go to the
   * prompt until the operator steps into it. Without this the panel looks
   * interactive and silently is not — which reads as "the panel is broken",
   * not as "press a key first".
   */
  focused?: () => boolean;
  /** The chord that steps into the panel, named in the hint. */
  chord?: string;
  /** Copy sink. Defaults to OSC 52 on stdout. */
  copy?: (text: string) => CopyResult;
}

export class PanelComponent {
  private readonly state: PanelState;
  private readonly requestRenderFn: () => void;
  private readonly openRow: ((payload: RowPayload) => void) | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly onLayoutChange: ((layout: PanelLayoutPatch) => void) | undefined;
  private readonly fillHeight: (() => number | undefined) | undefined;
  private readonly theme: { fg(colour: string, text: string): string; getBgAnsi?(colour: string): string } | undefined;
  private readonly focusedFn: (() => boolean) | undefined;
  private readonly chord: string | undefined;
  private readonly copyFn: (text: string) => CopyResult;
  private readonly unsubscribe: () => void;

  /**
   * Expansion lives here rather than in `PanelState` on purpose: it is a `Set`,
   * and `PanelState.set()` no-ops on `JSON.stringify` equality, which does not
   * compare Sets. The layout store reads it out through `onLayoutChange`.
   */
  private expanded: Set<string>;
  private activeTab: PanelTabId;
  private width: number;
  private currentRows: PanelRow[] = [];
  private selection = 0;
  private content: ContentView | null = null;
  private search: SearchState | null = null;
  /** Committed matches, so `n`/`N` keep working after the prompt closes. */
  private lastSearch: { matches: number[]; index: number } | null = null;
  /**
   * Which RENDERED line the cursor is on, so the row can carry a selection
   * background. Not the same as `selection`, which indexes rows: the tab bar
   * occupies a line and the rows start below it.
   */
  private selectedLine: number | null = null;
  /** Transient one-line message (a copy result), cleared by the next keystroke. */
  private notice: string | null = null;
  private disposed = false;

  constructor(opts: PanelComponentOptions) {
    this.state = opts.state;
    this.requestRenderFn = opts.requestRender;
    this.openRow = opts.openRow;
    this.onClose = opts.onClose;
    this.onLayoutChange = opts.onLayoutChange;
    this.fillHeight = opts.fillHeight;
    this.theme = opts.theme;
    this.focusedFn = opts.focused;
    this.chord = opts.chord;
    this.copyFn = opts.copy ?? ((text) => copyToTerminal(text));
    // The layout is the single source of truth for what is open, including the
    // first-open defaults (see DEFAULT_LAYOUT.expanded).
    const layout = opts.layout ?? DEFAULT_LAYOUT;
    this.expanded = new Set<string>(layout.expanded);
    this.activeTab = layout.tab;
    this.width = layout.widthPercent;
    this.unsubscribe = this.state.subscribe(() => this.requestRenderFn());
    this.refreshRows();
  }

  /** The active tab. */
  get tab(): PanelTabId {
    return this.activeTab;
  }

  /** The overlay width the operator has chosen, as a percentage of columns. */
  get widthPercent(): number {
    return this.width;
  }

  /** Expanded section ids, for persistence. */
  get expandedIds(): string[] {
    return [...this.expanded].sort();
  }

  /** The rows currently shaped from state (test seam). */
  get rows(): readonly PanelRow[] {
    return this.currentRows;
  }

  /** Index of the selected row, or -1 when nothing is selectable. */
  get selectedIndex(): number {
    return this.selection;
  }

  /** Show a file or diff in place of the tree. Escape returns to the tree. */
  showContent(view: ContentView): void {
    this.content = view;
    this.requestRenderFn();
  }

  render(width: number): string[] {
    const max = Math.max(0, width);
    try {
      // The border owns two columns, so everything inside is rendered narrower
      // rather than being drawn and then clipped by the frame.
      const inner = Math.max(0, max - BORDER_WIDTH);
      const lines = this.content ? this.renderContent(inner) : this.renderTree(inner);
      // Belt and braces: the TUI contract is per-line, and a styling mistake
      // here would corrupt the whole frame.
      const bounded = lines.map((line) => (visibleWidth(line) > inner ? truncateToWidth(line, inner, "…") : line));

      const total = this.fillHeight?.();
      const narrative = this.renderNarrative(inner, total);
      if (narrative.length === 0) {
        const body = this.padToHeight(bounded, inner);
        this.clampSelectedLine(body.length);
        return this.clamp(this.withBorder(this.withHint(body, inner), inner), max);
      }

      // The tree takes what the narrative does not, so the split always sums to
      // the height the overlay was given rather than overflowing it.
      const topHeight = Math.max(0, (total ?? bounded.length + narrative.length) - narrative.length);
      const top = bounded.length >= topHeight ? bounded.slice(0, topHeight) : this.pad(bounded, topHeight, inner);
      this.clampSelectedLine(top.length);
      return this.clamp(this.withBorder([...this.withHint(top, inner), ...narrative], inner), max);
    } catch {
      // Never throw into Pi's render loop.
      return [];
    }
  }

  /**
   * Put the key hint on the pane's last row.
   *
   * It OVERWRITES rather than appends, so the hint costs nothing when the panel
   * is full and sits in otherwise-blank padding when it is not — a row that
   * pushed content off the bottom to explain how to reach that content would be
   * its own joke.
   *
   * Nothing is shown while a file is open or a search is being typed: the hint
   * answers "why do my arrow keys do nothing", and in both of those states they
   * do something.
   */
  private withHint(lines: string[], width: number): string[] {
    if (lines.length < 2 || this.content || this.search || !this.focusedFn) return lines;
    const hint = this.hintText();
    if (!hint) return lines;
    const painted = this.safeFg("dim", truncateToWidth(hint, width, "…"));
    return [...lines.slice(0, -1), painted];
  }

  /** What the operator can press, given where the keyboard currently is. */
  private hintText(): string {
    if (this.focusedFn?.() === true) return " ↑↓ move · ⏎ open · esc leave · tab switch";
    const chord = this.chord && this.chord !== "none" ? this.chord : undefined;
    return chord ? ` ${chord} to navigate` : "";
  }

  /**
   * The last word on the width contract.
   *
   * `bounded` clamps the tree and content panes to the INNER width, which is
   * the right place for it: those lines are composed here. But it never saw the
   * narrative pane, and it measures the wrong number below width 2, where the
   * border's two columns exceed the panel itself. Two escapes from one rule, so
   * the rule is enforced once more at the edge it actually states: every line
   * render(width) returns is at most `width` visible columns.
   *
   * Cheap, because it only rewrites a line that is already wrong.
   */
  private clamp(lines: string[], width: number): string[] {
    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
  }

  /**
   * Forget the cursor's line when it falls outside the tree pane.
   *
   * Both paths clip: `padToHeight` to the terminal, and the split to whatever
   * the narrative leaves. A selection below the fold is off screen, and its
   * index then refers to a line the tree no longer occupies — in the split that
   * is a row of the SUMMARY, so the highlight would land on generated prose
   * while the cursor is somewhere else entirely.
   */
  private clampSelectedLine(treeHeight: number): void {
    if (this.selectedLine !== null && this.selectedLine >= treeHeight) this.selectedLine = null;
  }

  /**
   * The bottom pane: what this session has been working on.
   *
   * Returns nothing when there is no narrative, or when the panel is too short
   * to carry two panes — a tree squeezed into four rows next to three rows of
   * prose serves neither, and the tree is the half you act on.
   *
   * The text is labelled as generated on its own rule. It is a model's summary
   * of observed state, not a record of it, and the panel must never let the two
   * read the same (INV-006).
   */
  private renderNarrative(width: number, totalHeight: number | undefined): string[] {
    const narrative = this.state.snapshot.narrative;
    if (!narrative?.text || this.content) return [];
    if (totalHeight === undefined || totalHeight < MIN_SPLIT_HEIGHT) return [];

    const paneHeight = Math.max(3, Math.floor(totalHeight * NARRATIVE_SHARE));
    const bodyHeight = paneHeight - 1; // one row for the rule
    const rule = this.rule(width, "summary · generated");
    const body = wrapTail(narrative.text, width, bodyHeight);
    const painted = body.map((l) => this.safeFg("thinkingText", l));
    return [rule, ...painted, ...Array.from({ length: Math.max(0, bodyHeight - painted.length) }, () => "")];
  }

  /** A titled horizontal rule: `── summary · generated ────`. */
  private rule(width: number, title: string): string {
    const label = ` ${title} `;
    const dashes = Math.max(0, width - label.length - 2);
    const text = `──${label}${"─".repeat(dashes)}`;
    return this.safeFg("borderMuted", truncateToWidth(text, width, "…"));
  }

  /**
   * Colour one fragment, or leave it alone.
   *
   * Every painter in this file is individually guarded, because render's own
   * catch returns an EMPTY panel: one throwing theme call would otherwise take
   * the tree, the summary and the border down together, hiding everything the
   * operator was reading in order to report a colour that could simply have
   * been skipped. The tree and the gutter already worked this way; the
   * narrative and the rule did not, which a fresh review found.
   */
  private safeFg(colour: string, text: string): string {
    if (!this.theme) return text;
    try {
      return this.theme.fg(colour, text);
    } catch {
      return text;
    }
  }

  /** Pad `lines` to `height` with blanks of the panel's inner width. */
  private pad(lines: string[], height: number, width: number): string[] {
    if (lines.length >= height) return lines;
    const blank = " ".repeat(Math.max(0, width));
    return [...lines, ...Array.from({ length: height - lines.length }, () => blank)];
  }

  /**
   * Draw the panel's left edge.
   *
   * Applied AFTER height padding so the blank rows carry it too: an edge that
   * stops where the content stops reads as ragged text in the corner rather
   * than a column beside the transcript, which is the whole visual difference
   * between "some output" and "a panel".
   */
  private withBorder(lines: string[], inner: number): string[] {
    const edge = this.safeFg("borderMuted", BORDER_GLYPH);
    const bg = this.backgroundAnsi();
    // The cursor's row gets the theme's selection background instead of the
    // panel's, across the FULL width including the padding — a highlight that
    // stopped at the end of the text would read as a stray coloured word.
    const selectedBg = this.selectedLine === null ? "" : this.bgAnsi("selectedBg");
    return lines.map((line, index) => {
      const pad = Math.max(0, inner - visibleWidth(line));
      const rowBg = index === this.selectedLine && selectedBg ? selectedBg : bg;
      return this.tint(`${edge} ${line}${" ".repeat(pad)}`, rowBg);
    });
  }

  /**
   * The panel's own background, so the column reads as a surface rather than
   * text floating over the transcript.
   *
   * `customMessageBg` is pi's tint for an extension's own block — subtle in
   * both shipped themes (#2d2838 dark, #ede7f6 light) and, unlike a hardcoded
   * shade, correct in whatever theme the operator actually uses. There is no
   * way to read the terminal's real background, so "slightly darker" is the
   * theme's judgement rather than a computed offset.
   */
  private backgroundAnsi(): string {
    return this.bgAnsi("customMessageBg");
  }

  /** One background escape, or nothing at all when the theme cannot supply it. */
  private bgAnsi(colour: string): string {
    try {
      return this.theme?.getBgAnsi?.(colour) ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Paint one composed line with the background.
   *
   * The subtlety: `theme.fg()` ends its span with a full reset, which clears
   * the BACKGROUND as well as the foreground. A line wrapped naively loses its
   * tint at the first coloured token and stays lost. So every reset already in
   * the line is followed by the background being re-armed, and the line is
   * closed with one final reset.
   */
  private tint(line: string, bg: string): string {
    if (!bg) return line;
    return `${bg}${line.replaceAll(RESET, `${RESET}${bg}`)}${RESET}`;
  }

  /**
   * Pad (or clip) the panel to the height it was told to occupy.
   *
   * An overlay is exactly as tall as the lines it returns, so without this a
   * panel with two rows of content renders as two rows floating in a corner
   * rather than a column beside the transcript. Padding with blanks of the full
   * width keeps the background continuous instead of leaving ragged edges.
   *
   * Clipping matters as much as padding: content longer than the terminal would
   * otherwise push the overlay past the bottom of the screen.
   */
  private padToHeight(lines: string[], width: number): string[] {
    const target = this.fillHeight?.();
    if (target === undefined || target <= 0) return lines;
    if (lines.length >= target) return lines.slice(0, target);
    const blank = " ".repeat(width);
    return [...lines, ...Array.from({ length: target - lines.length }, () => blank)];
  }

  handleInput(data: string): void {
    if (this.disposed) return;

    if (this.content) {
      // Only escape is meaningful while a file is open.
      if (data === KEY_ESCAPE) {
        this.content = null;
        this.requestRenderFn();
      }
      return;
    }

    // A notice belongs to the keystroke that produced it and nothing after.
    if (this.notice && data !== "y" && data !== "Y") this.notice = null;

    // While the prompt is open every key belongs to the query, so a tab or an
    // arrow types/edits rather than navigating.
    if (this.search) {
      this.handleSearchInput(data);
      return;
    }

    switch (data) {
      case KEY_TAB:
        this.changeTab(1);
        return;
      case KEY_SHIFT_TAB:
        this.changeTab(-1);
        return;
      case ">":
        this.changeWidth(1);
        return;
      case "<":
        this.changeWidth(-1);
        return;
      case KEY_UP:
        this.move(-1);
        return;
      case KEY_DOWN:
        this.move(1);
        return;
      case KEY_RIGHT:
      case "\r":
      case "\n":
        this.activate();
        return;
      case KEY_LEFT:
        this.collapse();
        return;
      case "y":
        this.copyRow();
        return;
      case "Y":
        this.copyBody();
        return;
      case "/":
        this.openSearch();
        return;
      case "n":
        this.jumpMatch(1);
        return;
      case "N":
        this.jumpMatch(-1);
        return;
      case KEY_ESCAPE:
        this.onClose?.();
        return;
      default:
        // Unknown input is ignored rather than guessed at.
        return;
    }
  }

  /**
   * Focus moved in or out of the panel.
   *
   * The key hint depends on it, and focus is the controller's to know — the
   * component holds no overlay handle — so the repaint has to be asked for
   * rather than observed.
   */
  focusChanged(): void {
    this.requestRenderFn();
  }

  /** Pi calls this on theme changes; rows are rebuilt on the next render. */
  invalidate(): void {
    this.refreshRows();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private renderTree(width: number): string[] {
    this.refreshRows();
    const body = this.currentRows.map((row, index) => this.renderRow(row, index === this.selection, width));
    // The tab bar is line 0, so the cursor's row sits one below its index.
    this.selectedLine = this.selection >= 0 && this.selection < this.currentRows.length ? this.selection + 1 : null;
    const lines = [renderTabBar(this.activeTab, width, this.theme), ...body];
    if (this.search) lines.push(truncateToWidth(`/${this.search.query}`, width, "…"));
    if (this.notice) lines.push(truncateToWidth(this.notice, width, "…"));
    return lines;
  }

  /**
   * One tree row: cursor, indent, glyph, label.
   *
   * The LABEL is truncated to the space the fixed columns leave, and colour is
   * applied afterwards — the same rule the diff gutter follows, and for the
   * same reason: truncating painted text cuts an escape sequence in half and
   * stains the rest of the frame.
   */
  private renderRow(row: PanelRow, selected: boolean, width: number): string {
    const cursor = selected ? "›" : " ";
    const indent = "  ".repeat(row.depth);
    const glyph = row.glyph ? `${row.glyph} ` : "";
    const plain = `${cursor}${indent}${glyph}${row.label}`;
    const headWidth = visibleWidth(`${cursor}${indent}${glyph}`);
    // Too narrow for the label to survive at all: fall back to the plain row
    // rather than paint fragments of a head that is itself being cut.
    if (!this.theme || width <= headWidth) return truncateToWidth(plain, width, "…");
    const label = truncateToWidth(row.label, width - headWidth, "…");
    const painted = `${paintGlyph(row.glyph, row.tone, this.theme)} `;
    return `${cursor}${indent}${row.glyph ? painted : ""}${paintLabel(label, row.tone, this.theme)}`;
  }

  private renderContent(width: number): string[] {
    const view = this.content;
    if (!view) return [];
    // No tree on screen, so no row to highlight.
    this.selectedLine = null;
    const header = truncateToWidth(`◂ ${view.title}`, width, "…");
    if (view.error) {
      return [header, truncateToWidth(`  error: ${view.error}`, width, "…")];
    }
    const body = this.renderNumbered(view.lines, view.title, width);
    if (view.truncated) body.push(truncateToWidth("  … truncated", width, "…"));
    return [header, ...body];
  }

  /**
   * Render content with a line-number gutter, then colour it.
   *
   * The gutter is composed from plain text and the CONTENT is truncated to the
   * remaining width before any colour is applied. Truncating afterwards would
   * cut escape sequences in half and stain the rest of the frame with whatever
   * colour happened to be open.
   */
  private renderNumbered(lines: string[], title: string, width: number): string[] {
    const isDiff = looksLikeDiff(lines);
    const rows = isDiff ? numberDiffLines(lines) : numberFileLines(lines);
    const gutter = gutterWidth(rows);
    const textWidth = Math.max(0, width - gutter);
    const filename = title.split(/[\s/]/).pop() ?? title;

    return rows.map((row) => {
      const text = truncateToWidth(row.text, textWidth, "…");
      const painted = this.theme ? this.paint(text, row.kind, filename) : text;
      if (gutter === 0) return painted;
      return `${this.safeFg("dim", formatGutter(row, gutter))}${painted}`;
    });
  }

  /** Colour one already-truncated line according to its diff role. */
  private paint(text: string, kind: GutterKind, filename: string): string {
    const theme = this.theme;
    if (!theme) return text;
    try {
      if (kind === "added") return theme.fg("toolDiffAdded", text);
      if (kind === "removed") return theme.fg("toolDiffRemoved", text);
      if (kind === "meta") return theme.fg("muted", text);
      return highlightLine(text, { theme, filename });
    } catch {
      return text;
    }
  }

  // ─── Navigation ───────────────────────────────────────────────────────────

  private refreshRows(): void {
    this.currentRows = buildRows(this.state.snapshot, this.expanded, this.activeTab);
    this.selection = clampSelection(this.currentRows, this.selection);
  }

  private changeTab(direction: -1 | 1): void {
    this.activeTab = stepTab(this.activeTab, direction);
    // A tab is a different row list, so the cursor starts at its top rather
    // than landing on whatever index happened to be selected before.
    this.selection = 0;
    this.refreshRows();
    this.publishLayout();
    this.requestRenderFn();
  }

  private changeWidth(direction: -1 | 1): void {
    const next = stepWidth(this.width, direction);
    if (next === this.width) return;
    this.width = next;
    this.publishLayout();
    this.requestRenderFn();
  }

  // ─── Copy ─────────────────────────────────────────────────────────────────

  /**
   * Copy the selected row's VALUE, not its drawing: no cursor, no indent, no
   * glyph. Pasting a row should paste the path, not the picture of it.
   */
  private copyRow(): void {
    this.refreshRows();
    const row = this.currentRows[this.selection];
    if (!row) return;
    this.notice = this.copyFn(row.label).message;
    this.requestRenderFn();
  }

  /** Copy the visible body, one row per line, same rule. */
  private copyBody(): void {
    this.refreshRows();
    const text = this.currentRows.map((row) => row.label).join("\n");
    this.notice = this.copyFn(text).message;
    this.requestRenderFn();
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  private openSearch(): void {
    this.refreshRows();
    this.search = { query: "", matches: [], index: -1, restoreSelection: this.selection };
    this.requestRenderFn();
  }

  private handleSearchInput(data: string): void {
    const search = this.search;
    if (!search) return;

    if (data === KEY_ESCAPE) {
      // Cancelling restores the cursor: a search the operator abandoned must
      // not have moved them.
      this.selection = clampSelection(this.currentRows, search.restoreSelection);
      this.search = null;
      this.requestRenderFn();
      return;
    }
    if (data === KEY_ENTER) {
      this.commitSearch();
      return;
    }
    if (data === KEY_BACKSPACE) {
      search.query = search.query.slice(0, -1);
      this.recomputeMatches();
      return;
    }
    // Printable text only: control sequences are not query characters.
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      search.query += data;
      this.recomputeMatches();
    }
  }

  private recomputeMatches(): void {
    const search = this.search;
    if (!search) return;
    search.matches = findMatches(this.currentRows, search.query);
    search.index = search.matches.length > 0 ? 0 : -1;
    this.requestRenderFn();
  }

  /** Close the prompt, keeping the matches so `n`/`N` can walk them. */
  private commitSearch(): void {
    const search = this.search;
    if (!search) return;
    const target = search.matches[0];
    if (target !== undefined) {
      this.selection = clampSelection(this.currentRows, target);
      this.lastSearch = { matches: search.matches, index: 0 };
    }
    this.search = null;
    this.requestRenderFn();
  }

  private jumpMatch(direction: -1 | 1): void {
    const last = this.lastSearch;
    if (!last || last.matches.length === 0) return;
    const next = stepMatch(last.matches, last.index, direction);
    if (next < 0) return;
    last.index = next;
    const row = last.matches[next];
    if (row === undefined) return;
    this.selection = clampSelection(this.currentRows, row);
    this.requestRenderFn();
  }

  private publishLayout(): void {
    // A patch, not a layout: open/closed belongs to the controller.
    this.onLayoutChange?.({ widthPercent: this.width, tab: this.activeTab, expanded: this.expandedIds });
  }

  private move(delta: number): void {
    this.refreshRows();
    if (this.selection < 0) return;
    const next = clampSelection(this.currentRows, this.selection + delta);
    if (next === this.selection) return;
    this.selection = next;
    this.requestRenderFn();
  }

  private activate(): void {
    const row = this.currentRows[this.selection];
    if (!row) return;
    if (row.payload.kind === "section") {
      this.expanded.add(row.payload.id);
      this.refreshRows();
      this.publishLayout();
      this.requestRenderFn();
      return;
    }
    this.openRow?.(row.payload);
  }

  private collapse(): void {
    const row = this.currentRows[this.selection];
    if (!row) return;
    if (row.payload.kind === "section") {
      this.expanded.delete(row.payload.id);
      this.refreshRows();
      this.publishLayout();
      this.requestRenderFn();
    }
  }
}
