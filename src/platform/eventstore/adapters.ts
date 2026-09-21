/**
 * Compatibility adapters between the existing single-project ledger store and
 * the shared platform EventStore backend contract (spec 18: compatibility seams).
 */

import type { LedgerEvent } from "../../core/types.ts";
import type { EventStore } from "../../ledger/EventStore.ts";
import type { EventStoreBackend, StoredEvent } from "./backend.ts";

/** Adapts the existing JSONL `EventStore` into the shared backend contract. */
export class LedgerEventStoreBackend implements EventStoreBackend {
  private readonly store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
    const ledger: LedgerEvent = {
      event_id: event.event_id,
      work_item_id: event.run_id ?? null,
      timestamp: event.timestamp,
      actor: { type: "system" },
      type: event.type as LedgerEvent["type"],
      payload: { ...event.payload, project_id: event.project_id, run_id: event.run_id, worker_id: event.worker_id },
    };
    await this.store.append(ledger);
    return event;
  }

  async appendAll(events: StoredEvent[]): Promise<void> {
    for (const e of events) await this.append(e);
  }

  all(): StoredEvent[] {
    // The ledger store holds LedgerEvent-shaped records; map them back.
    return this.store.all().map((e) => ({
      event_id: e.event_id,
      timestamp: e.timestamp,
      type: e.type,
      project_id: (e.payload.project_id as string | null) ?? null,
      run_id: (e.payload.run_id as string | null) ?? (e.work_item_id as string | null) ?? null,
      worker_id: (e.payload.worker_id as string | null) ?? null,
      payload: e.payload,
    }));
  }

  get(eventId: string): StoredEvent | undefined {
    const e = this.store.get(eventId);
    if (!e) return undefined;
    return {
      event_id: e.event_id,
      timestamp: e.timestamp,
      type: e.type,
      project_id: (e.payload.project_id as string | null) ?? null,
      run_id: (e.payload.run_id as string | null) ?? (e.work_item_id as string | null) ?? null,
      worker_id: (e.payload.worker_id as string | null) ?? null,
      payload: e.payload,
    };
  }

  count(): number {
    return this.store.count();
  }
}
