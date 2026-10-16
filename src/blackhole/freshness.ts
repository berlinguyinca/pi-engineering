/**
 * Memory freshness / confidence scoring.
 *
 * Recalled memories carry no freshness or confidence on their own; this module
 * derives both from the memory's recorded timestamps and its grounding source
 * SHA, so recall can prefer memories that are recent and match the current
 * repository state. Pure (no I/O, no shared state) — callable from anywhere.
 */

/** A memory shape this scorer accepts. Only the timestamp / source fields are read. */
export interface FreshnessMemory {
  createdAt: string;
  lastVerifiedAt?: string;
  sourceSha?: string;
  contentHash?: string;
}

export type Freshness = "fresh" | "aging" | "stale";

export interface FreshnessScore {
  ageDays: number;
  freshness: Freshness;
  confidence: number;
  reasons: string[];
}

const FRESH_DAYS = 7;
const AGING_DAYS = 30;
const STALE_PENALTY = 0.2;
const AGING_PENALTY = 0.1;
const SHA_MISMATCH_PENALTY = 0.4;
const CONFIDENCE_FLOOR = 0;

/** Fractional day between `from` and `now`. */
function ageInDays(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 86_400_000;
}

/**
 * Score one memory's freshness and confidence.
 *
 * Age is measured from `lastVerifiedAt` when present, else `createdAt`.
 * Freshness bands (in days): < 7 = fresh, 7–30 = aging, > 30 = stale.
 * Confidence starts at 1.0 and is reduced by:
 *   - 0.4 when `sourceSha` is set and differs from `currentSha`;
 *   - 0.2 when stale;
 *   - 0.1 when aging.
 * Confidence never falls below 0. `reasons` lists every applied rule.
 */
export function scoreMemory(mem: FreshnessMemory, now: Date, currentSha?: string): FreshnessScore {
  const base = mem.lastVerifiedAt ? new Date(mem.lastVerifiedAt) : new Date(mem.createdAt);
  const ageDays = ageInDays(base, now);
  const freshness: Freshness = ageDays < FRESH_DAYS ? "fresh" : ageDays > AGING_DAYS ? "stale" : "aging";

  const reasons: string[] = [`age ${ageDays.toFixed(2)}d => ${freshness}`];

  let confidence = 1;
  if (mem.sourceSha !== undefined && currentSha !== undefined && mem.sourceSha !== currentSha) {
    confidence -= SHA_MISMATCH_PENALTY;
    reasons.push(`sourceSha ${mem.sourceSha} != current ${currentSha} (-0.4)`);
  }
  if (freshness === "stale") {
    confidence -= STALE_PENALTY;
    reasons.push("stale (-0.2)");
  } else if (freshness === "aging") {
    confidence -= AGING_PENALTY;
    reasons.push("aging (-0.1)");
  }

  // Penalties are single-decimal, so rounding to 2 dp removes binary float
  // artifacts (e.g. 1 - 0.4 - 0.2 => 0.39999999999999997) without changing
  // semantics.
  const clamped = Math.max(CONFIDENCE_FLOOR, confidence);
  const rounded = Math.round(clamped * 100) / 100;

  return {
    ageDays,
    freshness,
    confidence: rounded,
    reasons,
  };
}

/**
 * Rank memories best-first for recall: confidence descending, then age
 * ascending as a tie-breaker. Pure — the input list is not mutated.
 */
export function rankMemories(list: FreshnessMemory[], now: Date, currentSha?: string): FreshnessMemory[] {
  return [...list].sort((a, b) => {
    const sa = scoreMemory(a, now, currentSha);
    const sb = scoreMemory(b, now, currentSha);
    if (sb.confidence !== sa.confidence) return sb.confidence - sa.confidence;
    return sa.ageDays - sb.ageDays;
  });
}
