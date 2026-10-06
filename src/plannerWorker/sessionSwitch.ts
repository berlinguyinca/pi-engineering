/**
 * Interactive-session model switches (spec §12, §17).
 *
 * Pi already switches the session model mid-conversation (`/model`, fallback,
 * `pi.setModel`) and keeps one session format across providers. Planner/worker
 * mode does not add a second one: it observes Pi's `model_select` event,
 * records the MODEL_TRANSITION, and checks that the current context fits the
 * new model — compacting through Pi's own `ctx.compact()` when it does not.
 */

import { type ModelProfile, type TransitionPlan, planTransition } from "./compatibility.ts";

export interface SessionModelInfo {
  id: string;
  provider?: string;
  contextWindow?: number;
  /** Pi model `input` modalities, e.g. ["text", "image"]. */
  input?: string[];
}

export function profileOf(m: SessionModelInfo): ModelProfile {
  return {
    id: m.provider ? `${m.provider}/${m.id}` : m.id,
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    modalities: m.input ?? ["text"],
    capabilities: [],
  };
}

/** Plan how the live session crosses a model switch. */
export function assessSessionSwitch(input: {
  next: SessionModelInfo;
  contextTokens: number | null;
  reserveTokens?: number;
}): TransitionPlan {
  return planTransition(profileOf(input.next), {
    contextTokens: input.contextTokens ?? 0,
    canCompact: true,
    ...(input.reserveTokens !== undefined ? { reserveTokens: input.reserveTokens } : {}),
  });
}
