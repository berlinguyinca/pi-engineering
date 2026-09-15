/**
 * Tree shaping — the load-bearing seam of the panel.
 *
 * `buildRows` is a pure function from panel state to a flat list of renderable
 * rows. All the shaping decisions live here (grouping, expansion, counts,
 * labels), so the component that paints them needs to know nothing but how to
 * draw a line and move a cursor — and everything worth testing is testable
 * without a terminal.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PanelFileEntry, PanelFinding, PanelSpend, PanelStateShape } from "./PanelState.ts";
import { PANEL_TABS, type PanelTabId } from "./layout.ts";

export type RowPayload =
  | { kind: "section"; id: string }
  | { kind: "file"; path: string; source: "run" | "workspace" }
  | { kind: "finding"; id: string }
  | { kind: "spend"; model: string }
  | { kind: "error" }
  | { kind: "empty" };

export interface PanelRow {
  depth: number;
  glyph: string;
  label: string;
  payload: RowPayload;
  /** Whether the cursor may rest here. */
  selectable: boolean;
}

/** Collapsible section ids, in render order. */
export const SECTION_IDS = ["files", "findings", "spend", "workspace"] as const;

/** Human labels for the tab bar, in `PANEL_TABS` order. */
const TAB_LABELS: Record<PanelTabId, string> = {
  files: "Files",
  reviews: "Reviews",
  tokens: "Tokens",
  session: "Session",
  memory: "Memory",
};

/**
 * The tab bar, as one line. Truncated like every other row: the panel never
 * wraps, so a narrow panel shows the tabs that fit and nothing more.
 */
export function renderTabBar(active: PanelTabId, width: number): string {
  const line = PANEL_TABS.map((tab) => (tab === active ? `[${TAB_LABELS[tab]}]` : ` ${TAB_LABELS[tab]} `)).join("");
  return truncateToWidth(line, Math.max(0, width), "…");
}

const OPEN = "▾";
const SHUT = "▸";

/** One-letter marker per change kind, so a glance says what happened. */
const CHANGE_GLYPH: Record<PanelFileEntry["change"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

function section(id: string, label: string, count: number, expanded: ReadonlySet<string>): PanelRow {
  return {
    depth: 0,
    glyph: expanded.has(id) ? OPEN : SHUT,
    label: `${label} (${count})`,
    payload: { kind: "section", id },
    selectable: true,
  };
}

function fileRow(file: PanelFileEntry, source: "run" | "workspace"): PanelRow {
  return {
    depth: 1,
    glyph: CHANGE_GLYPH[file.change],
    label: file.path,
    payload: { kind: "file", path: file.path, source },
    selectable: true,
  };
}

/**
 * "high · reviewer · opus-5 · retry loop can spin".
 *
 * Attribution is omitted rather than faked: a finding whose recording event
 * named no role or model simply renders without them.
 */
function findingRow(finding: PanelFinding): PanelRow {
  const parts = [finding.severity.toUpperCase()];
  if (finding.role) parts.push(finding.role);
  if (finding.model) parts.push(finding.model);
  parts.push(finding.claim);
  return {
    depth: 1,
    glyph: finding.status === "resolved" ? "✓" : "✗",
    label: parts.join(" · "),
    payload: { kind: "finding", id: finding.id },
    selectable: true,
  };
}

function spendRow(spend: PanelSpend): PanelRow {
  const cost = spend.cost > 0 ? ` · $${spend.cost.toFixed(2)}` : "";
  return {
    depth: 1,
    glyph: "·",
    label: `${spend.model} · ${spend.input}/${spend.output} tok${cost}`,
    payload: { kind: "spend", model: spend.model },
    selectable: true,
  };
}

/**
 * Build the rows for a state snapshot, for one tab.
 *
 * Sections render whether or not they have children, so a run with no findings
 * yet reads as "reviewed nothing so far" rather than looking broken.
 *
 * The tab argument is not optional in spirit: each tab is a different view of
 * the same state, and a caller that wants findings has to ask for the Reviews
 * tab. It defaults to Files only so a caller with no tab concept still renders
 * something sensible.
 */
export function buildRows(
  state: Readonly<PanelStateShape>,
  expanded: ReadonlySet<string>,
  tab: PanelTabId = "files",
  nowMs: number = Date.now(),
): PanelRow[] {
  const rows: PanelRow[] = [];
  const run = state.run;

  // The run header orients every tab that describes a run.
  if (run && tab !== "session" && tab !== "memory") {
    rows.push({
      depth: 0,
      glyph: "●",
      label: `${run.workItemId} · ${run.phase} · ${run.risk}${run.goal ? ` · ${run.goal}` : ""}`,
      payload: { kind: "section", id: "run" },
      selectable: true,
    });
  }

  if (tab === "files") {
    if (run) {
      rows.push(section("files", "Changed files", run.files.length, expanded));
      if (expanded.has("files")) for (const file of run.files) rows.push(fileRow(file, "run"));
    }
    const workspace = state.workspace;
    if (workspace) {
      const label = workspace.branch ? `Working tree · ${workspace.branch}` : "Working tree";
      rows.push(section("workspace", label, workspace.files.length, expanded));
      if (expanded.has("workspace")) for (const file of workspace.files) rows.push(fileRow(file, "workspace"));
    }
  }

  if (tab === "reviews" && run) {
    rows.push(section("findings", "Reviews", run.findings.length, expanded));
    if (expanded.has("findings")) for (const finding of run.findings) rows.push(findingRow(finding));
  }

  if (tab === "tokens") {
    if (run) {
      rows.push(section("spend", "Tokens", run.spend.length, expanded));
      if (expanded.has("spend")) for (const spend of run.spend) rows.push(spendRow(spend));
    }
    const workspace = state.workspace;
    if (workspace?.contextTokens != null) {
      const percent = workspace.contextPercent != null ? ` (${workspace.contextPercent}%)` : "";
      rows.push({
        depth: 0,
        glyph: "·",
        label: `context ${workspace.contextTokens} tok${percent}`,
        payload: { kind: "spend", model: "context" },
        selectable: false,
      });
    }
  }

  if (tab === "session") rows.push(...sessionRows(state, nowMs));
  if (tab === "memory") rows.push(...memoryRows(state));

  // Errors render alongside everything else: a broken feeder marks its own
  // section without taking the rest of the panel down with it.
  for (const error of state.errors) {
    rows.push({
      depth: 0,
      glyph: "!",
      label: `${error.section}: ${error.message}`,
      payload: { kind: "error" },
      selectable: false,
    });
  }

  if (rows.length === 0) {
    rows.push({
      depth: 0,
      glyph: "",
      label: emptyLabel(tab),
      payload: { kind: "empty" },
      selectable: false,
    });
  }

  return rows;
}

function emptyLabel(tab: PanelTabId): string {
  switch (tab) {
    case "reviews":
      return "No reviews yet — findings appear here once a reviewer runs.";
    case "tokens":
      return "No spend recorded yet.";
    default:
      return "Nothing to show yet — run /engineer, or edit a file.";
  }
}

/**
 * The Session tab: the generated narrative.
 *
 * Labeled as generated on its own line, and stamped with when it was last
 * actually updated — a narrative whose last update failed stays put, and must
 * say so rather than implying it is current.
 */
function sessionRows(state: Readonly<PanelStateShape>, nowMs: number): PanelRow[] {
  const narrative = state.narrative;
  if (!narrative) {
    return [
      {
        depth: 0,
        glyph: "",
        label: "No session narrative yet.",
        payload: { kind: "empty" },
        selectable: false,
      },
    ];
  }
  return [
    { depth: 0, glyph: "", label: narrative.text, payload: { kind: "empty" }, selectable: false },
    {
      depth: 0,
      glyph: "",
      label: `— model-generated · updated ${formatAge(nowMs - narrative.updatedAt)}`,
      payload: { kind: "empty" },
      selectable: false,
    },
  ];
}

/** "just now" / "4m ago" / "2h ago". Never a fake precision. */
function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The Memory tab: what this session put into memory.
 *
 * A disabled adapter says so and shows NO counters. Blackhole is off by
 * default, and a column of zeros reads as a broken feature rather than as one
 * that is not running.
 */
function memoryRows(state: Readonly<PanelStateShape>): PanelRow[] {
  const memory = state.memory;
  if (!memory) {
    return [
      { depth: 0, glyph: "", label: "Memory counts unavailable.", payload: { kind: "empty" }, selectable: false },
    ];
  }
  if (!memory.enabled) {
    return [
      {
        depth: 0,
        glyph: "",
        label: "Blackhole session memory is off for this runtime.",
        payload: { kind: "empty" },
        selectable: false,
      },
    ];
  }
  const line = (label: string): PanelRow => ({
    depth: 0,
    glyph: "·",
    label,
    payload: { kind: "empty" },
    selectable: false,
  });
  const workers = memory.workers;
  return [
    line(`entries recorded ${memory.entries}`),
    line(`promotion candidates ${memory.promotionCandidates}`),
    line(`promoted to durable memory ${memory.promoted}`),
    line(`compactions ${memory.compactions}`),
    line(`memory workers: observer ${workers.observer} · reflector ${workers.reflector} · dropper ${workers.dropper}`),
  ];
}

/**
 * Clamp a desired selection onto the nearest selectable row.
 *
 * Returns -1 when nothing is selectable (an empty or error-only panel), so the
 * caller renders without a cursor rather than highlighting a header it cannot
 * act on.
 */
export function clampSelection(rows: readonly PanelRow[], desired: number): number {
  if (rows.length === 0) return -1;
  const start = Math.min(Math.max(desired, 0), rows.length - 1);
  for (let i = start; i < rows.length; i++) {
    if (rows[i]?.selectable) return i;
  }
  for (let i = start - 1; i >= 0; i--) {
    if (rows[i]?.selectable) return i;
  }
  return -1;
}
