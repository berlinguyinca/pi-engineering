/**
 * Operator-facing text for `/engineering reload|update|rollback|version` and
 * the panel's Runtime/Update section (spec §13, §20, §34, §35, §38, §44, §62).
 */

import type { ActiveRuntimeOperation } from "./contract.ts";
import type { HandoverResult } from "./host.ts";
import type { OperationRegistry } from "./operations.ts";

export function waitingText(blocking: ActiveRuntimeOperation[], ops: OperationRegistry, what: string): string {
  return [
    `${what}`,
    "Waiting for a safe runtime handover point…",
    "",
    ...ops.summarize(blocking),
    "",
    "Use /engineering cancel to abandon it; the current runtime keeps running.",
  ].join("\n");
}

export function formatHandover(result: HandoverResult, label: { from?: string; to?: string; action: string }): string {
  if (result.ok) {
    return [
      "Pi Engineering",
      "",
      ...(result.waitedForSafePoint ? ["✓ safe point reached"] : []),
      `✓ runtime handover (generation ${result.fromGeneration ?? "-"} → ${result.activeGeneration})`,
      ...(result.snapshot && result.snapshot.activeMissionIds.length + result.snapshot.pendingMissionIds.length > 0
        ? [
            `✓ mission state restored (${[...result.snapshot.activeMissionIds, ...result.snapshot.pendingMissionIds].join(", ")})`,
          ]
        : []),
      "✓ health check passed",
      "",
      label.from && label.to && label.from !== label.to
        ? `${label.action} ${label.from} → ${label.to}.`
        : `${[label.action, label.to].filter(Boolean).join(" ")}.`,
      "",
      "Pi restart not required.",
    ].join("\n");
  }
  if (result.phase === "cancelled") {
    return `Pi Engineering ${label.action.toLowerCase()} cancelled (${result.failure}). Current runtime untouched (generation ${result.activeGeneration ?? "-"}).`;
  }
  if (result.untouched) {
    return [
      `Pi Engineering ${label.to ?? ""} was not activated: ${result.failure}`.replace("  ", " "),
      "",
      `Current runtime untouched (generation ${result.activeGeneration ?? "none"}).`,
    ].join("\n");
  }
  if (result.rolledBack) {
    return [
      `Pi Engineering ${label.to ?? "candidate"} failed during ${result.failedStage}: ${result.failure}`,
      "",
      "✓ previous state restored",
      `✓ rolled back to ${label.from ?? "previous runtime"} (generation ${result.activeGeneration})`,
      "",
      "Current Pi session remains operational.",
    ].join("\n");
  }
  return [
    `Pi Engineering ${label.to ?? "candidate"} failed during ${result.failedStage}: ${result.failure}`,
    "Rollback did not complete; no engineering runtime is active.",
    "Pi itself is unaffected. Run /engineering rollback or /engineering reload to recover.",
  ].join("\n");
}

export function ago(fromMs: number | undefined, nowMs = Date.now()): string {
  if (fromMs === undefined) return "never";
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function short(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 7) : "-";
}
