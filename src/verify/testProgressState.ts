import type { WatchdogLevel } from "./testWatchdog.ts";

/**
 * Live test progress state (autospec R-WATCH).
 *
 * Given the current watchdog level, whether the stage depends on a quarantined
 * test, and whether the stage has finished, this pure module folds those into a
 * single live-state label plus a human-readable reason. It is deliberately
 * side-effect free: no I/O, no clock, no mutation of its inputs.
 */

export type LiveTestState = "running" | "quiet" | "stalled" | "blocked";

export interface LiveTestStateInput {
  level: WatchdogLevel;
  quarantinedHit: boolean;
  finished: boolean;
}

export interface LiveTestStateResult {
  state: LiveTestState | "done";
  reason: string;
}

/** First-match-wins classification of a live test stage's progress state. */
export function toLiveTestState(input: LiveTestStateInput): LiveTestStateResult {
  if (input.quarantinedHit) {
    return { state: "blocked", reason: "depends on a quarantined test" };
  }
  if (input.finished) {
    return { state: "done", reason: "stage finished" };
  }
  switch (input.level) {
    case "stalled":
      return { state: "stalled", reason: "no progress past stall threshold" };
    case "investigate":
      return { state: "quiet", reason: "investigating prolonged silence" };
    case "quiet":
      return { state: "quiet", reason: "no recent progress" };
    default:
      return { state: "running", reason: "progress observed" };
  }
}

/** Format a live progress state as a one-line status, with silence in whole seconds. */
export function formatProgressLine(stage: string, r: LiveTestStateResult, silentMs: number): string {
  const finite = Number.isFinite(silentMs) ? silentMs : 0;
  const seconds = Math.floor(Math.max(0, finite) / 1000);
  return `[${stage}] ${r.state}: ${r.reason} (silent ${seconds}s)`;
}
