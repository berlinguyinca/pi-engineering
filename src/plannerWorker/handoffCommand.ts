/**
 * Manual `/handoff` driver (spec Unit B2).
 *
 * A handoff is the ONLY thing that crosses a role boundary. This module drives
 * a handoff to a terminal state: it builds a bounded `HandoffArtifact`
 * (summary ≤ 1500, diff ≤ 24k) via `buildHandoff`, then walks the fixed handoff
 * state machine (`prepared → validated → acknowledged → committed`) on success.
 * If the artifact cannot be built, the handoff transitions to `aborted`. Pure —
 * no I/O; the command handler persists and prints the result.
 */

import { type HandoffState, nextStates } from "../runtime/host/handoffKinds.ts";
import { type HandoffInput, buildHandoff, renderHandoff } from "./handoff.ts";
import type { HandoffArtifact } from "./types.ts";

/** The terminal result of driving a manual handoff. */
export interface HandoffCommandResult {
  state: HandoffState;
  artifact?: HandoffArtifact;
  rendered?: string;
  error?: string;
}

/**
 * Drive a manual handoff from `prepared` to `committed` (or `aborted` on
 * failure). Builds a bounded `HandoffArtifact` via `buildHandoff`, then walks
 * the fixed state machine (`nextStates`) to `committed`. If building the
 * artifact throws (malformed input), the handoff is `aborted` and the error is
 * returned. Pure: no I/O.
 */
export function runHandoff(input: HandoffInput): HandoffCommandResult {
  let state: HandoffState = "prepared";
  try {
    const artifact = buildHandoff(input);
    state = walkToCommitted(state);
    return { state, artifact, rendered: renderHandoff(artifact) };
  } catch (error) {
    state = "aborted";
    return { state, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Walk the fixed handoff state machine from `from` to `committed` using only
 * non-abort transitions. The fixed machine always reaches `committed` from any
 * live state, so the hop guard only bounds an impossible loop.
 */
function walkToCommitted(from: HandoffState): HandoffState {
  let current = from;
  let hops = 0;
  while (current !== "committed") {
    const next = nextStates(current).find((s) => s !== "aborted");
    if (!next) throw new Error(`no committed path from ${current}`);
    current = next;
    if (++hops > 5) throw new Error("handoff state machine did not converge");
  }
  return current;
}
