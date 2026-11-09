import type { ErrorOccurrence } from "./errorEvent.ts";
// D03: pure aggregation of persisted E02 occurrences into issue clusters — no I/O, no clock, no randomness, no input
// mutation. The grouping key is D02's `errorFingerprint` (never a second key) and the ordering is total, so every
// permutation of the same rows yields byte-identical output. D01's IndexedErrorOccurrence satisfies AggregateRow.
import { INVALID_FINGERPRINT, errorFingerprint } from "./errorFingerprint.ts";

/** Source event ids kept per cluster when the caller is silent. */
export const DEFAULT_MAX_EVENT_IDS = 50;

export interface AggregateRow {
  eventId: string;
  occurrence: ErrorOccurrence;
  resolution?: "recovered" | "unresolved";
  failureIdentity?: string;
}
export interface ErrorCluster {
  fingerprint: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sessions: string[];
  hosts: string[];
  models: string[];
  quantizations: string[];
  layers: string[];
  codes: string[];
  recovered: number;
  unresolved: number;
  eventIds: string[];
  eventIdsTruncated: boolean;
}
export interface AggregateResult {
  clusters: ErrorCluster[];
  truncated: boolean;
  duplicateEvents: number;
  rejected: number;
}

// `keys` is the dedupe ledger (one entry per counted eventId and per counted failureIdentity); `count` counts what it admitted, so recovered + unresolved === count holds by construction.
type Bucket = {
  fingerprint: string;
  keys: Set<string>;
  count: number;
  ids: Set<string>;
  firstMs: number;
  firstSeen: string;
  lastMs: number;
  lastSeen: string;
  recovered: number;
  unresolved: number;
  dims: Record<"sessions" | "hosts" | "models" | "quantizations" | "layers" | "codes", Set<string>>;
};
const sorted = (set: Set<string>): string[] => [...set].sort();
const add = (set: Set<string>, value: string | null | undefined): void => {
  if (typeof value === "string" && value !== "") set.add(value);
}; // an unset dimension stays absent rather than becoming a fabricated "unknown" member
const bound = (requested: number | undefined, fallback: number): number => {
  const n = requested ?? fallback;
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}; // a non-finite request falls back, a negative one clamps: never unbounded
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const foldKey = (r: AggregateRow): string =>
  `${str(r?.eventId)} ${str(r?.failureIdentity)} ${str(r?.occurrence?.timestamp)}`; // rows are folded in this canonical order, so WHICH row of a duplicate set becomes the representative cannot depend on input order either

const newBucket = (fingerprint: string): Bucket => ({
  fingerprint,
  keys: new Set(),
  count: 0,
  ids: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  firstSeen: "",
  lastMs: Number.NEGATIVE_INFINITY,
  lastSeen: "",
  recovered: 0,
  unresolved: 0,
  dims: {
    sessions: new Set(),
    hosts: new Set(),
    models: new Set(),
    quantizations: new Set(),
    layers: new Set(),
    codes: new Set(),
  },
});

// Source event ids are kept sorted and capped for the report; `count` stays exact whatever the cap hides.
const toCluster = (b: Bucket, maxEventIds: number): ErrorCluster => {
  const ids = [...b.ids].sort();
  return {
    fingerprint: b.fingerprint,
    count: b.count,
    firstSeen: b.firstSeen,
    lastSeen: b.lastSeen,
    sessions: sorted(b.dims.sessions),
    hosts: sorted(b.dims.hosts),
    models: sorted(b.dims.models),
    quantizations: sorted(b.dims.quantizations),
    layers: sorted(b.dims.layers),
    codes: sorted(b.dims.codes),
    recovered: b.recovered,
    unresolved: b.unresolved,
    eventIds: ids.slice(0, maxEventIds),
    eventIdsTruncated: ids.length > maxEventIds,
  };
};

/** Group occurrences by root cause. A row D02 refuses (`INVALID_FINGERPRINT`) lands in `rejected` and forms no
 * cluster. `resolution` defaults to "unresolved": D04 owns recovery classification and will supply it, so until then
 * every counted occurrence is unresolved. `duplicateEvents` counts every row folded away as a duplicate of one
 * already counted — the same `eventId` again, and (the retry-trace case) a second `eventId` carrying an E07
 * `failureIdentity` already seen here: one upstream failure observable through two paths is ONE failure, so it must
 * not inflate `count` even though BOTH source event ids are kept as evidence. */
export function aggregateErrorOccurrences(
  rows: readonly AggregateRow[],
  opts: { maxEventIds?: number; limit?: number } = {},
): AggregateResult {
  const maxEventIds = bound(opts.maxEventIds, DEFAULT_MAX_EVENT_IDS);
  const buckets = new Map<string, Bucket>();
  let duplicateEvents = 0;
  let rejected = 0;
  for (const row of (Array.isArray(rows) ? [...rows] : []).sort((p, q) =>
    foldKey(p) < foldKey(q) ? -1 : foldKey(p) > foldKey(q) ? 1 : 0,
  )) {
    // a copy is sorted; the caller's array is never touched
    const occurrence = row?.occurrence;
    const fingerprint =
      occurrence === null || typeof occurrence !== "object" ? INVALID_FINGERPRINT : errorFingerprint(occurrence);
    if (fingerprint === INVALID_FINGERPRINT) {
      rejected++;
      continue;
    } // unattributable: counted, never clustered
    const eventId = typeof row.eventId === "string" ? row.eventId : "";
    let b = buckets.get(fingerprint);
    if (b === undefined) {
      b = newBucket(fingerprint);
      buckets.set(fingerprint, b);
    }
    if (eventId !== "") b.ids.add(eventId); // evidence survives even when this row itself is a duplicate
    const fid = typeof row.failureIdentity === "string" ? row.failureIdentity : ""; // E07 gives one upstream failure one identity across both observation paths
    const keys = [eventId !== "" ? `e:${eventId}` : "", fid !== "" ? `f:${fid}` : ""].filter((k) => k !== ""); // duplicate if EITHER key was counted already, so a retry-trace twin carrying a fid cannot re-count the eventId it repeats
    if (keys.some((k) => b.keys.has(k))) {
      duplicateEvents++;
      continue;
    }
    for (const k of keys) b.keys.add(k);
    b.count++; // `b.count++` follows the loop body, it is not part of it
    const at = Date.parse(occurrence.timestamp); // D01 admits only ISO-8601 UTC; an unparsable stamp bounds nothing but still counts
    if (Number.isFinite(at)) {
      if (at < b.firstMs) {
        b.firstMs = at;
        b.firstSeen = occurrence.timestamp;
      }
      if (at > b.lastMs) {
        b.lastMs = at;
        b.lastSeen = occurrence.timestamp;
      }
    }
    add(b.dims.sessions, occurrence.sessionId);
    add(b.dims.hosts, occurrence.host);
    add(b.dims.models, occurrence.model);
    add(b.dims.quantizations, occurrence.quantization);
    add(b.dims.layers, occurrence.layer);
    add(b.dims.codes, occurrence.code);
    if (row.resolution === "recovered") b.recovered++;
    else b.unresolved++;
  }
  const ordered = [...buckets.values()].sort(
    (x, y) =>
      y.lastMs - x.lastMs ||
      y.count - x.count ||
      (x.fingerprint < y.fingerprint ? -1 : x.fingerprint > y.fingerprint ? 1 : 0),
  ); // lastSeen desc, count desc, fingerprint asc
  const limit = bound(opts.limit, ordered.length);
  return {
    clusters: ordered.slice(0, limit).map((b) => toCluster(b, maxEventIds)),
    truncated: ordered.length > limit,
    duplicateEvents,
    rejected,
  };
}
