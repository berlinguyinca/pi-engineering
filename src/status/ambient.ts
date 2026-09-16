/**
 * A one-line, always-visible summary of what the run is doing.
 *
 * The panel cannot do this job. `ctx.ui.custom()` is documented as "Show a
 * custom component with keyboard focus" and pi offers no non-focusing variant,
 * so a panel that is always on screen is a session that accepts no typing —
 * which is exactly what shipped once and had to be reverted.
 *
 * `setFooter` carries no such contract: a footer component renders and never
 * takes focus. So persistent awareness lives here instead, and pays for it by
 * being a line rather than a pane — counts and the worst finding, not a tree
 * you can open.
 *
 * Pure. Renders from state the feeders already computed, so this runs on the
 * draw path without touching git or the network.
 */

import type { PanelStateShape } from "../panel/PanelState.ts";

/** Severities worth interrupting for, worst first. */
const LOUD = ["critical", "high", "medium"] as const;

function compactTokens(total: number): string {
  if (total < 1_000) return `${total} tok`;
  if (total < 1_000_000) return `${Math.round(total / 100) / 10}k tok`;
  return `${Math.round(total / 100_000) / 10}M tok`;
}

/**
 * Build the ambient line, or undefined when there is nothing worth a row.
 *
 * Returning undefined rather than an empty string matters: a footer row that is
 * always present but usually blank costs a line of terminal for nothing, and
 * the operator stops reading the area entirely.
 */
export function renderAmbient(state: Readonly<PanelStateShape>): string | undefined {
  const parts: string[] = [];

  const run = state.run;
  const files = run?.files.length ?? state.workspace?.files.length ?? 0;
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);

  const findings = run?.findings ?? [];
  if (findings.length > 0) {
    // Name the worst severity present, because "3 findings" reads the same
    // whether they are all informational or one of them is critical.
    const worst = LOUD.find((severity) => findings.some((f) => f.severity === severity));
    parts.push(worst ? `${findings.length} findings (${worst})` : `${findings.length} findings`);
  }

  const spend = run?.spend ?? [];
  if (spend.length > 0) {
    const total = spend.reduce((sum, s) => sum + s.input + s.output, 0);
    if (total > 0) parts.push(compactTokens(total));
  }

  // A failing feeder is worth a word: a summary that silently omits a section
  // it could not read is indistinguishable from one where nothing happened.
  if (state.errors.length > 0) parts.push(`${state.errors.length} source(s) unavailable`);

  if (parts.length === 0) return undefined;

  const phase = run?.phase;
  const head = phase ? `${phase} · ` : "";
  return `${head}${parts.join(" · ")}`;
}
