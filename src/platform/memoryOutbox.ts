/**
 * OpenViking emergency offline outbox (spec 07).
 *
 * "Explicit emergency offline mode uses a durable outbox; autonomous runs do
 * not silently become memoryless." When OpenViking is unreachable, memory
 * commits are enqueued durably (JSONL) instead of being dropped, and flushed
 * when the service returns. Redaction is applied before enqueue so secrets
 * never leave the process.
 *
 * ── The durability model, and why it is not an append log ───────────────────
 *
 * The file IS the queue: it holds exactly what has not yet been delivered, and
 * is rewritten atomically (temp + rename) whenever that set shrinks.
 *
 * It was an append log with a side "draining" file, and a fresh-context review
 * proved two ways that loses data:
 *
 *   * nothing ever truncated the log, so every commit ever enqueued was
 *     re-pushed on every restart, forever — silent duplication if `push` is
 *     not idempotent, and an unbounded file either way;
 *   * `load()` renamed the log to a single fixed draining path that nothing
 *     ever read, so a second restart overwrote it and destroyed commits that
 *     `enqueue()` had already accepted as durable.
 *
 * One file with one meaning removes both. The draining path is still READ on
 * load, so an outbox written by the previous design recovers rather than being
 * stranded.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { id } from "../core/ids.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { redactSecrets } from "./redact.ts";

export interface MemoryCommit {
  id: string;
  projectId: string;
  sessionId: string;
  text: string;
  kind: "promotion" | "note" | "decision";
  enqueuedAt: string;
}

export interface OutboxTransport {
  /** Attempt to push a commit to OpenViking. Throws on failure. */
  push(commit: MemoryCommit): Promise<void>;
}

/**
 * Redact secrets before a commit leaves the process (never logs secrets).
 *
 * The rules live in `redact.ts` now: they were applied here and nowhere else,
 * while run goals, worker roles and event payloads reached the store and the
 * control-plane response untouched.
 */
export function redactMemoryText(text: string): string {
  return redactSecrets(text);
}

/**
 * How many undelivered commits may be held before enqueue refuses.
 *
 * A bound is required — an outbox with OpenViking down for a day otherwise
 * grows without limit in both RAM and disk. Refusing is the explicit policy
 * rather than dropping the oldest: this module exists so that memory is not
 * silently lost, and a caller told "no" can react, where a caller whose commit
 * was quietly evicted cannot.
 */
export const DEFAULT_MAX_QUEUE = 10_000;

export interface MemoryOutboxOptions {
  transport: OutboxTransport;
  /** Directory for the durable outbox. Empty = in-memory only (tests). */
  dir?: string;
  flushIntervalMs?: number;
  /** Undelivered commits held before `enqueue` refuses. */
  maxQueue?: number;
}

export class MemoryOutbox {
  private readonly transport: OutboxTransport;
  private readonly dir: string | null;
  private readonly maxQueue: number;
  private readonly queue: MemoryCommit[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  /**
   * Serialises every write to the outbox file.
   *
   * `enqueue` appends and `flush` rewrites; interleaving those two would let an
   * append land in a file that is about to be replaced by a snapshot taken
   * before it, losing the commit.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: MemoryOutboxOptions) {
    this.transport = opts.transport;
    this.dir = opts.dir ?? null;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    // Durability replay happens only via `open()` (async); the sync constructor
    // never touches the disk, so there is no double-load race on recovery.
    if (opts.flushIntervalMs && opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Open an outbox and await replay of the durable queue (recovery path). */
  static async open(opts: MemoryOutboxOptions): Promise<MemoryOutbox> {
    const outbox = new MemoryOutbox({ ...opts, flushIntervalMs: 0 });
    if (opts.dir) await outbox.load();
    if (opts.flushIntervalMs && opts.flushIntervalMs > 0) {
      outbox.timer = setInterval(() => void outbox.flush(), opts.flushIntervalMs);
      outbox.timer.unref?.();
    }
    return outbox;
  }

  /**
   * Recover the undelivered queue.
   *
   * Both files are read: the live one, and the legacy draining path an older
   * build may have left behind. Draining entries come FIRST, because they were
   * enqueued before anything in the current file. Afterwards the two are
   * consolidated into one file, so the second restart has nothing left to lose.
   */
  private async load(): Promise<void> {
    if (!this.dir) return;
    const draining = await this.readEntries(this.drainingPath());
    const live = await this.readEntries(this.filePath());
    if (draining.length === 0 && live.length === 0) return;

    this.queue.push(...draining, ...live);
    // Consolidate before any new write can land, so a crash during recovery
    // leaves one file holding everything rather than two holding halves.
    await this.persist();
    await rm(this.drainingPath(), { force: true }).catch(() => {});
  }

  /** Parse one JSONL file into commits, skipping anything unreadable. */
  private async readEntries(path: string): Promise<MemoryCommit[]> {
    const out: MemoryCommit[] = [];
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return out; // No outbox yet, which is the normal case.
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as MemoryCommit);
      } catch {
        // A torn trailing line from a process killed mid-append. Skipping it
        // is right — it was never a complete commit — but it is reported,
        // because silently losing a memory commit is what this module exists
        // to prevent.
        emitTelemetry({
          level: "warning",
          text: `memory outbox: skipped an unreadable entry in ${path}`,
        });
      }
    }
    return out;
  }

  private filePath(): string {
    return `${this.dir}/memory-outbox.jsonl`;
  }

  /** Legacy path from the append-log design; read on load, never written. */
  private drainingPath(): string {
    return `${this.dir}/memory-outbox-draining.jsonl`;
  }

  async enqueue(commit: Omit<MemoryCommit, "id" | "enqueuedAt"> & { text: string }): Promise<MemoryCommit> {
    if (this.queue.length >= this.maxQueue) {
      throw new Error(
        `memory outbox is full (${this.queue.length} undelivered commits); OpenViking has been unreachable for too long`,
      );
    }
    const entry: MemoryCommit = {
      id: id("MEM"),
      projectId: commit.projectId,
      sessionId: commit.sessionId,
      text: redactMemoryText(commit.text),
      kind: commit.kind,
      enqueuedAt: new Date().toISOString(),
    };
    // Durable FIRST, queued second. The other order meant a failed append left
    // the commit live in the queue while the caller was told it had failed —
    // so a caller that retried delivered it twice.
    if (this.dir) await this.append(entry);
    this.queue.push(entry);
    return entry;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  /** Attempt to flush the whole queue; entries that fail remain for a later retry. */
  async flush(): Promise<{ pushed: number; remaining: number }> {
    if (this.flushing) return { pushed: 0, remaining: this.queue.length };
    this.flushing = true;
    let pushed = 0;
    try {
      while (this.queue.length > 0) {
        const commit = this.queue[0]!;
        try {
          await this.transport.push(commit);
          this.queue.shift();
          pushed++;
        } catch {
          // Leave it queued; a later flush retries. Never silently drop memory.
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
    // The file must shrink with the queue, or a restart re-delivers everything
    // that was already accepted. Rewritten only when something actually left,
    // so a failing flush costs no I/O.
    if (pushed > 0 && this.dir) await this.persist();
    return { pushed, remaining: this.queue.length };
  }

  /** Append one entry, serialised against every other write. */
  private append(entry: MemoryCommit): Promise<void> {
    return this.chain(async () => {
      await mkdir(this.dir as string, { recursive: true });
      await appendFile(this.filePath(), `${JSON.stringify(entry)}\n`, "utf-8");
    });
  }

  /**
   * Replace the file with exactly what is still undelivered.
   *
   * Temp-then-rename: `rename` is atomic on POSIX, so a crash leaves either the
   * old queue or the new one, never a half-written file that would lose the
   * difference.
   */
  private persist(): Promise<void> {
    return this.chain(async () => {
      const dir = this.dir as string;
      await mkdir(dir, { recursive: true });
      const body = this.queue.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      const temporary = `${this.filePath()}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, "utf-8");
        await rename(temporary, this.filePath());
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
  }

  private chain(work: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(work, work);
    // Kept unhandled-safe: the caller awaits `next` and sees the failure, while
    // the chain itself must not carry a rejection into the following write.
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
