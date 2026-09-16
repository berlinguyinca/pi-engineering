/**
 * OpenViking emergency offline outbox (spec 07).
 *
 * "Explicit emergency offline mode uses a durable outbox; autonomous runs do
 * not silently become memoryless." When OpenViking is unreachable, memory
 * commits are enqueued durably (JSONL) instead of being dropped, and flushed
 * when the service returns. Redaction is applied before enqueue so secrets
 * never leave the process.
 */

import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { id } from "../core/ids.ts";

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

const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bearer auth first so its token is consumed before the header rule runs.
  { pattern: /\b(Bearer\s+)\S+/gi, replacement: "$1[REDACTED]" },
  // key=value / key: value, consuming the whole value token.
  {
    pattern: /\b((?:api[_-]?key|secret|password|token|access[_-]?token|authorization))\s*[:=]\s*\S+/gi,
    replacement: "$1: [REDACTED]",
  },
];

/** Redact secrets before a commit leaves the process (never logs secrets). */
export function redactMemoryText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface MemoryOutboxOptions {
  transport: OutboxTransport;
  /** Directory for the durable outbox. Empty = in-memory only (tests). */
  dir?: string;
  flushIntervalMs?: number;
}

export class MemoryOutbox {
  private readonly transport: OutboxTransport;
  private readonly dir: string | null;
  private readonly queue: MemoryCommit[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(opts: MemoryOutboxOptions) {
    this.transport = opts.transport;
    this.dir = opts.dir ?? null;
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

  private async load(): Promise<void> {
    if (!this.dir) return;
    try {
      const raw = await readFile(this.filePath(), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.queue.push(JSON.parse(line) as MemoryCommit);
        } catch {
          /* skip corrupt lines */
        }
      }
      // Move to a draining file so new writes don't mix with replayed ones.
      await rename(this.filePath(), this.drainingPath()).catch(() => {});
    } catch {
      // No outbox yet.
    }
  }

  private filePath(): string {
    return `${this.dir}/memory-outbox.jsonl`;
  }

  private drainingPath(): string {
    return `${this.dir}/memory-outbox-draining.jsonl`;
  }

  async enqueue(commit: Omit<MemoryCommit, "id" | "enqueuedAt"> & { text: string }): Promise<MemoryCommit> {
    const entry: MemoryCommit = {
      id: id("MEM"),
      projectId: commit.projectId,
      sessionId: commit.sessionId,
      text: redactMemoryText(commit.text),
      kind: commit.kind,
      enqueuedAt: new Date().toISOString(),
    };
    this.queue.push(entry);
    if (this.dir) {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.filePath(), `${JSON.stringify(entry)}\n`, "utf-8");
    }
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
    return { pushed, remaining: this.queue.length };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
