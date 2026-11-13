/** D01 — strictly read-only index of E02/E05 error occurrences over ONE verified namespace: reads go only through `listStreamFiles` + `readJsonlFrom` (both open files `"r"`-only, and `listStreamFiles` answers a missing directory with `[]`), so no writer class is instantiated, no stream is opened for writing, and no directory, lock, recovery file, quarantine or side index is ever created — a filtered read leaves the namespace byte-identical. */
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ERROR_OCCURRENCE_EVENT_TYPE } from "../runtime/isolation/SessionErrorWriter.ts";
import { listStreamFiles } from "../runtime/isolation/SessionEventStore.ts";
import { readJsonlFrom } from "../runtime/isolation/jsonlFiles.ts";
import { type ErrorOccurrence, parseErrorOccurrence } from "./errorEvent.ts";

/** ISO-8601 bounds, host and session are compared on the occurrence's own fields; a request is capped, never unbounded. */
export const DEFAULT_ERROR_INDEX_LIMIT = 500;
export const MAX_ERROR_INDEX_LIMIT = 5000;
export interface ErrorIndexFilter {
  since?: string;
  until?: string;
  host?: string;
  sessionId?: string;
  limit?: number;
}
export interface IndexedErrorOccurrence {
  eventId: string;
  stream: string;
  occurrence: ErrorOccurrence;
}
/** `refused` says why nothing was read (`not-absolute` | `missing` | `not-a-directory`); `skipped` counts what was passed over without repair; occurrences are ordered deterministically by timestamp then event_id. */
export interface ErrorIndex {
  namespaceDir: string;
  refused: string | null;
  occurrences: IndexedErrorOccurrence[];
  scannedStreams: number;
  scannedEvents: number;
  skipped: { foreignType: number; corrupt: number; unparsable: number };
  truncated: boolean;
}

const millis = (value?: string): number | undefined =>
  value === undefined ? undefined : Number.isNaN(Date.parse(value)) ? undefined : Date.parse(value); // an absent or unparsable bound leaves that side unbounded, never widens the scan

/** Every surviving occurrence in one namespace, filtered in memory and capped; nothing outside `namespaceDir` is read. */
export function readHostErrorOccurrences(namespaceDir: string, filter: ErrorIndexFilter = {}): ErrorIndex {
  const skipped = { foreignType: 0, corrupt: 0, unparsable: 0 };
  const empty: ErrorIndex = {
    namespaceDir,
    refused: null,
    occurrences: [],
    scannedStreams: 0,
    scannedEvents: 0,
    skipped,
    truncated: false,
  };
  if (!isAbsolute(namespaceDir)) return { ...empty, refused: "not-absolute" }; // a relative path is refused, never walked
  try {
    if (!statSync(namespaceDir).isDirectory()) return { ...empty, refused: "not-a-directory" };
  } catch {
    return { ...empty, refused: "missing" };
  } // a missing namespace reads empty and creates nothing
  const since = millis(filter.since);
  const until = millis(filter.until);
  const seen = new Set<string>();
  const matched: IndexedErrorOccurrence[] = [];
  let scannedStreams = 0;
  let scannedEvents = 0;
  for (const name of listStreamFiles(namespaceDir)) {
    scannedStreams++;
    const read = readJsonlFrom(join(namespaceDir, name), 0); // complete lines only; a torn tail stays on disk and is counted
    scannedEvents += read.events.length;
    skipped.corrupt += read.corruptLines + (read.tornTailBytes > 0 ? 1 : 0);
    for (const event of read.events) {
      if (event.type !== ERROR_OCCURRENCE_EVENT_TYPE) {
        skipped.foreignType++;
        continue;
      } // incident and other writers' events stay out
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id); // the merged view keeps the first stream's copy of a repeated id
      const parsed = parseErrorOccurrence(event.payload);
      const at = parsed.ok ? Date.parse(parsed.event.timestamp) : Number.NaN;
      if (!parsed.ok || Number.isNaN(at)) {
        skipped.unparsable++;
        continue;
      } // a payload E02 no longer admits is skipped, never repaired
      if (since !== undefined && at < since) continue;
      if (until !== undefined && at > until) continue;
      if (filter.host !== undefined && parsed.event.host !== filter.host) continue;
      if (filter.sessionId !== undefined && parsed.event.sessionId !== filter.sessionId) continue;
      matched.push({ eventId: event.event_id, stream: name, occurrence: parsed.event });
    }
  }
  matched.sort(
    (a, b) =>
      Date.parse(a.occurrence.timestamp) - Date.parse(b.occurrence.timestamp) ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  ); // ordering needs every match, so materializing is bounded after the filter
  const asked = filter.limit ?? DEFAULT_ERROR_INDEX_LIMIT; // a non-finite request falls back to the documented default
  const limit = Number.isFinite(asked)
    ? Math.min(MAX_ERROR_INDEX_LIMIT, Math.max(1, Math.floor(asked)))
    : DEFAULT_ERROR_INDEX_LIMIT;
  return {
    namespaceDir,
    refused: null,
    occurrences: matched.slice(0, limit),
    scannedStreams,
    scannedEvents,
    skipped,
    truncated: matched.length > limit,
  };
}
