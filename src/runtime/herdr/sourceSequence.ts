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
  /**
   * Give up acquiring the cross-process lock after this long.
   * Defaults to `resolveSequenceLockMs()` — `PI_ENGINEERING_SEQUENCE_LOCK_MS`, else 5000.
   */
  lockTimeoutMs?: number;
  staleLockMs?: number;
  /**
   * Numbers reserved per persisted write (default 1 = strictly contiguous). A
   * larger block amortizes the fsync; the unused remainder of a block is burned
   * on restart (a gap the server records), never reused.
   */
  blockSize?: number;
  /**
   * Smallest value the next allocation may return, from evidence that survives next to the state file (for example
   * the highest sequence in the outbox). A persisted `next` below it means the state was lost or rolled back
   * (restored snapshot, deleted file): the allocator jumps up instead of re-using numbers the server already holds.
   */
  floor?: () => Promise<number>;
}

interface SequenceState {
  source: string;
  /** The next sequence to hand out. */
  next: number;
}

const chains = new Map<string, Promise<unknown>>();

/** The budget a writer waits for a contended sequence lock when nothing raises it (#683). */
export const SEQUENCE_LOCK_DEFAULT_MS = 5000;

/**
 * How long a control-plane writer waits for a sequence lock it cannot take, in ms.
 *
 * The critical section is a read-modify-write of one small state file behind an fsync, but it
 * runs while a fleet node is doing everything else at once — several agent sessions, CAV
 * browsers, local builds. A holder that is alive is not stale, so a writer whose budget runs
 * out simply refuses to write and the envelope never reaches the outbox; that is correct
 * behaviour, and it is also indistinguishable from a storage outage unless somebody reads the
 * warning (#683).
 *
 * `PI_ENGINEERING_SEQUENCE_LOCK_MS=<positive integer>` sets it per host or process. Anything
 * that is not a positive integer (typo, empty, `0`, negative) falls back to the default, so a
 * malformed value can never make every writer give up instantly — the failure text names this
 * variable, so a silently-ignored value is visible the next time allocation fails.
 */
export function resolveSequenceLockMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PI_ENGINEERING_SEQUENCE_LOCK_MS ?? "").trim();
  if (raw === "") return SEQUENCE_LOCK_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : SEQUENCE_LOCK_DEFAULT_MS;
}

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
  /** Times the persisted state was behind local evidence and was lifted (restore / lost file). */
  regressions = 0;
  private reported = false;
  private cleaned = false;
  private readonly dir: string;
  private readonly file: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs?: number;
  private readonly blockSize: number;
  private readonly floor?: () => Promise<number>;
  private cur = 0;
  private end = 0;

  constructor(opts: SourceSequenceOptions) {
    if (!SOURCE_PATTERN.test(opts.source)) throw new TypeError(`invalid source "${opts.source}"`);
    this.source = opts.source;
    this.dir = opts.dir;
    this.file = join(opts.dir, `sequence-${opts.source}.json`);
    this.lockPath = `${this.file}.lock`;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? resolveSequenceLockMs();
    this.staleLockMs = opts.staleLockMs;
    this.blockSize = Math.max(1, Math.floor(opts.blockSize ?? 1));
    this.floor = opts.floor;
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
            const persisted = await this.readNext();
            const floor = this.floor ? await this.floor() : 0;
            const next = Math.max(persisted, floor);
            if (next > persisted) this.noteRegression(persisted, next);
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
            // Names the budget that ran out and the knob that raises it: "a live holder made me
            // refuse to write" must not read like a storage outage (#683).
            text: `control-plane source_sequence allocation failed: ${(error as Error).message} (waited ${
              this.lockTimeoutMs
            }ms for the "${this.source}" sequence lock; raise it with PI_ENGINEERING_SEQUENCE_LOCK_MS=<ms>, currently ${
              process.env.PI_ENGINEERING_SEQUENCE_LOCK_MS ?? `unset, default ${SEQUENCE_LOCK_DEFAULT_MS}ms`
            })`,
          });
        }
        throw error;
      }
    });
  }

  /**
   * Make sure the next allocation is at least `minNext` (the server's high-water mark + 1, learned after a 409).
   * Persisted atomically; any unused part of a reserved block is burned.
   */
  advanceTo(minNext: number): Promise<number> {
    return inProcess(this.file, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const next = await withFileLock(
        this.lockPath,
        async () => {
          const persisted = await this.readNext();
          const target = Math.max(persisted, Math.floor(minNext));
          if (target > persisted) {
            await atomicWriteFile(this.file, `${JSON.stringify({ source: this.source, next: target })}\n`);
          }
          return target;
        },
        { timeoutMs: this.lockTimeoutMs, staleMs: this.staleLockMs },
      );
      this.cur = 0;
      this.end = 0;
      return next;
    });
  }

  private noteRegression(persisted: number, lifted: number): void {
    this.regressions++;
    emitTelemetry({
      level: "warning",
      key: "herdr-sequence-regress",
      text: `control-plane source_sequence state for "${this.source}" was behind the outbox (${persisted} < ${lifted}): the state file was lost or restored from an older copy; continuing from ${lifted}`,
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
