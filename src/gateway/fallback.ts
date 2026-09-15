/**
 * Choosing a stand-in model when one model has no workers.
 *
 * `503 no worker for model` is model-specific: the gateway is up, the account
 * is fine, that one model has nothing to serve it. Waiting works (see
 * streamRetry.ts) but costs wall-clock, and a gateway serving several models
 * usually has a healthy one.
 *
 * ── Why this is mostly a refusal engine ─────────────────────────────────────
 *
 * The obvious failure is swapping to a model the session no longer fits in.
 * A 400k-token session moved from a 1M-context model to a 262k one does not
 * degrade — it fails immediately with a context overflow, having traded a
 * survivable wait for an unsurvivable error. So every rule here is a reason NOT
 * to switch, and "stay" is the answer whenever the alternative cannot be shown
 * to be safe.
 *
 * Pure and deterministic: the caller supplies the catalogue and the measured
 * context, and decides when to ask.
 */

/** The model facts this decision needs. Mirrors pi's `Model` fields. */
export interface FallbackCandidate {
  id: string;
  provider: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly string[];
}

export interface FallbackInput {
  current: FallbackCandidate;
  /**
   * Models that are usable right now: in the catalogue AND with auth
   * configured. Filtering for availability is the caller's job.
   */
  available: readonly FallbackCandidate[];
  /**
   * Context tokens currently in use, from `ctx.getContextUsage()`.
   *
   * `null` means Pi does not know — it reports null right after compaction,
   * before the next response re-establishes a count. A null here is decisive:
   * see `chooseFallbackModel`.
   */
  usedTokens: number | null;
  /**
   * Extra head-room beyond the candidate's own `maxTokens`, for context the
   * measurement does not capture (a tool result mid-flight, the next user
   * message). Defaults to `DEFAULT_HEADROOM_TOKENS`.
   */
  headroomTokens?: number;
}

export type FallbackDecision =
  | { action: "switch"; model: FallbackCandidate; reason: string }
  | { action: "stay"; reason: string };

/** Slack kept free on top of a candidate's own maximum output. */
export const DEFAULT_HEADROOM_TOKENS = 8_192;

/** Tokens a candidate must be able to hold for this session to continue in it. */
export function requiredWindow(usedTokens: number, candidate: FallbackCandidate, headroom: number): number {
  return usedTokens + candidate.maxTokens + headroom;
}

/** Whether `candidate` keeps every input modality the current model offers. */
function keepsModalities(current: FallbackCandidate, candidate: FallbackCandidate): boolean {
  return current.input.every((kind) => candidate.input.includes(kind));
}

/**
 * Pick a model to fall back to, or decline.
 *
 * Declines when:
 *
 *   * the context size is unknown — a switch cannot be shown to be safe, and an
 *     unsafe switch is strictly worse than the wait it replaces;
 *   * nothing in the catalogue can hold the session plus its next response;
 *   * the only models that fit would silently drop a modality the session can
 *     use (moving a session that can send images to a text-only model turns a
 *     wait into a hard failure the moment an image appears).
 *
 * Among survivors, the most head-room wins: a session only grows, and falling
 * back twice in three turns is its own kind of broken. Ties break toward
 * reasoning parity and then by id, so the choice is stable across calls rather
 * than flapping between equals.
 */
export function chooseFallbackModel(input: FallbackInput): FallbackDecision {
  const { current, available, usedTokens } = input;
  const headroom = input.headroomTokens ?? DEFAULT_HEADROOM_TOKENS;

  if (usedTokens == null) {
    return {
      action: "stay",
      reason: "context size unknown — cannot prove another model would fit, and a wrong guess fails the turn outright",
    };
  }

  const others = available.filter((m) => !(m.id === current.id && m.provider === current.provider));
  if (others.length === 0) return { action: "stay", reason: "no other model is available" };

  const fits = others.filter((m) => m.contextWindow >= requiredWindow(usedTokens, m, headroom));
  if (fits.length === 0) {
    return {
      action: "stay",
      reason: `no available model can hold ${usedTokens} context tokens plus a response — waiting is the only safe option`,
    };
  }

  const viable = fits.filter((m) => keepsModalities(current, m));
  if (viable.length === 0) {
    return {
      action: "stay",
      reason: `every model that fits would drop support for ${current.input.join("/")}`,
    };
  }

  const ranked = [...viable].sort((a, b) => {
    if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
    const parity = Number(b.reasoning === current.reasoning) - Number(a.reasoning === current.reasoning);
    if (parity !== 0) return parity;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const pick = ranked[0] as FallbackCandidate;
  return {
    action: "switch",
    model: pick,
    reason: `${pick.id} holds ${pick.contextWindow} tokens against ${usedTokens} in use`,
  };
}
