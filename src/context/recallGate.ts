/**
 * Recall gate — filters and shapes promoted durable memory before it can enter a
 * context package.
 *
 * OpenViking recall returns raw `DurableMemoryRecord`s carrying no freshness,
 * confidence, secret-redaction or provenance. This pure module scores each
 * candidate with `scoreMemory`, drops stale / low-confidence / missing-ref /
 * redacted-empty / duplicate / over-limit records, and emits a `GatedRecall`
 * with a `RecallProvenance` so every memory that reaches a package is justified.
 *
 * Pure: no I/O, no `Date.now`; the redactor and the "now" instant are injected.
 */

import type { DurableMemoryRecord } from "../blackhole/OpenViking.ts";
import { type Freshness, type FreshnessMemory, type FreshnessScore, scoreMemory } from "../blackhole/freshness.ts";

/** A candidate memory as recalled from durable store, with optional extra fields. */
export type RecallCandidate = DurableMemoryRecord & {
  lastVerifiedAt?: string;
  sourceSha?: string;
};

export type RecallDropReason =
  | "stale"
  | "low_confidence"
  | "missing_ref"
  | "redacted_empty"
  | "duplicate"
  | "over_limit";

export interface RecallProvenance {
  source: string;
  promotedAt: string;
  sourceSha?: string;
  recalledAt: string;
  freshness: Freshness;
  confidence: number;
}

export interface GatedRecall {
  id: string;
  text: string;
  sourceRefs: string[];
  evidenceIds: string[];
  provenance: RecallProvenance;
}

export interface RecallGateInput {
  candidates: readonly RecallCandidate[];
  now: Date;
  currentSha?: string;
  minConfidence: number;
  dropStale?: boolean;
  requiredRefPrefixes?: readonly string[];
  redact: (s: string) => string;
  maxItems: number;
}

export interface RecallGateResult {
  kept: GatedRecall[];
  dropped: Array<{ id: string; reason: RecallDropReason }>;
}

/** Whether any `sourceRefs` entry starts with one of the required prefixes. */
function hasRequiredRef(refs: readonly string[], prefixes: readonly string[]): boolean {
  return refs.some((ref) => prefixes.some((prefix) => ref.startsWith(prefix)));
}

/** Normalise a redacted text for duplicate detection (case/whitespace-insensitive). */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Score one candidate's freshness/confidence from its promotedAt timestamp.
 *
 * An unparseable `promotedAt` is treated as stale (age unbounded), so a
 * malformed record is never silently kept as "fresh".
 */
function scoreCandidate(c: RecallCandidate, now: Date, currentSha?: string) {
  // An unparseable promotedAt must be treated as stale (never kept as fresh).
  if (Number.isNaN(new Date(c.promotedAt).getTime())) {
    return {
      ageDays: Number.POSITIVE_INFINITY,
      freshness: "stale",
      confidence: 0.8,
      reasons: ["unparseable promotedAt => stale"],
    } as FreshnessScore;
  }
  const mem: FreshnessMemory = {
    createdAt: c.promotedAt,
    ...(c.lastVerifiedAt !== undefined ? { lastVerifiedAt: c.lastVerifiedAt } : {}),
    ...(c.sourceSha !== undefined ? { sourceSha: c.sourceSha } : {}),
  };
  return scoreMemory(mem, now, currentSha);
}

/**
 * Select which candidates may enter a context package.
 *
 * Rules are applied in this exact order per candidate:
 *  1. score with `scoreMemory({ createdAt: promotedAt, ... }, now, currentSha)`.
 *  2. stale and `dropStale !== false` → drop `'stale'`.
 *  3. confidence < `minConfidence` → drop `'low_confidence'`.
 *  4. required refs missing → drop `'missing_ref'`.
 *  5. redacted-then-trimmed text collapses to nothing → drop `'redacted_empty'`.
 *  6. deterministic ordering (confidence desc, ageDays asc, id asc) then
 *     case/whitespace-insensitive dedupe → later copies drop `'duplicate'`.
 *  7. beyond `maxItems` → drop `'over_limit'` (`maxItems` not finite/< 0 ⇒ 0).
 *
 * Never mutates the input; never throws on a malformed candidate.
 */
export function selectRecallForPackage(input: RecallGateInput): RecallGateResult {
  const kept: GatedRecall[] = [];
  const dropped: Array<{ id: string; reason: RecallDropReason }> = [];

  const finiteItems = Number.isFinite(input.maxItems) ? input.maxItems : 0;
  const maxItems = Math.max(0, Math.floor(finiteItems));
  const required = input.requiredRefPrefixes ?? [];

  // Score every candidate up front so ordering can use the deterministic rank.
  const scored = input.candidates.map((c) => ({ c, score: scoreCandidate(c, input.now, input.currentSha) }));

  // Deterministic order: confidence desc, ageDays asc, id asc.
  scored.sort((a, b) => {
    if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
    if (a.score.ageDays !== b.score.ageDays) return a.score.ageDays - b.score.ageDays;
    return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
  });

  const seen = new Set<string>();

  for (const { c, score } of scored) {
    if (score.freshness === "stale" && input.dropStale !== false) {
      dropped.push({ id: c.id, reason: "stale" });
      continue;
    }
    if (score.confidence < input.minConfidence) {
      dropped.push({ id: c.id, reason: "low_confidence" });
      continue;
    }
    if (required.length > 0 && !hasRequiredRef(c.sourceRefs, required)) {
      dropped.push({ id: c.id, reason: "missing_ref" });
      continue;
    }

    const t = input.redact(c.text).trim();
    if (t.replace(/\[REDACTED\]/g, "").replace(/\s/g, "") === "") {
      dropped.push({ id: c.id, reason: "redacted_empty" });
      continue;
    }

    const key = dedupeKey(t);
    if (seen.has(key)) {
      dropped.push({ id: c.id, reason: "duplicate" });
      continue;
    }
    seen.add(key);

    if (kept.length >= maxItems) {
      dropped.push({ id: c.id, reason: "over_limit" });
      continue;
    }

    kept.push({
      id: c.id,
      text: t,
      sourceRefs: c.sourceRefs.map((ref) => input.redact(ref)),
      evidenceIds: [...c.evidenceIds],
      provenance: {
        source: c.promotedFrom,
        promotedAt: c.promotedAt,
        sourceSha: c.sourceSha,
        recalledAt: input.now.toISOString(),
        freshness: score.freshness,
        confidence: score.confidence,
      },
    });
  }

  return { kept, dropped };
}
