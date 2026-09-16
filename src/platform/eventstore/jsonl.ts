/**
 * JSONL-backed EventStore backend — the current-execution compatibility format.
 *
 * Append-only, atomic per write, replayable on load. This is the compatibility
 * adapter for the existing single-project execution (spec 18: "preserve
 * existing single-agent operation until parity"), expressed against the shared
 * `EventStoreBackend` contract so it can be swapped for a Postgres backend.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventStoreBackend, StoredEvent } from "./backend.ts";

export class JsonlEventStore implements EventStoreBackend {
  private readonly file: string;
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  /** Serializes concurrent appends so writes + in-memory state stay ordered. */
  private appendChain: Promise<void> = Promise.resolve();
  private readonly memoryOnly: boolean;

  private constructor(file: string, memoryOnly: boolean) {
    this.file = file;
    this.memoryOnly = memoryOnly;
  }

  static async open(file: string): Promise<JsonlEventStore> {
    const store = new JsonlEventStore(file, false);
    await store.load();
    return store;
  }

  /** In-memory JSONL-shaped store (no persistence) for tests and ephemeral use. */
  static inMemory(): JsonlEventStore {
    return new JsonlEventStore("", true);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as StoredEvent;
        this.events.push(evt);
        this.byId.set(evt.event_id, evt);
      } catch {
        // Ignore corrupt lines; keep the rest readable (matches ledger EventStore).
      }
    }
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
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

  async appendAll(events: StoredEvent[]): Promise<void> {
    for (const e of events) await this.append(e);
  }

  all(): StoredEvent[] {
    return this.events.slice();
  }

  get(eventId: string): StoredEvent | undefined {
    return this.byId.get(eventId);
  }

  count(): number {
    return this.events.length;
  }
}
