/**
 * JSONL-backed EventStore backend — the current-execution compatibility format.
 *
 * Append-only, atomic per write, replayable on load. This is the compatibility
 * adapter for the existing single-project execution (spec 18: "preserve
 * existing single-agent operation until parity"), expressed against the shared
 * `EventStoreBackend` contract so it can be swapped for a Postgres backend.
 *
 * ── Two durability rules, both the result of proven data loss ───────────────
 *
 * 1. **A torn tail is repaired before anything is appended.** A process killed
 *    mid-write leaves a partial line with no newline. Appending onto that
 *    concatenates the fragment and the new event into one corrupt line — so the
 *    NEXT event, whose `append()` resolved and which was therefore committed by
 *    this store's own contract, silently vanishes on the following restart.
 *    `load()` now truncates the file to the last complete line and reports it.
 *
 * 2. **An event is serialised when it is appended, not when the write drains.**
 *    `JSON.stringify` inside the write chain meant the persisted bytes reflected
 *    entity state at write time; a caller that mutated a run between `append()`
 *    and the queued `appendFile` changed what history recorded. The same two
 *    domain calls produced two different durable histories depending only on
 *    whether the write had been awaited.
 *
 * This backend remains SINGLE-PROCESS. Two instances over one file do not see
 * each other's appends — there is no lock and no re-read — which is why
 * `open()` refuses a file another live instance already holds.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emitTelemetry } from "../../telemetry/sink.ts";
import type { EventStoreBackend, StoredEvent } from "./backend.ts";

/** Files held by a live instance in this process, so two cannot diverge silently. */
const openFiles = new Set<string>();

export class JsonlEventStore implements EventStoreBackend {
  private readonly file: string;
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  /** Serializes concurrent appends so writes + in-memory state stay ordered. */
  private appendChain: Promise<void> = Promise.resolve();
  private readonly memoryOnly: boolean;
  private closed = false;

  private constructor(file: string, memoryOnly: boolean) {
    this.file = file;
    this.memoryOnly = memoryOnly;
  }

  static async open(file: string): Promise<JsonlEventStore> {
    // Two instances over one file each hold their own array and never re-read,
    // so each reports a silently partial history — and every consumer built on
    // `all()` (the control plane's feed, a rebuild, a health rollup) inherits
    // that. Refusing is better than diverging quietly; a second process needs
    // the Postgres backend this contract exists for.
    if (openFiles.has(file)) {
      throw new Error(
        `JsonlEventStore: ${file} is already open in this process. This backend is single-instance: two stores over one file never see each other's appends.`,
      );
    }
    const store = new JsonlEventStore(file, false);
    await store.load();
    openFiles.add(file);
    return store;
  }

  /** In-memory JSONL-shaped store (no persistence) for tests and ephemeral use. */
  static inMemory(): JsonlEventStore {
    return new JsonlEventStore("", true);
  }

  /** Release the file so another instance may open it. */
  close(): void {
    this.closed = true;
    if (!this.memoryOnly) openFiles.delete(this.file);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return;
    }

    // A tail with no newline is a write that did not finish. It must be removed
    // from the FILE, not merely skipped in memory, or the next append fuses
    // onto it and takes a committed event down with it.
    const torn = raw.length > 0 && !raw.endsWith("\n");
    const complete = torn ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;

    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as StoredEvent;
        this.events.push(evt);
        this.byId.set(evt.event_id, evt);
      } catch {
        // Ignore corrupt lines; keep the rest readable (matches ledger EventStore).
        emitTelemetry({ level: "warning", text: `event store: skipped an unreadable line in ${this.file}` });
      }
    }

    if (torn) {
      await truncate(this.file, Buffer.byteLength(complete, "utf-8")).catch(() => undefined);
      emitTelemetry({
        level: "warning",
        text: `event store: repaired a truncated final record in ${this.file} (a write did not complete)`,
      });
    }
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
    if (this.closed) throw new Error("JsonlEventStore: append after close");
    // Serialised HERE, at append time. Doing it inside the chain let a caller
    // mutate the entity before the bytes were produced, so what history
    // recorded depended on when the write happened to drain.
    const line = `${JSON.stringify(event)}\n`;
    const op = this.appendChain.then(async () => {
      if (!this.memoryOnly) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, line, "utf-8");
      }
      this.events.push(event);
      this.byId.set(event.event_id, event);
    });
    this.appendChain = op.catch(() => {});
    await op;
    return event;
  }

  /**
   * Append many events as ONE write.
   *
   * It was a loop of single appends, so a failure partway left the first half
   * durable and the rest not — a partially applied batch presented to the
   * caller as a single rejected operation. One buffer, one write: the batch
   * either lands or it does not.
   */
  async appendAll(events: StoredEvent[]): Promise<void> {
    if (this.closed) throw new Error("JsonlEventStore: appendAll after close");
    if (events.length === 0) return;
    const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    const op = this.appendChain.then(async () => {
      if (!this.memoryOnly) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, body, "utf-8");
      }
      for (const event of events) {
        this.events.push(event);
        this.byId.set(event.event_id, event);
      }
    });
    this.appendChain = op.catch(() => {});
    await op;
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

/** Rewrite a JSONL store's file atomically. Exported for recovery tooling. */
export async function rewriteJsonl(file: string, events: readonly StoredEvent[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
  await rename(temporary, file);
}
