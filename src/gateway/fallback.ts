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

import { DEFAULT_EXCLUDE } from "../cav/routing.ts";

/** The model facts this decision needs. Mirrors pi's `Model` fields. */
export interface FallbackCandidate {
  id: string;
  provider: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly string[];
  /**
   * Gateway-reported readiness, when known — `"warm"`, `"cold"`, …
   *
   * Advisory, never disqualifying: see `isHealthy`.
   */
  state?: string;
  /** Concurrent requests the gateway will serve for this model, when known. */
  slots?: number;
  /** Capabilities the gateway advertises for the model; undefined when not advertised. */
  capabilities?: readonly string[];
  /** Tool-calling support as advertised (`x_tools`); undefined when not advertised. */
  tools?: boolean;
  /** A logical route rather than a concrete model; never a stand-in. */
  alias?: boolean;
}

/**
 * What a stand-in must offer beyond fitting the session. The effective
 * requirement is never lower than the current model's own advertised
 * capabilities and tool support (the quality floor): `need` can only raise it.
 */
export interface FallbackNeed {
  capabilities?: readonly string[];
  /** The request uses tools, so a stand-in must support them. */
  tools?: boolean;
}

/** Upper bound on any BLOCKED wait (routing-decision contract: waits bounded by 300000 ms). */
export const MAX_BLOCKED_WAIT_MS = 300_000;

/** Used when the gateway declared no usable Retry-After. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;

/** Largest fraction of the declared Retry-After added as jitter. */
const RETRY_JITTER = 0.25;

/**
 * Qualified = holds every required capability and, when tools are needed,
 * advertises tool support; never a route alias. Anything the catalogue did not
 * advertise does not qualify: an unknown capability is not a held one.
 */
export function isQualified(candidate: FallbackCandidate, need: FallbackNeed): boolean {
  if (candidate.alias === true) return false;
  const held = candidate.capabilities ?? [];
  if (!(need.capabilities ?? []).every((capability) => held.includes(capability))) return false;
  if (need.tools === true && candidate.tools !== true) return false;
  return true;
}

/**
 * The gateway's Retry-After with jitter on top: never earlier than asked (an
 * early retry is the load the gateway is shedding), spread over up to 25 % so
 * clients do not return together, and never beyond `maxMs`. A missing or
 * nonsensical value falls back to {@link DEFAULT_RETRY_AFTER_MS}.
 */
export function jitteredRetryAfterMs(
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
  maxMs: number = MAX_BLOCKED_WAIT_MS,
): number {
  const base =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_RETRY_AFTER_MS;
  const spread = Math.min(1, Math.max(0, random()));
  return Math.max(1, Math.min(maxMs, Math.round(base * (1 + RETRY_JITTER * spread))));
}

/** When a model just left (or refused) becomes eligible again: now plus the jittered wait. */
export function cooldownUntilFor(
  nowMs: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  return nowMs + jitteredRetryAfterMs(retryAfterMs, random);
}

/**
 * Is this model reported as able to serve right now?
 *
 * Unknown health counts as healthy. The signal is a snapshot taken at most a
 * few seconds ago, and treating "we have no data" or "cold at last poll" as
 * disqualifying would refuse a fallback that would have worked — trading a
 * usable model for a longer wait on a saturated one. So health ORDERS the
 * survivors; the hard filters remain context and modality, which are properties
 * of the model rather than of one moment.
 */
export function isHealthy(candidate: FallbackCandidate): boolean {
  if (candidate.slots !== undefined && candidate.slots <= 0) return false;
  if (candidate.state !== undefined && candidate.state.toLowerCase() === "cold") return false;
  return true;
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
  /** Requirements raised above the current model's own floor. */
  need?: FallbackNeed;
  /**
   * Model id to the epoch ms until which it must not be chosen (hysteresis: a
   * model just left, or one that refused, is not re-selected immediately).
   */
  cooldownUntil?: Readonly<Record<string, number>>;
  /** The clock for `cooldownUntil`; defaults to `Date.now()`. */
  nowMs?: number;
  /** Ids never chosen. Defaults to the routing exclusion list (deepseek-v4.1-flash until InferWeave #538). */
  exclude?: readonly string[];
  /** Longest a BLOCKED decision may ask to wait; clamped to {@link MAX_BLOCKED_WAIT_MS}. */
  maxWaitMs?: number;
  /** The gateway's declared delay on the hold, honored with jitter. */
  retryAfterMs?: number;
  /** Jitter source in [0, 1]; injectable for tests. */
  random?: () => number;
}

export type FallbackDecision =
  | { action: "switch"; model: FallbackCandidate; reason: string }
  | { action: "stay"; reason: string }
  /**
   * Nothing eligible: an explicit, bounded result, never an open-ended retry.
   * `retryAfterMs` is when to look again, `maxWaitMs` the longest to keep waiting.
   */
  | { action: "blocked"; reason: string; maxWaitMs: number; retryAfterMs: number };

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

  // Eligibility (autospec R-MODEL, issue #158): the current model's capabilities
  // and tool support are a floor that `need` may only raise; an excluded model,
  // a route alias and a model still cooling down are never chosen.
  const nowMs = input.nowMs ?? Date.now();
  const excluded = new Set(input.exclude ?? DEFAULT_EXCLUDE);
  const floor: FallbackNeed = {
    capabilities: [...new Set([...(current.capabilities ?? []), ...(input.need?.capabilities ?? [])])],
    tools: input.need?.tools === true || current.tools === true,
  };
  const cooling = (m: FallbackCandidate): boolean => (input.cooldownUntil?.[m.id] ?? 0) > nowMs;
  const eligible = viable.filter((m) => !excluded.has(m.id) && !cooling(m) && isQualified(m, floor));
  if (eligible.length === 0) {
    const maxWaitMs = Math.max(1, Math.min(input.maxWaitMs ?? MAX_BLOCKED_WAIT_MS, MAX_BLOCKED_WAIT_MS));
    const why = [
      `${viable.filter((m) => excluded.has(m.id)).length} excluded`,
      `${viable.filter((m) => !excluded.has(m.id) && cooling(m)).length} cooling down`,
      `${viable.filter((m) => !excluded.has(m.id) && !cooling(m) && !isQualified(m, floor)).length} below the quality floor`,
    ].join(", ");
    return {
      action: "blocked",
      reason: `no qualified model (${why}) — waiting at most ${maxWaitMs} ms`,
      maxWaitMs,
      retryAfterMs: jitteredRetryAfterMs(input.retryAfterMs, input.random, maxWaitMs),
    };
  }

  const ranked = [...eligible].sort((a, b) => {
    // Readiness outranks head-room. We are here because one model had no
    // workers; moving to another that also has none buys nothing, however much
    // context it could theoretically hold.
    const health = Number(isHealthy(b)) - Number(isHealthy(a));
    if (health !== 0) return health;
    if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
    // Among equals, spare capacity: a model serving nine concurrent requests is
    // less likely to refuse the next one than a model serving its only slot.
    // Below head-room, because running out of context costs a whole fallback
    // while a busy model costs a wait.
    const capacity = (b.slots ?? 0) - (a.slots ?? 0);
    if (capacity !== 0) return capacity;
    const parity = Number(b.reasoning === current.reasoning) - Number(a.reasoning === current.reasoning);
    if (parity !== 0) return parity;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const pick = ranked[0] as FallbackCandidate;
  const health = pick.slots !== undefined ? `, ${pick.slots} slot(s) free` : pick.state ? `, ${pick.state}` : "";
  return {
    action: "switch",
    model: pick,
    reason: `${pick.id} holds ${pick.contextWindow} tokens against ${usedTokens} in use${health}`,
  };
}
