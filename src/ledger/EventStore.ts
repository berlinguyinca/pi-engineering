import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEvent } from "../core/types.ts";
import { type FileLockOptions, acquireFileLock } from "./fileLock.ts";

export interface EventStoreOptions {
  /** Cross-process lock tuning (file-backed stores only). */
  lock?: FileLockOptions;
  /**
   * Called for each event another process appended since this store last looked.
   * Runs under the append lock, before the append's condition is evaluated.
   */
  onExternal?: (event: LedgerEvent) => void;
}

/**
 * Append-only, JSONL-backed event store (INV-001: state MUST NOT depend on a
 * transcript; INV-012: decisions reconstructable from events).
 *
 * Events are appended atomically and replayed on load to rebuild in-memory
 * materialized state. The event file is the durable source of truth.
 *
 * File-backed appends run under a cross-process lockfile (`<file>.lock`). While
 * holding it the store first reads whatever other processes appended since it
 * last looked, so the append's condition (idempotency, revision and authority
 * fences) is judged against the true tail of the log, not a stale replay.
 */
export class EventStore {
  private readonly file: string;
  private readonly events: LedgerEvent[] = [];
  private readonly byId = new Map<string, LedgerEvent>();
  private readonly options: EventStoreOptions;

  /** Serializes concurrent appends so file writes + in-memory updates stay ordered. */
  private appendChain: Promise<void> = Promise.resolve();
  /** True for in-memory stores (no persistence to disk). */
  private readonly memoryOnly: boolean;
  /** Bytes of the file already reflected in `events`. */
  private offset = 0;
  /** The file ends in a line with no newline (a torn or foreign write): start the next line fresh. */
  private needsNewline = false;

  private constructor(file: string, memoryOnly: boolean, options: EventStoreOptions) {
    this.file = file;
    this.memoryOnly = memoryOnly;
    this.options = options;
  }

  static async create(file: string, options: EventStoreOptions = {}): Promise<EventStore> {
    const store = new EventStore(file, false, options);
    await store.load();
    return store;
  }

  /** In-memory store (no persistence) for tests and ephemeral use. */
  static inMemory(): EventStore {
    return new EventStore("", true, {});
  }

  /** Late-bind the external-event hook (the Ledger needs the store before it can pass its own method). */
  setExternalHandler(handler: (event: LedgerEvent) => void): void {
    this.options.onExternal = handler;
  }

  private async load(): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readFile(this.file);
    } catch {
      // No store yet.
      return;
    }
    this.consume(raw.toString("utf-8"), raw.length, false);
  }

  /** Fold file text into memory. Corrupt lines are skipped; the rest of the store stays readable. */
  private consume(text: string, bytes: number, external: boolean): void {
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of [...lines, tail]) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as LedgerEvent;
        if (this.byId.has(evt.event_id)) continue;
        this.events.push(evt);
        this.byId.set(evt.event_id, evt);
        if (external) this.options.onExternal?.(evt);
      } catch {
        // Ignore corrupt lines.
      }
    }
    this.needsNewline = tail.length > 0;
    this.offset += bytes;
  }

  /** Read what other processes appended since we last looked. Caller holds the lock. */
  private catchUp(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return; // file not created yet
    }
    if (size < this.offset) {
      this.offset = size; // truncated underneath us; nothing new to read
      return;
    }
    if (size === this.offset) return;
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, "r");
    try {
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, this.offset + read);
        if (n === 0) break;
        read += n;
      }
      this.consume(buf.subarray(0, read).toString("utf-8"), read, true);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Append a single event; returns the stored event. Writes are serialized
   * through an internal promise chain so concurrent producers (e.g. parallel
   * tournament candidates) never interleave file writes or reorder the
   * in-memory event list, and through the file lock across processes.
   */
  async append(event: LedgerEvent): Promise<LedgerEvent> {
    await this.appendConditionally(event, () => true);
    return event;
  }

  /**
   * Append unless `condition` is false (resolves undefined, nothing written).
   * `condition` runs under the lock after catching up with other processes, so
   * it sees the whole log; it may throw to reject the append with a typed error.
   * `onCommit` runs synchronously right after the event is durable and indexed.
   */
  async appendConditionally(
    event: LedgerEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<LedgerEvent | undefined> {
    const op = this.appendChain.then(async (): Promise<LedgerEvent | undefined> => {
      if (this.memoryOnly) {
        if (!condition()) return undefined;
        this.record(event, onCommit);
        return event;
      }
      await mkdir(dirname(this.file), { recursive: true });
      const lock = await acquireFileLock(`${this.file}.lock`, this.options.lock);
      try {
        this.catchUp();
        if (!condition()) return undefined;
        const line = `${this.needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`;
        appendFileSync(this.file, line, "utf-8");
        this.offset += Buffer.byteLength(line);
        this.needsNewline = false;
        this.record(event, onCommit);
        return event;
      } finally {
        lock.release();
      }
    });
    this.appendChain = op.then(
      () => undefined,
      () => undefined,
    );
    return await op;
  }

  /**
   * Append several events as ONE unit: one lock acquisition, one catch-up, one `write(2)` for every line. `prepare`
   * runs under the lock after catching up with other processes, so it judges (and may build the events from) the true
   * tail of the log; it returns undefined to write nothing, or throws to reject. All events are appended or none.
   * (A process killed mid-write can still tear the last line, exactly as for a single append; a torn tail is skipped
   * on replay and the next writer starts a fresh line.)
   */
  async appendBatch(
    prepare: () => LedgerEvent[] | undefined,
    onCommit?: (events: LedgerEvent[]) => void,
  ): Promise<LedgerEvent[] | undefined> {
    const op = this.appendChain.then(async (): Promise<LedgerEvent[] | undefined> => {
      const commit = (events: LedgerEvent[]): LedgerEvent[] => {
        for (const e of events) {
          this.events.push(e);
          this.byId.set(e.event_id, e);
        }
        onCommit?.(events);
        return events;
      };
      if (this.memoryOnly) {
        const events = prepare();
        return events && events.length > 0 ? commit(events) : undefined;
      }
      await mkdir(dirname(this.file), { recursive: true });
      const lock = await acquireFileLock(`${this.file}.lock`, this.options.lock);
      try {
        this.catchUp();
        const events = prepare();
        if (!events || events.length === 0) return undefined;
        const body = events.map((e) => `${JSON.stringify(e)}\n`).join("");
        const text = `${this.needsNewline ? "\n" : ""}${body}`;
        appendFileSync(this.file, text, "utf-8");
        this.offset += Buffer.byteLength(text);
        this.needsNewline = false;
        return commit(events);
      } finally {
        lock.release();
      }
    });
    this.appendChain = op.then(
      () => undefined,
      () => undefined,
    );
    return await op;
  }

  private record(event: LedgerEvent, onCommit?: () => void): void {
    this.events.push(event);
    this.byId.set(event.event_id, event);
    onCommit?.();
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
