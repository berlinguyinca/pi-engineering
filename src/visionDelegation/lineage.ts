import type { HandoffLineageInput, LineageEmitter, LineageState } from "../runtime/herdr/lineage.ts";
import type { LineageEvent } from "./types.ts";

/**
 * Translate a vision-delegation event into a herdr lineage handoff. The id,
 * cause and kind strings are a fixed contract with the herdr dashboard.
 * States reuse the handoff vocabulary of missionStore.lineageHandoff:
 * out -> acknowledged (the vision agent took over; the emitter upserts both
 * sessions and the handoff edge), back ok/partial -> committed, back
 * failed/timeout -> failed.
 */
function toHandoff(e: LineageEvent): HandoffLineageInput {
  const kind = e.phase === "out" || e.outcome === "ok" ? "vision" : `vision_${e.outcome}`;
  const base = {
    id: `vision-${e.requestId}-${e.phase}`,
    kind,
    missionId: null,
    checkpointSha: null,
    fromModel: e.fromModel,
    toModel: e.toModel,
  };
  if (e.phase === "out") {
    return {
      ...base,
      fromSession: e.fromSession,
      toSession: e.toSession,
      state: "acknowledged",
      cause: "vision_delegate",
    };
  }
  const ok = e.outcome === "ok" || e.outcome === "partial";
  if (e.toSession === null) {
    // The vision pane never started: nothing to return from.
    return { ...base, fromSession: e.fromSession, toSession: null, state: "failed", cause: "vision_return" };
  }
  const state: LineageState = ok ? "committed" : "failed";
  return { ...base, fromSession: e.toSession, toSession: e.fromSession, state, cause: "vision_return" };
}

/** Never throws; a null emitter is a no-op. */
export function emitVisionLineage(emitter: LineageEmitter | null, e: LineageEvent): void {
  if (!emitter) return;
  try {
    emitter.handoff(toHandoff(e));
  } catch {
    // Lineage is observability only and must never break a delegation.
  }
}

export function makeVisionLineageHook(emitter: LineageEmitter | null): (e: LineageEvent) => void {
  return (e) => emitVisionLineage(emitter, e);
}
