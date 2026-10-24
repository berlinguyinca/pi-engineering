/**
 * Durable local outbox for envelope v2 events (JSONL, append-only).
 *
 * Lines are `{"t":"event","envelope":{...}}` or `{"t":"ack","event_id":"...","s":"delivered"|"dead"}`.
 * Pending = events with no ack, in file order.
 *
 * Performance: an in-memory index (insertion-ordered Map) is built once and then
 * kept current by reading only the bytes appended since the last sync (this also
 * picks up writes from other processes sharing the file). Acks are append-only
 * tombstones; the file is compacted atomically once tombstones outweigh live
 * events. pending()/peek() never rescan the file.
 *
 * Nothing disappears silently: every event that leaves the queue WITHOUT being
 * delivered (server rejection, repeated 5xx, oversize, overflow drop) is first
 * written, with reason / http status / time, to a 0600 dead-letter JSONL file,
 * counted, and reported once per episode through the repo telemetry sink.
 * Files are created 0600 in a 0700 directory; appends are fsynced.
 */

import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { emitTelemetry } from "../../telemetry/sink.ts";
import type { EnvelopeV2 } from "./envelope.ts";
import { atomicWriteFile, cleanupLeakedTmp, withFileLock } from "./portableLock.ts";

export type DeadLetterReason =
  | "server_rejected"
  | "lineage_forbidden"
  | "client_error"
  | "repeated_5xx"
  | "oversized"
  | "overflow_dropped";

export interface OutboxStats {
  pending: number;
  /** Oldest events discarded because the pending cap was exceeded. */
  dropped: number;
  /** Terminal server rejections (400 / 409 / 422). */
  rejected: number;
  /** Dead-lettered for other reasons (other 4xx, repeated 5xx, oversized). */
  deadLettered: number;
}

export interface EnvelopeOutboxOptions {
  file: string;
  /** Pending cap (default 10000). */
  maxPending?: number;
  /** Minimum tombstones before compaction is considered (default 500). */
  compactMinTombstones?: number;
  /** Default `<file minus .jsonl>.deadletter.jsonl`. */
  deadLetterFile?: string;
}

type Line = { t: "event"; envelope: EnvelopeV2 } | { t: "ack"; event_id: string; s?: "delivered" | "dead" };

const RECENT_MAX = 2000;
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export class EnvelopeOutbox {
  readonly file: string;
  readonly deadLetterFile: string;
  dropped = 0;
  rejected = 0;
  deadLettered = 0;

  private readonly maxPending: number;
  private readonly compactMin: number;
  private index = new Map<string, EnvelopeV2>();
  /** Bounded memory of recently completed ids, so a re-stage of one is recognised. */
  private readonly recent = new Map<string, "delivered" | "dead">();
  private offset = 0;
  private ino: number | undefined;
  private tombstones = 0;
  private tornTail = false;
  private episodeLogged = false;
  private prepared = false;

  constructor(opts: EnvelopeOutboxOptions) {
    this.file = opts.file;
    this.deadLetterFile = opts.deadLetterFile ?? `${opts.file.replace(/\.jsonl$/, "")}.deadletter.jsonl`;
    this.maxPending = opts.maxPending ?? 10_000;
    this.compactMin = opts.compactMinTombstones ?? 500;
  }

  stats(): OutboxStats {
    return {
      pending: this.index.size,
      dropped: this.dropped,
      rejected: this.rejected,
      deadLettered: this.deadLettered,
    };
  }

  /** Persist an envelope (fsynced). An id that is already pending returns the existing envelope. */
  append(envelope: EnvelopeV2): Promise<EnvelopeV2> {
    return this.locked(async () => {
      const existing = this.index.get(envelope.event_id);
      if (existing) return existing;
      await this.writeLine({ t: "event", envelope }, true);
      await this.sync();
      while (this.index.size > this.maxPending) {
        const oldest = this.index.values().next().value as EnvelopeV2;
        this.dropped++;
        await this.writeDeadLetter(oldest, "overflow_dropped");
        await this.writeLine({ t: "ack", event_id: oldest.event_id, s: "dead" }, false);
        this.index.delete(oldest.event_id);
        this.tombstones++;
        this.remember(oldest.event_id, "dead");
        this.noteLoss(
          `control-plane outbox full (${this.maxPending}); dropped oldest event (see ${this.deadLetterFile})`,
        );
      }
      return envelope;
    });
  }

  /** Mark delivered. */
  ack(eventId: string): Promise<void> {
    return this.ackMany([eventId]);
  }

  /** Mark several delivered with one lock and one write. */
  ackMany(eventIds: readonly string[]): Promise<void> {
    return this.locked(async () => {
      const ids = eventIds.filter((id) => this.index.has(id));
      if (ids.length === 0) return;
      await this.writeLines(
        ids.map((event_id) => ({ t: "ack", event_id, s: "delivered" }) as Line),
        false,
      );
      for (const id of ids) {
        this.index.delete(id);
        this.tombstones++;
        this.remember(id, "delivered");
      }
      await this.maybeCompact();
    });
  }

  /**
   * Remove an undeliverable event from the queue, preserving it (envelope,
   * reason, http status, time) in the dead-letter file first.
   */
  deadLetter(envelope: EnvelopeV2, reason: DeadLetterReason, httpStatus?: number): Promise<void> {
    return this.locked(async () => {
      await this.writeDeadLetter(envelope, reason, httpStatus);
      if (reason === "server_rejected" || reason === "lineage_forbidden") this.rejected++;
      else this.deadLettered++;
      if (this.index.has(envelope.event_id)) {
        await this.writeLine({ t: "ack", event_id: envelope.event_id, s: "dead" }, false);
        this.index.delete(envelope.event_id);
        this.tombstones++;
      }
      this.remember(envelope.event_id, "dead");
      this.noteLoss(
        `control-plane event ${envelope.event_id} dead-lettered: ${reason}${httpStatus ? ` (http ${httpStatus})` : ""}`,
      );
      await this.maybeCompact();
    });
  }

  /** Record something that never entered the queue (e.g. oversized at stage time). */
  recordUndeliverable(record: unknown, reason: DeadLetterReason): Promise<void> {
    return this.locked(async () => {
      await this.writeDeadLetter(record, reason);
      this.deadLettered++;
      this.noteLoss(`control-plane event dead-lettered at stage time: ${reason}`);
    });
  }

  /** Unsent envelopes in append order (at most `limit`). Never rescans the file. */
  async peek(limit = Number.POSITIVE_INFINITY): Promise<EnvelopeV2[]> {
    await this.sync();
    const out: EnvelopeV2[] = [];
    for (const e of this.index.values()) {
      if (out.length >= limit) break;
      out.push(e);
    }
    return out;
  }

  pending(): Promise<EnvelopeV2[]> {
    return this.peek();
  }

  /** What happened to an id: still queued, delivered, or dead-lettered (recent ids only). */
  async lookup(
    eventId: string,
  ): Promise<{ state: "pending"; envelope: EnvelopeV2 } | { state: "delivered" | "dead" } | undefined> {
    await this.sync();
    const p = this.index.get(eventId);
    if (p) return { state: "pending", envelope: p };
    const r = this.recent.get(eventId);
    return r ? { state: r } : undefined;
  }

  /** Call after a successful delivery so the next loss episode is logged again. */
  markHealthy(): void {
    this.episodeLogged = false;
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.file)).size;
    } catch {
      return 0;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private noteLoss(text: string): void {
    if (this.episodeLogged) return;
    this.episodeLogged = true;
    emitTelemetry({ level: "warning", key: "herdr-outbox-loss", text, detail: this.stats() });
  }

  private remember(id: string, state: "delivered" | "dead"): void {
    this.recent.delete(id);
    this.recent.set(id, state);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value as string);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return serialize(this.file, async () => {
      const dir = dirname(this.file);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!this.prepared) {
        this.prepared = true;
        cleanupLeakedTmp(dir, this.file.slice(dir.length + 1));
      }
      return withFileLock(`${this.file}.lock`, async () => {
        await this.sync();
        return fn();
      });
    });
  }

  private writeLine(line: Line, durable: boolean): Promise<void> {
    return this.writeLines([line], durable);
  }

  private async writeLines(batch: Line[], durable: boolean): Promise<void> {
    const prefix = this.tornTail ? "\n" : ""; // heal a crash-torn tail
    const fh = await open(this.file, "a", 0o600);
    try {
      await fh.write(`${prefix}${batch.map((l) => JSON.stringify(l)).join("\n")}\n`);
      if (durable) await fh.sync();
    } finally {
      await fh.close();
    }
    this.tornTail = false;
    await this.sync();
  }

  private async writeDeadLetter(subject: unknown, reason: DeadLetterReason, httpStatus?: number): Promise<void> {
    const record = {
      at: new Date().toISOString(),
      reason,
      ...(httpStatus ? { http_status: httpStatus } : {}),
      envelope: subject,
    };
    const fh = await open(this.deadLetterFile, "a", 0o600);
    try {
      await fh.write(`${JSON.stringify(record)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private reset(): void {
    this.index = new Map();
    this.offset = 0;
    this.tombstones = 0;
    this.tornTail = false;
  }

  /** Apply only the bytes appended since the last sync. */
  private async sync(): Promise<void> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.reset();
      this.ino = undefined;
      return;
    }
    if (st.ino !== this.ino || st.size < this.offset) {
      this.reset();
      this.ino = st.ino;
    }
    if (st.size === this.offset) return;
    const fh = await open(this.file, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(st.size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    const lastNl = buf.lastIndexOf(10);
    this.tornTail = lastNl < buf.length - 1;
    if (lastNl < 0) return;
    for (const text of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!text) continue;
      let line: Line;
      try {
        line = JSON.parse(text) as Line;
      } catch {
        continue; // torn / corrupt line
      }
      if (line.t === "event" && line.envelope?.event_id) {
        if (!this.index.has(line.envelope.event_id) && !this.recent.has(line.envelope.event_id)) {
          this.index.set(line.envelope.event_id, line.envelope);
        }
      } else if (line.t === "ack") {
        this.tombstones++;
        this.index.delete(line.event_id);
        this.remember(line.event_id, line.s === "dead" ? "dead" : "delivered");
      }
    }
    this.offset += lastNl + 1;
  }

  private async maybeCompact(): Promise<void> {
    if (this.tombstones < this.compactMin || this.tombstones < 2 * this.index.size) return;
    const live = [...this.index.values()];
    const body = live.map((envelope) => `${JSON.stringify({ t: "event", envelope } satisfies Line)}\n`).join("");
    await atomicWriteFile(this.file, body);
    this.ino = undefined; // new inode: next sync rebuilds the (small) index
  }
}
