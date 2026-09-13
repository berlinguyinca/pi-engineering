import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEvent } from "../core/types.ts";

/**
 * Append-only, JSONL-backed event store (INV-001: state MUST NOT depend on a
 * transcript; INV-012: decisions reconstructable from events).
 *
 * Events are appended atomically and replayed on load to rebuild in-memory
 * materialized state. The event file is the durable source of truth.
 */
export class EventStore {
  private readonly file: string;
  private readonly events: LedgerEvent[] = [];
  private readonly byId = new Map<string, LedgerEvent>();

  private constructor(file: string) {
    this.file = file;
  }

  static async create(file: string): Promise<EventStore> {
    const store = new EventStore(file);
    await store.load();
    return store;
  }

  /** In-memory store (no persistence) for tests and ephemeral use. */
  static inMemory(): EventStore {
    return new EventStore(":memory:");
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      // No store yet.
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as LedgerEvent;
        this.events.push(evt);
        this.byId.set(evt.event_id, evt);
      } catch {
        // Ignore corrupt lines; keep the rest of the store readable.
      }
    }
  }

  /** Append a single event; returns the stored event. */
  async append(event: LedgerEvent): Promise<LedgerEvent> {
    await mkdir(dirname(this.file), { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    await appendFile(this.file, line, "utf-8");
    this.events.push(event);
    this.byId.set(event.event_id, event);
    return event;
  }

  /** Append many events as one write. */
  async appendAll(events: LedgerEvent[]): Promise<void> {
    for (const e of events) await this.append(e);
  }

  all(): LedgerEvent[] {
    return this.events.slice();
  }

  get(eventId: string): LedgerEvent | undefined {
    return this.byId.get(eventId);
  }

  byWorkItem(workItemId: string): LedgerEvent[] {
    return this.events.filter((e) => e.work_item_id === workItemId);
  }

  count(): number {
    return this.events.length;
  }
}
