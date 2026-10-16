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
 * malformed record is never silently kept as "fresh". A `lastVerifiedAt` that
 * is present but unparseable is ignored (age is measured from `promotedAt`).
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
    // Ignore a present-but-unparseable lastVerifiedAt (score from promotedAt).
    ...(c.lastVerifiedAt !== undefined && !Number.isNaN(Date.parse(c.lastVerifiedAt))
      ? { lastVerifiedAt: c.lastVerifiedAt }
      : {}),
    ...(c.sourceSha !== undefined ? { sourceSha: c.sourceSha } : {}),
  };
  return scoreMemory(mem, now, currentSha);
}

/**
 * Normalise a candidate so downstream scoring and output never touch
 * undefined / non-array fields, then return it (or null when the candidate is
 * too malformed to process — no id to report).
 */
function normaliseCandidate(c: RecallCandidate): RecallCandidate | null {
  // A null / non-object / missing-id or non-string-id candidate cannot be
  // reported, so skip it entirely (neither kept nor dropped).
  if (c === null || typeof c !== "object" || typeof c.id !== "string" || c.id.length === 0) {
    return null;
  }
  return {
    ...c,
    // id is a non-empty string here; a non-string text is treated as "" so the
    // item lands in 'redacted_empty' rather than throwing inside the redactor.
    text: typeof c.text === "string" ? c.text : "",
    // Missing / non-array sourceRefs and evidenceIds behave as empty lists.
    sourceRefs: Array.isArray(c.sourceRefs) ? c.sourceRefs : [],
    evidenceIds: Array.isArray(c.evidenceIds) ? c.evidenceIds : [],
  };
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
 *  7. beyond `maxItems` → drop `'over_limit'` (`maxItems` honoured only when
 *     it is an integer >= 0; otherwise the cap is 0).
 *
 * Never mutates the input; never throws on a malformed candidate. A candidate
 * that is null / non-object or lacks a non-empty string `id` is skipped
 * entirely (it appears in neither `kept` nor `dropped`).
 */
export function selectRecallForPackage(input: RecallGateInput): RecallGateResult {
  const kept: GatedRecall[] = [];
  const dropped: Array<{ id: string; reason: RecallDropReason }> = [];

  // maxItems is honoured only when it is an integer >= 0; anything else
  // (e.g. 1.5, NaN, negative) caps at 0 so nothing is kept.
  const maxItems = Number.isInteger(input.maxItems) && input.maxItems >= 0 ? input.maxItems : 0;
  const required = input.requiredRefPrefixes ?? [];

  // Normalise / skip malformed candidates, then score up front so ordering can
  // use the deterministic rank. ageDays is guaranteed finite here, so the sort
  // comparator below never sees NaN.
  const scored: Array<{ c: RecallCandidate; score: FreshnessScore }> = [];
  for (const raw of input.candidates) {
    const c = normaliseCandidate(raw);
    if (c === null) continue;
    let score = scoreCandidate(c, input.now, input.currentSha);
    if (!Number.isFinite(score.ageDays)) {
      // A non-finite age (malformed timestamps) is never kept as fresh and must
      // not leak NaN into the comparator — treat as stale with unbounded age.
      score = {
        ageDays: Number.POSITIVE_INFINITY,
        freshness: "stale",
        confidence: 0.8,
        reasons: ["non-finite age => stale"],
      } as FreshnessScore;
    }
    scored.push({ c, score });
  }

  // Deterministic order: confidence desc, ageDays asc, id asc.
  scored.sort((a, b) => {
    if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
    if (a.score.ageDays !== b.score.ageDays) return a.score.ageDays - b.score.ageDays;
    return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
  });

  const seen = new Set<string>();

  // Dedupe happens BEFORE the maxItems cap: a text that was already kept is
  // reported as 'duplicate' even when it would otherwise have been capped as
  // 'over_limit'. This keeps the rule ordering (dedupe then limit) stable.
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
