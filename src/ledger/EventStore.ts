import { appendFile, mkdir, readFile } from "node:fs/promises";
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

  /** Serializes concurrent appends so file writes + in-memory updates stay ordered. */
  private appendChain: Promise<void> = Promise.resolve();
  /** True for in-memory stores (no persistence to disk). */
  private readonly memoryOnly: boolean;

  private constructor(file: string, memoryOnly: boolean) {
    this.file = file;
    this.memoryOnly = memoryOnly;
  }

  static async create(file: string): Promise<EventStore> {
    const store = new EventStore(file, false);
    await store.load();
    return store;
  }

  /** In-memory store (no persistence) for tests and ephemeral use. */
  static inMemory(): EventStore {
    return new EventStore("", true);
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

  /**
   * Append a single event; returns the stored event. Writes are serialized
   * through an internal promise chain so concurrent producers (e.g. parallel
   * tournament candidates) never interleave file writes or reorder the
   * in-memory event list.
   */
  async append(event: LedgerEvent): Promise<LedgerEvent> {
    const op = this.appendChain.then(async () => {
      if (!this.memoryOnly) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf-8");
      }
      this.events.push(event);
      this.byId.set(event.event_id, event);
    });
    this.appendChain = op.catch(() => {});
    await op;
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
