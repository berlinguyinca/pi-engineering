/**
 * Embedded SQLite for coordination state, via Node's built-in `node:sqlite`
 * (no native dependency). WAL journal + busy_timeout so many processes can
 * read concurrently and writers queue instead of failing; every multi-step
 * update runs in a `BEGIN IMMEDIATE` transaction so check-and-set is atomic
 * across processes.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

export type Database = DatabaseSyncType;

let databaseClass: (new (path: string, options?: { timeout?: number }) => DatabaseSyncType) | null = null;

/**
 * Load `node:sqlite` without letting its one-time ExperimentalWarning reach
 * the terminal: inside Pi a raw stderr line corrupts the TUI frame.
 */
function sqliteConstructor(): new (path: string, options?: { timeout?: number }) => DatabaseSyncType {
  if (databaseClass) return databaseClass;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const loaded = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string, options?: { timeout?: number }) => DatabaseSyncType;
    };
    databaseClass = loaded.DatabaseSync;
    return databaseClass;
  } finally {
    process.emitWarning = original;
  }
}

export interface OpenDatabaseOptions {
  /** How long a writer waits for a competing transaction before SQLITE_BUSY. */
  busyTimeoutMs?: number;
  /** WAL requires shared memory; on network filesystems use a rollback journal. */
  journalMode?: "WAL" | "DELETE";
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const busy = options.busyTimeoutMs ?? 10_000;
  const DatabaseSync = sqliteConstructor();
  const db = new DatabaseSync(path, { timeout: busy });
  try {
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    const mode = options.journalMode ?? "WAL";
    db.exec(`PRAGMA journal_mode = ${mode}`);
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function journalMode(db: Database): string {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  return String(row?.journal_mode ?? "unknown").toUpperCase();
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

/**
 * Run `fn` inside BEGIN IMMEDIATE (takes the write lock up front, so a
 * read-then-write cannot be interleaved by another process). Busy errors that
 * outlast busy_timeout are retried a few times with jitter.
 */
export function immediate<T>(db: Database, fn: () => T, attempts = 8): T {
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (attempt < attempts && isBusy(error)) {
        sleepSync(5 + Math.floor(Math.random() * 20 * attempt));
        continue;
      }
      throw error;
    }
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already be gone (e.g. after a failed COMMIT).
      }
      throw error;
    }
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function integrityCheck(db: Database): string {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return String(row?.quick_check ?? "unknown");
}
