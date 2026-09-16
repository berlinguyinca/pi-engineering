/**
 * Persisted panel layout — width, active tab, and which sections are expanded.
 *
 * Two rules, both about where this lives:
 *
 *   1. It goes in the **agent profile**, not the repository. A panel width is a
 *      property of the operator, not of the code, and it must never land in a
 *      project's git history. Same location and the same atomic, owner-only
 *      write as the memory connection settings (src/blackhole/connectionSetup.ts).
 *   2. Nothing here ever throws. A layout is a preference: a missing, corrupt,
 *      or unwritable file degrades to defaults rather than costing the operator
 *      their panel.
 *
 * The file holds no repository content — section ids and a tab name, never a
 * path — and no credentials.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PanelTabId = "files" | "reviews" | "tokens" | "session" | "memory";

export const PANEL_TABS: readonly PanelTabId[] = ["files", "reviews", "tokens", "session", "memory"];

export interface PanelLayout {
  /** Overlay width as a percentage of terminal columns. */
  widthPercent: number;
  tab: PanelTabId;
  /** Section ids left expanded, sorted so the file is stable across saves. */
  expanded: string[];
  /**
   * Whether the panel was showing when the last session ended.
   *
   * Remembered so a deliberate close survives a restart. It does NOT cause the
   * panel to open on its own: `ctx.ui.custom()` takes keyboard focus, so a
   * panel shown before the operator asked for it leaves pi accepting no input.
   * See the auto-open note in extensions/index.ts.
   */
  open: boolean;
}

/**
 * The layout fields the COMPONENT owns.
 *
 * Open/closed is deliberately not among them: the component draws the panel, it
 * does not decide whether the panel exists. Letting it publish `open` would mean
 * a width nudge rewriting a deliberate close back to open, which is how a
 * remembered preference quietly stops being remembered.
 */
export type PanelLayoutPatch = Omit<PanelLayout, "open">;

export const MIN_WIDTH_PERCENT = 20;
export const MAX_WIDTH_PERCENT = 80;
export const WIDTH_STEP_PERCENT = 5;

/**
 * Sections start open: the panel is most useful showing everything at once the
 * first time it is opened.
 *
 * This lives in the DEFAULT rather than in the component, because `load()`
 * always returns a layout — defaults when there is no file — so a component-side
 * "no layout means open everything" branch is unreachable in the real wiring and
 * a first-ever open would render every section collapsed.
 */
export const DEFAULT_LAYOUT: PanelLayout = {
  widthPercent: 35,
  tab: "files",
  expanded: ["files", "findings", "run", "spend", "workspace"],
  open: true,
};

export interface LayoutStoreOptions {
  /** Agent profile root, not the directory of the current repository. */
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Clamp a width change into the allowed band. Pure. */
export function stepWidth(current: number, direction: -1 | 1): number {
  const next = current + direction * WIDTH_STEP_PERCENT;
  return Math.min(MAX_WIDTH_PERCENT, Math.max(MIN_WIDTH_PERCENT, next));
}

/** Cycle tabs with wrap-around in both directions. Pure. */
export function stepTab(current: PanelTabId, direction: -1 | 1): PanelTabId {
  const at = PANEL_TABS.indexOf(current);
  const from = at < 0 ? 0 : at;
  const next = (from + direction + PANEL_TABS.length) % PANEL_TABS.length;
  return PANEL_TABS[next] ?? DEFAULT_LAYOUT.tab;
}

function clampWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LAYOUT.widthPercent;
  return Math.min(MAX_WIDTH_PERCENT, Math.max(MIN_WIDTH_PERCENT, Math.round(value)));
}

function validTab(value: unknown): PanelTabId {
  return PANEL_TABS.includes(value as PanelTabId) ? (value as PanelTabId) : DEFAULT_LAYOUT.tab;
}

function validExpanded(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").sort();
}

export class PanelLayoutStore {
  private readonly path: string;

  constructor(opts: LayoutStoreOptions = {}) {
    const env = opts.env ?? process.env;
    const root = opts.profileDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    this.path = join(root, "engineering-panel", "layout.json");
  }

  /**
   * Read the persisted layout. Every field is validated independently, so one
   * bad value costs that field's preference rather than the whole file.
   */
  load(): PanelLayout {
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!data || typeof data !== "object") return { ...DEFAULT_LAYOUT };
      const record = data as Record<string, unknown>;
      return {
        widthPercent: clampWidth(record.widthPercent),
        tab: validTab(record.tab),
        expanded: validExpanded(record.expanded),
        // Absent means a layout written before this field existed. Those
        // operators had a panel they opened deliberately, so defaulting to
        // DEFAULT_LAYOUT.open (true) is what they would expect on upgrade.
        open: typeof record.open === "boolean" ? record.open : DEFAULT_LAYOUT.open,
      };
    } catch {
      // Missing, unreadable, or malformed: defaults, never an error.
      return { ...DEFAULT_LAYOUT };
    }
  }

  /** Persist the layout. A profile we cannot write to silently drops the preference. */
  save(layout: PanelLayout): void {
    const body = JSON.stringify(
      {
        widthPercent: clampWidth(layout.widthPercent),
        tab: validTab(layout.tab),
        expanded: validExpanded(layout.expanded),
        open: layout.open !== false,
      },
      null,
      2,
    );
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      atomicWrite(this.path, body);
    } catch {
      // A preference is never worth failing the panel for.
    }
  }
}

/** Write-temp-then-rename, owner-only, as the memory connection profile does it. */
function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}
