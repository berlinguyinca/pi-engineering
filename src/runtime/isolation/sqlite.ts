/**
 * Embedded SQLite for coordination state, via Node's built-in `node:sqlite`
 * (no native dependency). WAL journal + busy_timeout so many processes can
 * read concurrently and writers queue instead of failing; every multi-step
 * update runs in a `BEGIN IMMEDIATE` transaction so check-and-set is atomic
 * across processes.
 *
 * node:sqlite is synchronous and runs on Pi's main thread, so every wait for
 * another process's write lock freezes the TUI. Waits are therefore bounded:
 * one statement waits at most `busy_timeout` (DEFAULT_BUSY_TIMEOUT_MS), and a
 * transaction gives up after MAX_SYNC_BLOCK_MS in total (each BEGIN waits only
 * for what is left of that budget) with SqliteBusyError.
 * Callers treat that like any coordination outage (degrade, report the
 * contention) and retry on their next heartbeat, tick or claim.
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

/** Longest one transaction (or one statement) may block the calling (main) thread. */
export const MAX_SYNC_BLOCK_MS = 2_000;
/** Longest one statement waits for a competing writer. */
export const DEFAULT_BUSY_TIMEOUT_MS = MAX_SYNC_BLOCK_MS;

/** The write lock stayed taken for the whole bounded wait. Transient: retry later. */
export class SqliteBusyError extends Error {
  readonly waitedMs: number;
  constructor(waitedMs: number, cause: unknown) {
    super(
      `registry busy: another process held the write lock for ${waitedMs}ms (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "SqliteBusyError";
    this.waitedMs = waitedMs;
  }
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  mkdirSync(dirname(path), { recursive: true });
  const busy = Math.min(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, MAX_SYNC_BLOCK_MS);
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
 * read-then-write cannot be interleaved by another process). A busy write lock
 * is retried with jitter until MAX_SYNC_BLOCK_MS has passed in total, then
 * SqliteBusyError is thrown: the main thread is never blocked longer than that
 * (plus one statement's busy_timeout).
 */
export function immediate<T>(db: Database, fn: () => T, budgetMs = MAX_SYNC_BLOCK_MS): T {
  const started = Date.now();
  // The connection's own setting (openDatabase may have been given another one).
  const configured = busyTimeoutOf(db);
  for (let attempt = 1; ; attempt++) {
    try {
      // SQLite's own wait inside BEGIN must fit the remaining budget too.
      const wait = Math.max(1, Math.min(budgetMs - (Date.now() - started), configured));
      const narrowed = wait < configured;
      if (narrowed) db.exec(`PRAGMA busy_timeout = ${wait}`);
      try {
        db.exec("BEGIN IMMEDIATE");
      } finally {
        if (narrowed) db.exec(`PRAGMA busy_timeout = ${configured}`);
      }
    } catch (error) {
      if (!isBusy(error)) throw error;
      const waited = Date.now() - started;
      const pause = Math.min(5 + Math.floor(Math.random() * 20 * attempt), 100);
      if (waited + pause >= budgetMs) throw new SqliteBusyError(waited, error);
      sleepSync(pause);
      continue;
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

function busyTimeoutOf(db: Database): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
  const value = Number(row?.timeout);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BUSY_TIMEOUT_MS;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function integrityCheck(db: Database): string {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return String(row?.quick_check ?? "unknown");
}
