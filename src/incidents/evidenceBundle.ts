// D07: a bounded, sanitized, deterministic evidence bundle over D01 occurrences — what makes a diagnosis
// reproducible (fingerprint, representative summary, affected versions, retry identities, task/handoff ids, outcome)
// and nothing more. Pure and read-only: no I/O, no clock, no randomness, no input mutation. Every module it calls
// owns its own concern and this file calls instead of copying: E04 privacy, D02 identity, D03 clustering/counts,
// D04 recovery, E07 retry identity. Byte accounting happens after sanitization, and a cap that bites reports what
// it dropped rather than dropping it silently.
import { DEFAULT_MAX_EVENT_IDS, type AggregateRow, aggregateErrorOccurrences } from "./errorAggregate.ts";
import { errorFingerprint } from "./errorFingerprint.ts";
import { sanitizeForPersistence } from "./errorSanitize.ts";
import { type RecoveryEvidence, type RecoveryOutcome, classifyRecoveryOutcome } from "./recoveryOutcome.ts";
import { type ErrorRef, type FailureIdentityInput, type RetryTrace, errorRef, failureIdentity } from "../inference/retryTrace.ts";

export const BUNDLE_VERSION = 1;
export const DEFAULT_MAX_ITEMS = 20, DEFAULT_MAX_BYTES = 32768; // the bundle is a diagnosis, not a log store
export const OUTCOME_PRECEDENCE: readonly RecoveryOutcome[] = ["recovered", "suppressed", "unresolved"]; // "unknown" is what no evidence says
export const TASK_ID = /^task:(.+)$/; export const HANDOFF_ID = /^handoff:(.+)$/; // E06's correlation ids name the work; any other id stays a pointer, never a task
export const FAILURE_ID = /^sha256:[0-9a-f]{64}$/; // E07's shape; anything else is caller text, so it is dropped, never shortened into something id-shaped

export type EvidenceRow = AggregateRow; // D01's IndexedErrorOccurrence already satisfies it
export interface EvidenceLimits { maxItems?: number; maxBytes?: number; maxEventIds?: number }
export interface EvidenceFailure { eventId?: string; scope: FailureIdentityInput } // a caller holding the raw failure hands E07 the scope; it never hands us an id we would trust
export interface EvidenceInput { occurrences: readonly EvidenceRow[]; retryTraces?: readonly RetryTrace[]; failures?: readonly EvidenceFailure[]; recovery?: Record<string, RecoveryEvidence> }
export interface EvidenceVersions { runtime: string[]; model: string[]; quantization: string[] }
export interface EvidenceItem { fingerprint: string; summary: string; code: string; layer: string; severity: string; count: number; firstSeen: string; lastSeen: string; versions: EvidenceVersions; failureIds: string[]; correlationIds: string[]; taskIds: string[]; handoffIds: string[]; outcome: RecoveryOutcome; eventIds: string[]; eventIdsTruncated: boolean }
export interface EvidenceBundle { version: number; items: EvidenceItem[]; dropped: { items: number; bytes: number }; refused: number; bytes: number; truncated: boolean }

const uniq = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === "string" && value !== ""))].sort(); // an unset dimension stays absent rather than becoming a fabricated member
const bound = (requested: number | undefined, fallback: number): number => (Number.isInteger(requested) && (requested as number) >= 1 ? (requested as number) : fallback); // a bad cap falls back to the default; it never means "unbounded"
const text = (value: unknown): string => (typeof value === "string" ? value : ""); const idOf = (rule: RegExp, ids: readonly string[]): string[] => uniq(ids.map((id) => rule.exec(id)?.[1])); // a discoverable id, or nothing

/** One item per cause, capped by item count and by serialized bytes, ordered by fingerprint then firstSeen then first eventId; the same input always re-serializes byte-identically. */
export function buildEvidenceBundle(input: EvidenceInput, limits: EvidenceLimits = {}): EvidenceBundle {
  const [maxItems, maxBytes, maxEventIds] = [bound(limits.maxItems, DEFAULT_MAX_ITEMS), bound(limits.maxBytes, DEFAULT_MAX_BYTES), bound(limits.maxEventIds, DEFAULT_MAX_EVENT_IDS)];
  const recovery = input.recovery ?? {}; const outcomes = new Map<string, RecoveryOutcome>(); const derived = new Map<string, string>(); const observed: Array<{ id: string; ref: ErrorRef | null }> = [];
  for (const failure of Array.isArray(input.failures) ? input.failures : []) { if (failure?.scope === null || typeof failure?.scope !== "object") continue; const id = failureIdentity(failure.scope); observed.push({ id, ref: errorRef(failure.scope) }); if (text(failure.eventId) !== "") derived.set(failure.eventId, id); }
  for (const trace of Array.isArray(input.retryTraces) ? input.retryTraces : []) { const id = FAILURE_ID.test(text(trace?.failure_id)) ? String(trace?.failure_id) : ""; if (id !== "" || trace?.error_ref !== undefined) observed.push({ id, ref: trace?.error_ref ?? null }); } // E07's safe error_ref links an observation to the cause it names
  const rows: EvidenceRow[] = []; let refused = 0;
  for (const row of Array.isArray(input.occurrences) ? input.occurrences : []) { // E04 runs first, so no caller-written string reaches an item unredacted
    const kept = sanitizeForPersistence(row?.occurrence); if (kept === null) { refused++; continue; } // E04 found nothing attributable: counted as refused, never rewritten
    const eventId = text(row?.eventId); const provided = recovery[eventId]; const verdict = provided === undefined ? undefined : classifyRecoveryOutcome(provided); // D04 owns the class, and absent evidence is no class
    if (verdict !== undefined) outcomes.set(eventId, verdict.outcome);
    rows.push({ eventId, occurrence: kept, failureIdentity: FAILURE_ID.test(text(row?.failureIdentity)) ? String(row.failureIdentity) : derived.get(eventId) ?? "", resolution: verdict?.outcome === "recovered" ? "recovered" : "unresolved" });
  }
  const members = new Map<string, EvidenceRow[]>(); for (const row of rows) { const key = errorFingerprint(row.occurrence); members.set(key, [...(members.get(key) ?? []), row]); } // D02's own key, so an item and its cluster cannot disagree
  const items = aggregateErrorOccurrences(rows, { maxEventIds }).clusters.map((cluster) => { const group = members.get(cluster.fingerprint) ?? []; // D03 owns grouping, the duplicate fold and every count
    const rep = [...group].sort((x, y) => (x.occurrence.timestamp < y.occurrence.timestamp ? -1 : x.occurrence.timestamp > y.occurrence.timestamp ? 1 : x.eventId < y.eventId ? -1 : 1))[0]!; // the representative is the earliest occurrence, then the smallest event id
    const evidence = group.map((m) => outcomes.get(m.eventId)).filter((o): o is RecoveryOutcome => o !== undefined); // D04's class where evidence exists
    return { fingerprint: cluster.fingerprint, summary: rep.occurrence.summary, code: rep.occurrence.code, layer: rep.occurrence.layer, severity: rep.occurrence.severity, count: cluster.count, firstSeen: cluster.firstSeen, lastSeen: cluster.lastSeen, // the summary is E04's output already, so it is safe by construction
      versions: { runtime: uniq(group.map((m) => m.occurrence.runtime)), model: uniq(group.map((m) => m.occurrence.model)), quantization: uniq(group.map((m) => m.occurrence.quantization)) }, // distinct affected versions, never a guessed "unknown" member
      failureIds: uniq([...group.map((m) => m.failureIdentity), ...observed.filter((o) => o.ref?.code === rep.occurrence.code && o.ref?.layer === rep.occurrence.layer && o.ref?.severity === rep.occurrence.severity).map((o) => o.id)]), // linked retries: this group's identities plus E07 observations naming the same normalized failure
      correlationIds: uniq(group.flatMap((m) => m.occurrence.correlationIds)), taskIds: idOf(TASK_ID, group.flatMap((m) => m.occurrence.correlationIds)), handoffIds: idOf(HANDOFF_ID, group.flatMap((m) => m.occurrence.correlationIds)), // discoverable, never invented
      outcome: OUTCOME_PRECEDENCE.find((o) => evidence.includes(o)) ?? "unknown", eventIds: cluster.eventIds, eventIdsTruncated: cluster.eventIdsTruncated }; });
  const ordered = items.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : (a.eventIds[0] ?? "") < (b.eventIds[0] ?? "") ? -1 : 1));
  const size = (items: readonly EvidenceItem[]): number => Buffer.byteLength(JSON.stringify(items), "utf8"); const reserve = Buffer.byteLength(JSON.stringify({ version: BUNDLE_VERSION, items: [], dropped: { items: 0, bytes: 0 }, refused, bytes: 0, truncated: true }), "utf8"); // the envelope costs bytes too, so the budget means the items
  const chosen: EvidenceItem[] = []; let droppedItems = 0; let droppedBytes = 0;
  for (const item of ordered) { if (chosen.length >= maxItems) droppedItems++; else if (size([...chosen, item]) > Math.max(0, maxBytes - reserve)) droppedBytes++; else chosen.push(item); }
  return { version: BUNDLE_VERSION, items: chosen, dropped: { items: droppedItems + droppedBytes, bytes: droppedBytes }, refused, bytes: size(chosen), truncated: ordered.length > chosen.length }; // visible truncation: both drop reasons counted, separately and in total
}
