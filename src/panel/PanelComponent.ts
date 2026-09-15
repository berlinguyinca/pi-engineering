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
import type { ContentView } from "./content.ts";
import { DEFAULT_LAYOUT, type PanelLayout, type PanelTabId, stepTab, stepWidth } from "./layout.ts";
import { type PanelRow, type RowPayload, buildRows, clampSelection, renderTabBar } from "./tree.ts";

/** Sections start open: the panel is most useful showing everything at once. */
const INITIALLY_EXPANDED = ["run", "files", "findings", "spend", "workspace"];

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KEY_ESCAPE = "\x1b";
const KEY_TAB = "\t";
const KEY_SHIFT_TAB = "\x1b[Z";

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
  onLayoutChange?: (layout: PanelLayout) => void;
}

export class PanelComponent {
  private readonly state: PanelState;
  private readonly requestRenderFn: () => void;
  private readonly openRow: ((payload: RowPayload) => void) | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly onLayoutChange: ((layout: PanelLayout) => void) | undefined;
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
  private disposed = false;

  constructor(opts: PanelComponentOptions) {
    this.state = opts.state;
    this.requestRenderFn = opts.requestRender;
    this.openRow = opts.openRow;
    this.onClose = opts.onClose;
    this.onLayoutChange = opts.onLayoutChange;
    const layout = opts.layout;
    // With no persisted layout, sections start open: the panel is most useful
    // showing everything at once the first time it is opened.
    this.expanded = new Set<string>(layout ? layout.expanded : INITIALLY_EXPANDED);
    this.activeTab = layout?.tab ?? DEFAULT_LAYOUT.tab;
    this.width = layout?.widthPercent ?? DEFAULT_LAYOUT.widthPercent;
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
      const lines = this.content ? this.renderContent(max) : this.renderTree(max);
      // Belt and braces: the TUI contract is per-line, and a styling mistake
      // here would corrupt the whole frame.
      return lines.map((line) => (visibleWidth(line) > max ? truncateToWidth(line, max, "…") : line));
    } catch {
      // Never throw into Pi's render loop.
      return [];
    }
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
      case KEY_ESCAPE:
        this.onClose?.();
        return;
      default:
        // Unknown input is ignored rather than guessed at.
        return;
    }
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
    const body = this.currentRows.map((row, index) => {
      const cursor = index === this.selection ? "›" : " ";
      const indent = "  ".repeat(row.depth);
      const glyph = row.glyph ? `${row.glyph} ` : "";
      return truncateToWidth(`${cursor}${indent}${glyph}${row.label}`, width, "…");
    });
    return [renderTabBar(this.activeTab, width), ...body];
  }

  private renderContent(width: number): string[] {
    const view = this.content;
    if (!view) return [];
    const header = truncateToWidth(`◂ ${view.title}`, width, "…");
    if (view.error) {
      return [header, truncateToWidth(`  error: ${view.error}`, width, "…")];
    }
    const body = view.lines.map((line) => truncateToWidth(line, width, "…"));
    if (view.truncated) body.push(truncateToWidth("  … truncated", width, "…"));
    return [header, ...body];
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

  private publishLayout(): void {
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
