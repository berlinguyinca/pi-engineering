/**
 * Context compatibility before a model switch (spec §17).
 *
 * Before work moves to another model, check that the target can hold it:
 * context capacity, modalities, tool calling, structured output and the
 * required capability. The four outcomes, in order of preference:
 *
 *   1. other_model — a different compatible model;
 *   2. compact     — shrink the current context to fit the target;
 *   3. handoff     — continue from a task-specific handoff instead of the context;
 *   4. reject      — the transition cannot be made safely.
 *
 * Planner → worker transitions always prefer a handoff: the implementer must
 * not inherit the planner's context.
 */

export interface ModelProfile {
  id: string;
  /** Unknown windows are assumed to fit (tolerant of plain gateways). */
  contextWindow?: number;
  /** Input modalities, e.g. ["text", "image"]; empty = unknown (assume text). */
  modalities: string[];
  tools?: boolean;
  structuredOutput?: boolean;
  capabilities: string[];
}

export interface TransitionNeeds {
  /** Tokens the current context occupies. */
  contextTokens: number;
  /** Tokens of a task-specific handoff, when one can be built. */
  handoffTokens?: number;
  /** Headroom kept free for the response. */
  reserveTokens?: number;
  needsTools?: boolean;
  needsStructuredOutput?: boolean;
  modalities?: string[];
  capability?: string;
  /** Prefer a handoff even when the context would fit (planner → worker). */
  preferHandoff?: boolean;
  /** Whether the caller can compact its context. */
  canCompact?: boolean;
}

export type TransitionPlan =
  | { outcome: "switch"; model: ModelProfile; context: "direct" | "handoff"; notes: string[] }
  | { outcome: "other_model"; model: ModelProfile; context: "direct" | "handoff"; notes: string[] }
  | { outcome: "compact"; model: ModelProfile; targetTokens: number; notes: string[] }
  | { outcome: "handoff"; model: ModelProfile; notes: string[] }
  | { outcome: "reject"; reasons: string[] };

const DEFAULT_RESERVE = 4_096;

/** Hard (non-context) incompatibilities of a model for the needs. */
export function hardIncompatibilities(m: ModelProfile, needs: TransitionNeeds): string[] {
  const out: string[] = [];
  for (const mod of needs.modalities ?? []) {
    if (mod === "text") continue;
    if (!m.modalities.includes(mod)) out.push(`${m.id} lacks ${mod} input`);
  }
  if (needs.needsTools && m.tools === false) out.push(`${m.id} lacks tool calling`);
  if (needs.needsStructuredOutput && m.structuredOutput === false) out.push(`${m.id} lacks structured output`);
  if (needs.capability && m.capabilities.length > 0 && !m.capabilities.includes(needs.capability)) {
    out.push(`${m.id} lacks capability ${needs.capability}`);
  }
  return out;
}

function fits(m: ModelProfile, tokens: number, reserve: number): boolean {
  return m.contextWindow === undefined || tokens + reserve <= m.contextWindow;
}

export function planTransition(
  target: ModelProfile,
  needs: TransitionNeeds,
  alternatives: ModelProfile[] = [],
): TransitionPlan {
  const reserve = needs.reserveTokens ?? DEFAULT_RESERVE;
  const hard = hardIncompatibilities(target, needs);
  const handoffFits = (m: ModelProfile) => needs.handoffTokens !== undefined && fits(m, needs.handoffTokens, reserve);
  const directFits = (m: ModelProfile) => fits(m, needs.contextTokens, reserve);

  if (hard.length === 0) {
    if (needs.preferHandoff && handoffFits(target)) {
      return { outcome: "switch", model: target, context: "handoff", notes: [] };
    }
    if (!needs.preferHandoff && directFits(target)) {
      return { outcome: "switch", model: target, context: "direct", notes: [] };
    }
  }
  const why =
    hard.length > 0 ? hard : [`${needs.contextTokens} tokens do not fit ${target.id} (${target.contextWindow})`];
  // 1. another compatible model.
  for (const alt of alternatives) {
    if (alt.id === target.id || hardIncompatibilities(alt, needs).length > 0) continue;
    if (needs.preferHandoff && handoffFits(alt))
      return { outcome: "other_model", model: alt, context: "handoff", notes: why };
    if (!needs.preferHandoff && directFits(alt))
      return { outcome: "other_model", model: alt, context: "direct", notes: why };
  }
  if (hard.length > 0) return { outcome: "reject", reasons: hard };
  // 2. compact the context to fit.
  const window = target.contextWindow ?? 0;
  if (!needs.preferHandoff && needs.canCompact && window > reserve * 2) {
    return { outcome: "compact", model: target, targetTokens: window - reserve, notes: why };
  }
  // 3. task-specific handoff.
  if (handoffFits(target)) return { outcome: "handoff", model: target, notes: why };
  // 4. reject.
  return { outcome: "reject", reasons: [...why, "no compatible model, compaction or handoff fits"] };
}
