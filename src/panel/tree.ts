/**
 * Tree shaping — the load-bearing seam of the panel.
 *
 * `buildRows` is a pure function from panel state to a flat list of renderable
 * rows. All the shaping decisions live here (grouping, expansion, counts,
 * labels), so the component that paints them needs to know nothing but how to
 * draw a line and move a cursor — and everything worth testing is testable
 * without a terminal.
 */

import type { PanelFileEntry, PanelFinding, PanelSpend, PanelStateShape } from "./PanelState.ts";

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
 * Build the rows for a state snapshot.
 *
 * Sections render whether or not they have children, so a run with no findings
 * yet reads as "reviewed nothing so far" rather than looking broken.
 */
export function buildRows(state: Readonly<PanelStateShape>, expanded: ReadonlySet<string>): PanelRow[] {
  const rows: PanelRow[] = [];

  const run = state.run;
  if (run) {
    rows.push({
      depth: 0,
      glyph: "●",
      label: `${run.workItemId} · ${run.phase} · ${run.risk}${run.goal ? ` · ${run.goal}` : ""}`,
      payload: { kind: "section", id: "run" },
      selectable: true,
    });

    rows.push(section("files", "Changed files", run.files.length, expanded));
    if (expanded.has("files")) for (const file of run.files) rows.push(fileRow(file, "run"));

    rows.push(section("findings", "Reviews", run.findings.length, expanded));
    if (expanded.has("findings")) for (const finding of run.findings) rows.push(findingRow(finding));

    rows.push(section("spend", "Tokens", run.spend.length, expanded));
    if (expanded.has("spend")) for (const spend of run.spend) rows.push(spendRow(spend));
  }

  const workspace = state.workspace;
  if (workspace) {
    const label = workspace.branch ? `Working tree · ${workspace.branch}` : "Working tree";
    rows.push(section("workspace", label, workspace.files.length, expanded));
    if (expanded.has("workspace")) {
      for (const file of workspace.files) rows.push(fileRow(file, "workspace"));
      if (workspace.contextTokens != null) {
        const percent = workspace.contextPercent != null ? ` (${workspace.contextPercent}%)` : "";
        rows.push({
          depth: 1,
          glyph: "·",
          label: `context ${workspace.contextTokens} tok${percent}`,
          payload: { kind: "spend", model: "context" },
          selectable: false,
        });
      }
    }
  }

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
      label: "Nothing to show yet — run /engineer, or edit a file.",
      payload: { kind: "empty" },
      selectable: false,
    });
  }

  return rows;
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
