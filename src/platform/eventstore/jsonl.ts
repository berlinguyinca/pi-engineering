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
 * This backend remains single-writer. A local-filesystem process lock prevents
 * distinct runtimes from opening the same file concurrently; the in-process
 * registry provides the same protection before a second lock attempt.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emitTelemetry } from "../../telemetry/sink.ts";
import type { EventStoreBackend, StoredEvent } from "./backend.ts";
import { ExclusiveFileLock, type FileLockRecoveryHooks, lockHeldByLiveOwner } from "./fileLock.ts";

/** Files held by a live instance in this process, so two cannot diverge silently. */
const openFiles = new Set<string>();

export class JsonlEventStore implements EventStoreBackend {
  private readonly file: string;
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  /** Serializes concurrent appends so writes + in-memory state stay ordered. */
  private appendChain: Promise<void> = Promise.resolve();
  private readonly memoryOnly: boolean;
  private writerLock: ExclusiveFileLock | null = null;
  /** A failed append left a tail that could not be made safe; every append repairs first and throws until it can. */
  private tornTail = false;
  private pendingAppends = 0;
  private closed = false;
  private readOnly = false;

  private constructor(file: string, memoryOnly: boolean) {
    this.file = file;
    this.memoryOnly = memoryOnly;
  }

  static async open(file: string, lockHooks: FileLockRecoveryHooks = {}): Promise<JsonlEventStore> {
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
    store.writerLock = await ExclusiveFileLock.acquire(file, lockHooks);
    try {
      await store.load();
      openFiles.add(file);
      return store;
    } catch (error) {
      store.writerLock.release();
      store.writerLock = null;
      throw error;
    }
  }

  /** In-memory JSONL-shaped store (no persistence) for tests and ephemeral use. */
  /**
   * Replay the file for inspection without the writer lock, torn-tail repair
   * or stale-lock recovery, so a live session that owns the store does not
   * block a diagnostic read. A torn final line is skipped, never truncated.
   * Every append is refused.
   */
  static async openReadOnly(file: string): Promise<JsonlEventStore> {
    const store = new JsonlEventStore(file, false);
    store.readOnly = true;
    const text = await readFile(file, "utf-8");
    const lines = text.split("\n");
    lines.pop(); // text after the last newline is an unfinished write (or empty)
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as StoredEvent;
        if (store.byId.has(evt.event_id)) continue; // a retried append of an earlier, unacknowledged write
        store.events.push(evt);
        store.byId.set(evt.event_id, evt);
      } catch {
        // Unreadable lines are skipped, as in load().
      }
    }
    return store;
  }

  static inMemory(): JsonlEventStore {
    return new JsonlEventStore("", true);
  }

  /** Release the file so another instance may open it. */
  close(): void {
    if (this.closed && this.writerLock === null) return;
    this.closed = true;
    if (this.pendingAppends === 0) this.releaseWriterLock();
  }

  /** True when this backend can prove it owns the local mutation boundary. */
  ownsWriterLock(): boolean {
    return this.memoryOnly || this.writerLock !== null;
  }

  private async load(): Promise<void> {
    // A tail with no newline is a write that did not finish. It must be removed
    // from the FILE, not merely skipped in memory, or the next append fuses
    // onto it and takes a committed event down with it. repairTornTail returns
    // the complete prefix (with any torn tail truncated) to parse.
    const complete = await repairTornTail(this.file, { owner: this.writerLock });
    if (complete === null) return;

    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as StoredEvent;
        if (this.byId.has(evt.event_id)) continue; // a retried append of an earlier, unacknowledged write
        this.events.push(evt);
        this.byId.set(evt.event_id, evt);
      } catch {
        // Ignore corrupt lines; keep the rest readable (matches ledger EventStore).
        emitTelemetry({ level: "warning", text: `event store: skipped an unreadable line in ${this.file}` });
      }
    }
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
    if (this.readOnly) throw new Error("JsonlEventStore: opened read-only");
    if (this.closed) throw new Error("JsonlEventStore: append after close");
    // Serialised HERE, at append time. Doing it inside the chain let a caller
    // mutate the entity before the bytes were produced, so what history
    // recorded depended on when the write happened to drain.
    const line = `${JSON.stringify(event)}\n`;
    this.pendingAppends++;
    const op = this.appendChain
      .then(async () => {
        if (!this.memoryOnly) {
          await mkdir(dirname(this.file), { recursive: true });
          await this.ensureCleanTail();
          try {
            await appendFile(this.file, line, "utf-8");
          } catch (error) {
            // A failed write (ENOSPC/EIO/...) may have left a partial line.
            // Repair the tail so a retried append lands cleanly instead of
            // fusing onto the fragment (the failed head stays queued for the
            // caller's flush() to retry once space frees).
            await this.repairAfterFailedWrite();
            throw error;
          }
        }
        this.events.push(event);
        this.byId.set(event.event_id, event);
      })
      .finally(() => this.appendSettled());
    this.appendChain = op.catch(() => {});
    await op;
    return event;
  }

  async appendConditionally(
    event: StoredEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    if (this.readOnly) throw new Error("JsonlEventStore: opened read-only");
    if (this.closed) throw new Error("JsonlEventStore: append after close");
    const line = `${JSON.stringify(event)}\n`;
    this.pendingAppends++;
    const op = this.appendChain
      .then(async (): Promise<StoredEvent | undefined> => {
        if (!this.memoryOnly) {
          await mkdir(dirname(this.file), { recursive: true });
          await this.ensureCleanTail();
        }
        if (!condition()) return undefined;
        // The predicate and commit intentionally do not yield. Mission authority
        // changes synchronously, so none can interleave this critical section.
        if (!this.memoryOnly) {
          try {
            appendFileSync(this.file, line, "utf-8");
          } catch (error) {
            await this.repairAfterFailedWrite();
            throw error;
          }
        }
        this.events.push(event);
        this.byId.set(event.event_id, event);
        onCommit?.();
        return event;
      })
      .finally(() => this.appendSettled());
    this.appendChain = op.then(
      () => undefined,
      () => undefined,
    );
    return await op;
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
    if (this.readOnly) throw new Error("JsonlEventStore: opened read-only");
    if (this.closed) throw new Error("JsonlEventStore: appendAll after close");
    if (events.length === 0) return;
    // Snapshot replay needs no serialized copy, and a large history can exceed
    // V8's single-string limit. Disk writes still capture bytes before queuing.
    const body = this.memoryOnly ? "" : events.map((event) => `${JSON.stringify(event)}\n`).join("");
    this.pendingAppends++;
    const op = this.appendChain
      .then(async () => {
        if (!this.memoryOnly) {
          await mkdir(dirname(this.file), { recursive: true });
          await this.ensureCleanTail();
          try {
            await appendFile(this.file, body, "utf-8");
          } catch (error) {
            await this.repairAfterFailedWrite();
            throw error;
          }
        }
        for (const event of events) {
          this.events.push(event);
          this.byId.set(event.event_id, event);
        }
      })
      .finally(() => this.appendSettled());
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

  /** After a failed write: repair the tail now; if that fails too, remember it so no append can fuse onto it. */
  private async repairAfterFailedWrite(): Promise<void> {
    try {
      await repairTornTail(this.file, { owner: this.writerLock });
    } catch {
      this.tornTail = true;
    }
  }

  /** Re-run the repair before an append while a previous one failed; throws (surfacing it) until it succeeds. */
  private async ensureCleanTail(): Promise<void> {
    if (!this.tornTail) return;
    await repairTornTail(this.file, { owner: this.writerLock });
    this.tornTail = false;
  }

  private appendSettled(): void {
    this.pendingAppends--;
    if (this.closed && this.pendingAppends === 0) this.releaseWriterLock();
  }

  private releaseWriterLock(): void {
    if (this.memoryOnly) return;
    this.writerLock?.release();
    this.writerLock = null;
    openFiles.delete(this.file);
  }
}

/**
 * Repair a torn tail left by an interrupted write (e.g. ENOSPC mid-append).
 *
 * A failed `appendFile` can leave a partial line with no trailing newline.
 * Appending onto that would FUSE the next event onto the fragment into one
 * corrupt line, so the next committed event silently vanishes on restart.
 * `load()` repairs torn tails at startup; callers invoke this IMMEDIATELY after
 * a failed write so a retried append lands on a clean tail.
 *
 * Returns the file's complete prefix (with any torn tail truncated) for the
 * caller to parse, or `null` when the file is missing/unreadable.
 */
export async function repairTornTail(
  file: string,
  options: { owner?: ExclusiveFileLock | null } = {},
): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    // File missing/unreadable (e.g. never created): nothing to repair.
    return null;
  }
  if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return buf.toString("utf-8");
  const keep = buf.lastIndexOf(0x0a) + 1;
  const complete = buf.subarray(0, keep).toString("utf-8");
  // Ownership gate (FR-05): a torn tail is only TRUNCATED when the caller proves
  // it owns the writer lock, or when no live owner exists. A caller that cannot
  // prove ownership (e.g. recovery tooling reaching a file another live process
  // is still writing) must not truncate — it returns the readable prefix so the
  // caller can still parse, but leaves the file untouched.
  if (!options.owner && (await lockHeldByLiveOwner(file))) {
    emitTelemetry({
      level: "warning",
      text: `event store: refused torn-tail TRUNCATION for ${file}; a live writer owns it (prefix returned, file untouched)`,
    });
    return complete;
  }
  // Quarantine first: the discarded bytes (byte-exact, no decoding) are appended to
  // `<file>.torn-<ts>` and the file is truncated only once they are durable (fail closed).
  const tail = Buffer.from(buf.subarray(keep));
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  let quarantine = `${file}.torn-${stamp}`;
  try {
    // open + write + fsync + close, then fsync the directory entry, BEFORE the truncate.
    // "wx" with a counter: two same-second torn tails never share (and concatenate into) one file.
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let n = 0; handle === undefined; n++) {
      quarantine = `${file}.torn-${stamp}${n === 0 ? "" : `.${n}`}`;
      try {
        handle = await open(quarantine, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      await handle.writeFile(tail);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const dirHandle = await open(dirname(quarantine), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // The quarantine needs a NEW file, which is exactly what ENOSPC refuses. Never leave the
    // fragment unterminated (the next append would fuse onto it and lose a committed event). A bare
    // "\n" could turn a complete-but-unacknowledged event into a VALID line that the caller's retry
    // then duplicates, so the fragment is closed with a sentinel that can never parse as an event:
    // one isolated corrupt line. Nothing is discarded.
    try {
      await appendFile(file, TORN_SENTINEL, "utf-8");
    } catch (error) {
      throw new Error(
        `event store: torn tail of ${file} could neither be quarantined nor terminated: ${error instanceof Error ? error.message : error}`,
      );
    }
    emitTelemetry({
      level: "warning",
      text: `event store: could not quarantine the torn tail of ${file}; the fragment was closed with a sentinel (one corrupt line, no bytes discarded)`,
    });
    return complete;
  }
  // A failed truncate must surface (the store then refuses to append onto the fragment).
  await truncate(file, keep);
  emitTelemetry({
    level: "warning",
    text: `event store: repaired a torn tail in ${file} (discarded bytes kept in ${quarantine})`,
  });
  return complete;
}

/** Closes an unquarantinable torn fragment; the RS control char makes the line unparseable as JSON. */
const TORN_SENTINEL = "\u001e#torn\n";

/** Rewrite a JSONL store's file atomically. Exported for recovery tooling. */
export async function rewriteJsonl(file: string, events: readonly StoredEvent[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
  await rename(temporary, file);
}
