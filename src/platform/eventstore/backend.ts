/**
 * EventStore backend contract.
 *
 * Runtime history is authoritative in an append-only store (spec 13: PostgreSQL
 * is authoritative; spec 18: roll out behind compatibility seams). This
 * interface is the compatibility seam: the JSONL backend is the current
 * execution format, an in-memory backend serves tests, and a Postgres-backed
 * backend can be dropped in later without touching the domain model.
 *
 * The existing single-project `src/ledger/EventStore.ts` is a JSONL append-only
 * store; `LedgerEventStoreBackend` adapts it into this contract so both
 * execution paths share one event model.
 */

/** An event is an immutable, ordered, append-only record. */
export interface StoredEvent {
  event_id: string;
  timestamp: string;
  type: string;
  /** Canonical project scope (may be null for workspace-level events). */
  project_id: string | null;
  run_id: string | null;
  worker_id: string | null;
  payload: Record<string, unknown>;
}

export interface EventStoreBackend {
  /** Append a single event; returns the stored event. Must be serialized/atomic. */
  append(event: StoredEvent): Promise<StoredEvent>;
  /** Append many events as one write. */
  appendAll(events: StoredEvent[]): Promise<void>;
  /** All events in append order. */
  all(): StoredEvent[];
  get(eventId: string): StoredEvent | undefined;
  count(): number;
}
