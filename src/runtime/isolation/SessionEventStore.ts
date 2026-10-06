/**
 * EventStore over per-session append streams with a merged read API.
 *
 * Replaces the single `orchestration.jsonl` + exclusive writer lock. Every
 * session owns exactly one append stream, `events/<session-id>.jsonl`, named by
 * its UUID, so no two processes ever write the same file and no cross-process
 * writer lock exists to contend on. Readers see one logical stream: every file
 * in the namespace merged by timestamp (each file's own order preserved) and
 * de-duplicated by event id.
 *
 * Lines carry an envelope (`session_id`, `worktree_id`, `sequence`) that is
 * stripped on read, so consumers keep the `StoredEvent` contract.
 *
 * Within a process, one instance per stream is shared through a registry on
 * `globalThis`, so an in-process reload of Pi Engineering reuses the live
 * writer instead of opening a duplicate one.
 */
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EventStoreBackend, StoredEvent } from "../../platform/eventstore/backend.ts";
import { readJsonlFrom, repairTornTail } from "./jsonlFiles.ts";
import { emitRuntimeEvent } from "./runtimeEvents.ts";

export interface SessionEventStoreOptions {
  /** Namespace directory holding every session's stream. */
  eventsDir: string;
  sessionId: string;
  worktreeId: string;
  /** Where torn tails are quarantined. Defaults to `<eventsDir>/../recovery`. */
  recoveryDir?: string;
  /**
   * Proves this process still owns the stream's writer generation. Checked
   * before every durable write; a superseded writer (e.g. a pre-reload
   * instance) must not keep appending.
   */
  writerAuthority?: () => boolean;
}

export interface SessionEventStoreDiagnostics {
  files: number;
  corruptLines: number;
  tornTailsSkipped: number;
  repairedTail: { quarantine: string; bytes: number } | null;
}

interface FileCursor {
  offset: number;
}

const REGISTRY_KEY = Symbol.for("pi-engineering.session-event-stores");

interface RegistryEntry {
  store: SessionEventStore;
  references: number;
}

function registry(): Map<string, RegistryEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, RegistryEntry> | undefined>;
  let map = holder[REGISTRY_KEY];
  if (!map) {
    map = new Map();
    holder[REGISTRY_KEY] = map;
  }
  return map;
}

/** k-way merge by timestamp that preserves each source's internal order. */
function mergeStreams(streams: StoredEvent[][]): StoredEvent[] {
  const heads = streams.map(() => 0);
  const out: StoredEvent[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < streams.length; i++) {
      const event = streams[i]![heads[i]!];
      if (!event) continue;
      if (pick < 0 || event.timestamp < streams[pick]![heads[pick]!]!.timestamp) pick = i;
    }
    if (pick < 0) return out;
    out.push(streams[pick]![heads[pick]!]!);
    heads[pick]!++;
  }
}

/** Legacy imports sort first, then session streams by name for a stable tie order. */
function streamOrder(a: string, b: string): number {
  const legacyA = a.startsWith("legacy-");
  const legacyB = b.startsWith("legacy-");
  if (legacyA !== legacyB) return legacyA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listStreamFiles(eventsDir: string): string[] {
  try {
    return readdirSync(eventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort(streamOrder);
  } catch {
    return [];
  }
}

/** Read-only merged view of a namespace (doctor, tooling) — opens no writer. */
export function readMergedEvents(eventsDir: string): StoredEvent[] {
  const seen = new Set<string>();
  const merged: StoredEvent[] = [];
  for (const event of mergeStreams(
    listStreamFiles(eventsDir).map((name) => readJsonlFrom(join(eventsDir, name), 0).events),
  )) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    merged.push(event);
  }
  return merged;
}

export class SessionEventStore implements EventStoreBackend {
  readonly eventsDir: string;
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly ownFile: string;
  private readonly recoveryDir: string;
  private readonly writerAuthority: () => boolean;
  private events: StoredEvent[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  /** Every stream's records in file order, keyed by file: the input of the merged order. */
  private readonly streams = new Map<string, StoredEvent[]>();
  private readonly cursors = new Map<string, FileCursor>();
  private appendChain: Promise<void> = Promise.resolve();
  private sequence = 0;
  private closed = false;
  private diagnosticsState: SessionEventStoreDiagnostics = {
    files: 0,
    corruptLines: 0,
    tornTailsSkipped: 0,
    repairedTail: null,
  };

  private constructor(options: SessionEventStoreOptions) {
    this.eventsDir = options.eventsDir;
    this.sessionId = options.sessionId;
    this.worktreeId = options.worktreeId;
    this.ownFile = join(options.eventsDir, `${options.sessionId}.jsonl`);
    this.recoveryDir = options.recoveryDir ?? join(options.eventsDir, "..", "recovery");
    this.writerAuthority = options.writerAuthority ?? (() => true);
  }

  /**
   * Open (or join) this session's stream in `eventsDir`. Throws only when the
   * namespace cannot be created or read — a genuine filesystem failure.
   */
  static open(options: SessionEventStoreOptions): SessionEventStore {
    const own = join(options.eventsDir, `${options.sessionId}.jsonl`);
    const existing = registry().get(own);
    if (existing && !existing.store.closed) {
      existing.references++;
      return existing.store;
    }
    mkdirSync(options.eventsDir, { recursive: true });
    const store = new SessionEventStore(options);
    store.load();
    registry().set(own, { store, references: 1 });
    return store;
  }

  /** Whether this process currently holds a live writer for the session's stream. */
  static isOpen(eventsDir: string, sessionId: string): boolean {
    const entry = registry().get(join(eventsDir, `${sessionId}.jsonl`));
    return Boolean(entry && !entry.store.closed);
  }

  private load(): void {
    // Our own stream is the only one this process may repair: a torn tail is
    // a write of ours that a crash (or a previous incarnation) interrupted.
    try {
      const repaired = repairTornTail(this.ownFile, this.recoveryDir);
      if (repaired) {
        this.diagnosticsState.repairedTail = repaired;
        emitRuntimeEvent("event_stream.corruption_detected", {
          session_id: this.sessionId,
          worktree_id: this.worktreeId,
          stream: this.ownFile,
          kind: "torn_tail",
        });
        emitRuntimeEvent("event_stream.recovered", {
          session_id: this.sessionId,
          worktree_id: this.worktreeId,
          stream: this.ownFile,
          quarantine: repaired.quarantine,
          bytes: repaired.bytes,
        });
      }
    } catch {
      // Repair is best effort; reading below still ignores the torn tail.
    }
    const streams: StoredEvent[][] = [];
    for (const name of listStreamFiles(this.eventsDir)) {
      const file = join(this.eventsDir, name);
      const result = readJsonlFrom(file, 0);
      this.cursors.set(file, { offset: result.consumedBytes });
      this.diagnosticsState.corruptLines += result.corruptLines;
      if (result.tornTailBytes > 0) this.diagnosticsState.tornTailsSkipped++;
      if (file === this.ownFile) this.sequence = Math.max(result.lastSequence, result.events.length);
      streams.push(result.events);
      this.streams.set(file, [...result.events]);
    }
    this.diagnosticsState.files = this.cursors.size;
    if (this.diagnosticsState.corruptLines > 0) {
      emitRuntimeEvent("event_stream.corruption_detected", {
        session_id: this.sessionId,
        worktree_id: this.worktreeId,
        kind: "malformed_lines_skipped",
        lines: this.diagnosticsState.corruptLines,
      });
    }
    for (const event of mergeStreams(streams)) this.admit(event);
  }

  /** Record an append of this session's own stream (mirrors the file). */
  private admitOwn(event: StoredEvent): void {
    let own = this.streams.get(this.ownFile);
    if (!own) {
      own = [];
      this.streams.set(this.ownFile, own);
    }
    own.push(event);
    this.admit(event);
  }

  private admit(event: StoredEvent): boolean {
    if (this.byId.has(event.event_id)) return false;
    this.events.push(event);
    this.byId.set(event.event_id, event);
    return true;
  }

  /**
   * Read events other sessions appended since the last read. Returned events
   * are already part of `all()`. Incomplete trailing records are left for the
   * next refresh (their writer may still be mid-append).
   */
  refresh(): StoredEvent[] {
    const fresh: StoredEvent[][] = [];
    for (const name of listStreamFiles(this.eventsDir)) {
      const file = join(this.eventsDir, name);
      if (file === this.ownFile) continue;
      const cursor = this.cursors.get(file) ?? { offset: 0 };
      const result = readJsonlFrom(file, cursor.offset);
      cursor.offset = result.consumedBytes;
      this.cursors.set(file, cursor);
      if (result.events.length === 0) continue;
      fresh.push(result.events);
      const stream = this.streams.get(file);
      if (stream) stream.push(...result.events);
      else this.streams.set(file, [...result.events]);
    }
    const admitted = mergeStreams(fresh).filter((event) => this.admit(event));
    // all() keeps the order load() would produce: the k-way timestamp merge of
    // every stream, not "own events first, then whatever arrived later".
    if (admitted.length > 0) this.reorder();
    return admitted;
  }

  /** Rebuild the merged order from every stream, exactly as load() does. */
  private reorder(): void {
    const files = [...this.streams.keys()].sort((a, b) => streamOrder(basename(a), basename(b)));
    const seen = new Set<string>();
    const ordered: StoredEvent[] = [];
    for (const event of mergeStreams(files.map((file) => this.streams.get(file) as StoredEvent[]))) {
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      ordered.push(this.byId.get(event.event_id) ?? event);
    }
    this.events = ordered;
  }

  private envelope(event: StoredEvent): string {
    this.sequence++;
    return `${JSON.stringify({ ...event, session_id: this.sessionId, worktree_id: this.worktreeId, sequence: this.sequence })}\n`;
  }

  private assertWritable(): void {
    if (this.closed) throw new Error("SessionEventStore: append after close");
  }

  private assertAuthority(): void {
    if (!this.writerAuthority()) {
      throw new Error(`SessionEventStore: writer for session ${this.sessionId} was superseded`);
    }
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
    this.assertWritable();
    const line = this.envelope(event);
    const op = this.appendChain.then(async () => {
      this.assertAuthority();
      await appendFile(this.ownFile, line, "utf8");
      this.admitOwn(event);
    });
    this.appendChain = op.catch(() => undefined);
    await op;
    return event;
  }

  async appendConditionally(
    event: StoredEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    this.assertWritable();
    const op = this.appendChain.then((): StoredEvent | undefined => {
      if (!condition()) return undefined;
      this.assertAuthority();
      // Condition, commit, and materialization share one non-yielding section.
      appendFileSync(this.ownFile, this.envelope(event), "utf8");
      this.admitOwn(event);
      onCommit?.();
      return event;
    });
    this.appendChain = op.then(
      () => undefined,
      () => undefined,
    );
    return await op;
  }

  async appendAll(events: StoredEvent[]): Promise<void> {
    this.assertWritable();
    if (events.length === 0) return;
    const body = events.map((event) => this.envelope(event)).join("");
    const op = this.appendChain.then(async () => {
      this.assertAuthority();
      await appendFile(this.ownFile, body, "utf8");
      for (const event of events) this.admitOwn(event);
    });
    this.appendChain = op.catch(() => undefined);
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

  /** This session is the only writer of its stream for as long as it is open. */
  ownsWriterLock(): boolean {
    return !this.closed && this.writerAuthority();
  }

  diagnostics(): SessionEventStoreDiagnostics {
    return { ...this.diagnosticsState };
  }

  /** Wait for queued appends to land. */
  async drain(): Promise<void> {
    await this.appendChain;
  }

  /** Drop one reference; the last one closes the writer. Idempotent. */
  close(): void {
    const entry = registry().get(this.ownFile);
    if (entry?.store === this && entry.references > 1) {
      entry.references--;
      return;
    }
    if (entry?.store === this) registry().delete(this.ownFile);
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
