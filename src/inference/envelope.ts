/**
 * Required-model envelopes (fault-tolerance spec §12).
 *
 * When the original model is selected for a role, the hard requirements that
 * selection satisfied are recorded as an envelope. Every fallback candidate
 * MUST satisfy the same hard requirements — fallback is capability-based,
 * never string substitution.
 *
 * The envelope feeds the EXISTING RoleRouter (`extraRequires`, `minContext`,
 * `preferLocal`, `exclude`); `envelopeSatisfied` is the direct hard-requirement
 * check used to validate candidates (and by tests) before a fallback is
 * accepted, and `scoreFallbackCandidates` orders candidates in the spec's
 * precedence:
 *
 *   required capabilities → context capacity → current availability →
 *   model health → same model family → same capability/quality tier →
 *   observed role performance → latency → cost
 */

import { detectFamily, hasCapability } from "../capability/modelRecord.ts";
import type { ModelRecord, ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";

/** The hard requirements the original model selection satisfied (spec §12). */
export interface RequiredModelEnvelope {
  role: string;
  requiredCapabilities: string[];
  minimumContextTokens?: number;
  visionRequired?: boolean;
  toolCallingRequired?: boolean;
  reasoningRequired?: boolean;
  streamingRequired?: boolean;
  localRequired?: boolean;
  /** Minimum quality tier the original model met ("flash" < "standard" < "flagship"). */
  minimumQualityClass?: string;
  /** `provider/id` keys that must not be reconsidered. */
  excludedModels?: string[];
}

const QUALITY_ORDER: Record<string, number> = {
  flash: 0,
  standard: 1,
  flagship: 2,
};

/**
 * The capability tokens an envelope demands. Boolean flags map onto the
 * registry's canonical capability names; `requiredCapabilities` is passed
 * through verbatim.
 */
export function envelopeCapabilities(envelope: RequiredModelEnvelope): string[] {
  const caps = new Set(envelope.requiredCapabilities);
  if (envelope.visionRequired) caps.add("vision");
  if (envelope.toolCallingRequired) caps.add("tool_calling");
  if (envelope.reasoningRequired) caps.add("reasoning");
  if (envelope.streamingRequired) caps.add("streaming");
  if (envelope.localRequired) caps.add("local");
  return [...caps];
}

function qualityClassOf(rec: ModelRecord): string {
  const highQuality = hasCapability(rec, "high_quality");
  if (highQuality) return "flagship";
  const tags = rec.tags.join(" ");
  if (/flash|mini|lite|nano/i.test(tags) || (rec.priceOutputUsdPerMTok ?? 0) < 1) return "flash";
  return "standard";
}

/**
 * Hard-requirement check: does this record satisfy the envelope? This is the
 * gate every fallback candidate must pass — no capability may be missing,
 * the context window must fit, and the quality tier may not drop below the
 * original.
 */
export function envelopeSatisfied(rec: ModelRecord, envelope: RequiredModelEnvelope): boolean {
  for (const cap of envelopeCapabilities(envelope)) {
    if (!hasCapability(rec, cap)) return false;
  }
  if (envelope.localRequired && !rec.local) return false;
  const minContext = Math.max(envelope.minimumContextTokens ?? 0);
  if (minContext > 0 && (rec.contextWindow ?? 0) < minContext) return false;
  const minTier = envelope.minimumQualityClass ? QUALITY_ORDER[envelope.minimumQualityClass] : undefined;
  if (minTier !== undefined) {
    const tier = QUALITY_ORDER[qualityClassOf(rec)];
    if (tier === undefined || tier < minTier) return false;
  }
  if (envelope.excludedModels?.includes(modelKey({ provider: rec.provider, id: rec.id }))) return false;
  return true;
}

export interface FallbackScoringContext {
  /** The original model the envelope was recorded from (family/tier affinity). */
  original?: ModelRecord | ModelRef;
  /** Now, for availability-expiry checks. */
  now?: number;
  /** Model keys that are currently penalized/unavailable (skipped by the caller). */
}

export interface RankedFallback {
  record: ModelRecord;
  score: number;
  /** Ordered part names, for explainability. */
  parts: Record<string, number>;
}

/**
 * Order candidates for a capability-based fallback. Candidates are assumed to
 * already pass `envelopeSatisfied` (hard requirements); the score encodes the
 * spec's soft precedence so the best comparable model wins ties.
 */
export function scoreFallbackCandidates(
  candidates: ModelRecord[],
  envelope: RequiredModelEnvelope,
  ctx: FallbackScoringContext = {},
): RankedFallback[] {
  const originalFamily = ctx.original ? detectFamily(ctx.original.id) : undefined;
  const originalTier = ctx.original && "capabilities" in ctx.original ? qualityClassOf(ctx.original) : undefined;
  const ranked = candidates
    .filter((rec) => envelopeSatisfied(rec, envelope))
    .map((rec) => {
      const parts: Record<string, number> = {};
      // 1. Required capabilities: satisfied candidates share the baseline;
      //    surplus relevant capabilities still break ties in its favour.
      const caps = envelopeCapabilities(envelope);
      const relevant = ["vision", "reasoning", "tool_calling", "streaming", "long_context"];
      const extra = relevant.filter((c) => !caps.includes(c) && hasCapability(rec, c)).length;
      parts.capabilities = 1 + Math.min(0.5, extra * 0.1);
      // 2. Context capacity: headroom over the requirement.
      const minContext = envelope.minimumContextTokens ?? 0;
      const window = rec.contextWindow ?? 0;
      parts.context =
        minContext > 0 && window > minContext
          ? Math.min(1, 0.5 + Math.log10(1 + window / minContext) / 2)
          : window > 0
            ? 0.7
            : 0.4;
      // 3. Current availability.
      parts.availability = rec.available ? 1 : 0;
      // 4. Model health.
      parts.health = rec.healthy ? 1 : 0;
      // 5. Same model family as the original.
      const family = detectFamily(rec.id);
      parts.family = originalFamily !== undefined && family === originalFamily ? 1 : 0.5;
      // 6. Same capability/quality tier.
      const tier = qualityClassOf(rec);
      parts.tier = originalTier !== undefined && tier === originalTier ? 1 : (QUALITY_ORDER[tier] ?? 0.5);
      // 7. Observed role performance (neutral without samples).
      const observed = rec.observed;
      parts.observed = observed && observed.samples >= 3 ? Math.min(1, Math.max(0, observed.meanQuality)) : 0.5;
      // 8. Latency (observed, else local/price proxy).
      const lat = observed?.meanLatencyMs;
      parts.latency =
        typeof lat === "number"
          ? Math.max(0, Math.min(1, 1 - lat / 120_000))
          : rec.local
            ? 1
            : (rec.priceOutputUsdPerMTok ?? 10) >= 30
              ? 0.5
              : 0.8;
      // 9. Cost.
      const cost = (rec.priceInputUsdPerMTok ?? 0) + (rec.priceOutputUsdPerMTok ?? 0);
      parts.cost = cost <= 0 ? 1 : Math.max(0, Math.min(1, 1 - Math.log10(1 + cost) / 2.5));
      // Hard gates first, soft order after: an unavailable or unhealthy model
      // never outranks a live comparable one, whatever its other scores.
      const gate = (parts.availability + parts.health) / 2;
      const soft = Object.entries(parts)
        .filter(([k]) => k !== "availability" && k !== "health")
        .reduce((sum, [k, v]) => sum + v, 0);
      return { record: rec, score: gate * 2 + soft, parts };
    });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
