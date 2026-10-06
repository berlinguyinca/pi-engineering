/**
 * Interrupting a mission is not cancelling it.
 *
 * The operator pressing Esc on a running mission tool call aborts the call's
 * signal. With `interrupt: "pause"` the orchestrator turns that abort into a
 * durable pause: in-flight work stops at once, interrupted tasks stay
 * resumable, and the mission waits for `/mission resume <id>` (or the mission
 * tool's resume action). Only an explicit cancel (`Orchestrator.cancel`, the
 * `/mission cancel <id>` command, the tool's cancel action) terminates a
 * healthy mission.
 *
 * The decision travels as the abort reason, so every layer that already
 * honours the signal (scheduler, broker, workers) needs only to ask which kind
 * of abort it is.
 */

/** Abort reason: the operator interrupted; pause durably, keep the work. */
export const MISSION_PAUSE_REASON = Object.freeze({ kind: "pi-engineering.mission-pause" as const });
/** Abort reason: the operator explicitly cancelled the mission. */
export const MISSION_CANCEL_REASON = Object.freeze({ kind: "pi-engineering.mission-cancel" as const });

/** Durable stop reason recorded for an operator pause (resumable, never auto-resumed). */
export const OPERATOR_PAUSE_STOP_REASON = "paused by the operator (interrupt); progress is preserved";

/** True when `signal` was aborted to PAUSE the mission rather than cancel it. */
export function isPauseAbort(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted && signal.reason === MISSION_PAUSE_REASON;
}

/** How a caller's abort is treated: cancel (the API default) or a durable pause. */
export type InterruptMode = "cancel" | "pause";

/**
 * A run-scoped controller: aborted by the caller (translated to a pause when
 * `mode` is "pause") or by an explicit cancel.
 */
export function interruptibleRun(
  caller: AbortSignal | undefined,
  mode: InterruptMode = "cancel",
): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const forward = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(mode === "pause" ? MISSION_PAUSE_REASON : caller?.reason);
  };
  if (caller?.aborted) forward();
  else caller?.addEventListener("abort", forward, { once: true });
  return {
    controller,
    signal: controller.signal,
    dispose: () => caller?.removeEventListener("abort", forward),
  };
}
