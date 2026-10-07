/**
 * The panel's Runtime/Update section (spec §44): what the RuntimeHost
 * publishes, shown on the Session tab. No Host publishing, no rows.
 */

import { runtimeStatusLines } from "../runtime/host/runtimeStatus.ts";
import type { PanelRow } from "./tree.ts";

const HEADINGS = new Set(["Runtime", "Update", "Previous", "Last reload", "Active:"]);

export function runtimeRows(nowMs: number): PanelRow[] {
  const lines = runtimeStatusLines(nowMs);
  return lines.map((label) => {
    const heading = HEADINGS.has(label) || /^(Updating|Reloading|Rolling back) /.test(label);
    return {
      depth: heading ? 0 : 1,
      glyph: heading ? "●" : "·",
      label,
      payload: heading ? { kind: "section", id: "runtime" } : { kind: "empty" },
      selectable: false,
      ...(heading ? {} : label.startsWith("◌") ? { tone: "note" as const } : {}),
    };
  });
}
