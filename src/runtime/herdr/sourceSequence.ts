/**
 * Persisted, crash-safe, monotonic `source_sequence` allocator.
 *
 * State is one small JSON file per source. Each allocation:
 *   1. serializes in-process (promise chain per file) and across processes
 *      (portableLock: atomic acquire, atomic stale-steal);
 *   2. reads the high-water mark, writes `next + 1` (temp + fsync + rename +
 *      dir fsync), and only THEN returns the number.
 * A crash before the write completes leaves the old mark, so the number was
 * never handed out; a crash after burns the number (a gap the server records)
 * but never reuses one. A corrupt state file is NOT reset to 1: allocation
 * fails closed and the failure is counted and reported once per episode.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { emitTelemetry } from "../../telemetry/sink.ts";
import { SOURCE_PATTERN } from "./envelope.ts";
import { atomicWriteFile, cleanupLeakedTmp, withFileLock } from "./portableLock.ts";

export interface SourceSequenceOptions {
  /** Directory holding this source's state (created on demand, 0700). */
  dir: string;
  source: string;
  /** Give up acquiring the cross-process lock after this long (default 5000). */
  lockTimeoutMs?: number;
  staleLockMs?: number;
  /**
   * Numbers reserved per persisted write (default 1 = strictly contiguous). A
   * larger block amortizes the fsync; the unused remainder of a block is burned
   * on restart (a gap the server records), never reused.
   */
  blockSize?: number;
}

interface SequenceState {
  source: string;
  /** The next sequence to hand out. */
  next: number;
}

const chains = new Map<string, Promise<unknown>>();

function inProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export class SourceSequence {
  readonly source: string;
  /** Allocation attempts that failed (lock timeout, corrupt/unreadable state). */
  failures = 0;
  private reported = false;
  private cleaned = false;
  private readonly dir: string;
  private readonly file: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs?: number;
  private readonly blockSize: number;
  private cur = 0;
  private end = 0;

  constructor(opts: SourceSequenceOptions) {
    if (!SOURCE_PATTERN.test(opts.source)) throw new TypeError(`invalid source "${opts.source}"`);
    this.source = opts.source;
    this.dir = opts.dir;
    this.file = join(opts.dir, `sequence-${opts.source}.json`);
    this.lockPath = `${this.file}.lock`;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    this.staleLockMs = opts.staleLockMs;
    this.blockSize = Math.max(1, Math.floor(opts.blockSize ?? 1));
  }

  /** Allocate the next sequence (first value is 1). Never returns the same value twice. */
  next(): Promise<number> {
    return inProcess(this.file, async () => {
      if (this.cur < this.end) return this.cur++;
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (!this.cleaned) {
          this.cleaned = true;
          cleanupLeakedTmp(this.dir, `sequence-${this.source}.json`);
        }
        const n = await withFileLock(
          this.lockPath,
          async () => {
            const next = await this.readNext();
            const state: SequenceState = { source: this.source, next: next + this.blockSize };
            await atomicWriteFile(this.file, `${JSON.stringify(state)}\n`);
            return next;
          },
          { timeoutMs: this.lockTimeoutMs, staleMs: this.staleLockMs },
        );
        this.reported = false;
        this.cur = n + 1;
        this.end = n + this.blockSize;
        return n;
      } catch (error) {
        this.failures++;
        if (!this.reported) {
          this.reported = true;
          emitTelemetry({
            level: "warning",
            key: "herdr-sequence-failure",
            text: `control-plane source_sequence allocation failed: ${(error as Error).message}`,
          });
        }
        throw error;
      }
    });
  }

  /** The value the next call to {@link next} would return (not reserved). */
  async peek(): Promise<number> {
    return this.readNext();
  }

  private async readNext(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 1;
      throw e;
    }
    let parsed: Partial<SequenceState>;
    try {
      parsed = JSON.parse(raw) as Partial<SequenceState>;
    } catch {
      throw new Error(`source sequence state ${this.file} is corrupt; refusing to restart at 1`);
    }
    if (!Number.isSafeInteger(parsed.next) || (parsed.next as number) < 1) {
      throw new Error(`source sequence state ${this.file} is invalid; refusing to restart at 1`);
    }
    return parsed.next as number;
  }
}
