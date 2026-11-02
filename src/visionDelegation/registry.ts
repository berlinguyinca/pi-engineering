/**
 * Persisted map from an original session id to its open vision pane.
 *
 * A JSON file written via temp file and rename, so a crash never leaves a
 * half-written registry. A missing or corrupt file reads as empty and never
 * throws; `set` replaces only that session's entry. Writers serialize their
 * read-modify-write on `<file>.lock` (exclusive create), so two Pi processes
 * never drop each other's entries. `get` is lock-free.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RegistryEntry {
  paneId: string;
  agentName: string;
  sessionDir: string;
  startedAt: string;
  /** Model the pane runs (absent in entries written before reuse existed). */
  model?: { provider: string; id: string };
}

export interface RegistryOptions {
  /** Longest wait for the lock before `set`/`remove` throw. Default 5000. */
  lockTimeoutMs?: number;
  /** Age after which a lock file is treated as abandoned. Default 30000. */
  lockStaleMs?: number;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isEntry(v: unknown): v is RegistryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.paneId === "string" &&
    typeof e.agentName === "string" &&
    typeof e.sessionDir === "string" &&
    typeof e.startedAt === "string"
  );
}

export class VisionRegistry {
  private readonly file: string;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;

  constructor(file: string, options: RegistryOptions = {}) {
    this.file = file;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockStaleMs = options.lockStaleMs ?? 30000;
  }

  get(sessionId: string): RegistryEntry | undefined {
    return this.read().get(sessionId);
  }

  set(sessionId: string, entry: RegistryEntry): void {
    this.locked(() => {
      const all = this.read();
      all.set(sessionId, entry);
      this.write(all);
    });
  }

  remove(sessionId: string): void {
    this.locked(() => {
      const all = this.read();
      if (all.delete(sessionId)) this.write(all);
    });
  }

  private locked(fn: () => void): void {
    const lock = `${this.file}.lock`;
    mkdirSync(dirname(this.file), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx"));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > this.lockStaleMs) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue; // lock vanished between open and stat; retry
        }
        if (Date.now() >= deadline) {
          throw new Error(`vision registry is locked (${lock}); gave up after ${this.lockTimeoutMs}ms`);
        }
        sleep(10);
      }
    }
    try {
      fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // already removed
      }
    }
  }

  private read(): Map<string, RegistryEntry> {
    const out = new Map<string, RegistryEntry>();
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
      for (const [id, entry] of Object.entries(raw)) if (isEntry(entry)) out.set(id, entry);
    } catch {
      return new Map();
    }
    return out;
  }

  private write(all: Map<string, RegistryEntry>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(all), null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
