import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

/** Cross-process mutual exclusion for the Ledger's JSONL file (an O_EXCL lockfile). */

export interface FileLockOptions {
  /** How long an acquirer waits for a live holder before giving up. */
  waitMs?: number;
  /** A lock older than this is reclaimed even when its owner looks alive (or lives on another host). */
  staleMs?: number;
  pollMs?: number;
}

export const DEFAULT_LOCK_WAIT_MS = 10_000;
export const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 10;

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquired_at: string;
}

/** The lock could not be taken within the bounded wait. The append did not happen. */
export class LedgerLockTimeoutError extends Error {
  readonly code = "LEDGER_LOCK_TIMEOUT";
  readonly lockPath: string;
  readonly waitedMs: number;
  readonly holder: LockOwner | undefined;
  constructor(lockPath: string, waitedMs: number, holder: LockOwner | undefined) {
    super(
      `ledger lock ${lockPath} still held${holder ? ` by pid ${holder.pid}@${holder.host}` : ""} after ${waitedMs}ms`,
    );
    this.name = "LedgerLockTimeoutError";
    this.lockPath = lockPath;
    this.waitedMs = waitedMs;
    this.holder = holder;
  }
}

export interface FileLock {
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.pid === "number" && typeof value.host === "string" && typeof value.token === "string") {
      return value as LockOwner;
    }
  } catch {
    // Empty or torn: the creator has not finished writing its owner record yet.
  }
  return undefined;
}

/** Judge the lock held at `path`; returns its raw content when it is stale and may be reclaimed. */
function staleContent(path: string, staleMs: number): { raw: string; owner?: LockOwner } | undefined {
  let raw: string;
  let ageMs: number;
  try {
    raw = readFileSync(path, "utf-8");
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined; // released between the failed create and now
  }
  const owner = parseOwner(raw);
  // Same host and the owner process is gone: no age needed. Otherwise only age condemns it.
  if (owner && owner.host === hostname() && !pidAlive(owner.pid)) return { raw, owner };
  if (ageMs > staleMs) return { raw, owner };
  return undefined;
}

/** Atomically move a stale lock aside (only one reclaimer wins), then drop it. */
function reclaim(path: string, stale: { raw: string }): void {
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // another reclaimer or the owner got there first
  }
  try {
    if (readFileSync(aside, "utf-8") !== stale.raw) {
      // We moved a lock that was re-created after we judged the old one: put it back (never overwrite).
      try {
        linkSync(aside, path);
      } catch {
        // someone else already holds a fresh lock; the moved one is theirs to lose
      }
    }
  } catch {
    // unreadable aside: nothing to restore
  }
  try {
    unlinkSync(aside);
  } catch {
    // best effort
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireFileLock(path: string, options: FileLockOptions = {}): Promise<FileLock> {
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const started = Date.now();
  const token = randomBytes(8).toString("hex");
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        const owner: LockOwner = { pid: process.pid, host: hostname(), token, acquired_at: new Date().toISOString() };
        writeSync(fd, JSON.stringify(owner));
      } finally {
        closeSync(fd);
      }
      return {
        release() {
          try {
            // Only remove a lock that is still ours; a reclaimed one belongs to its new holder.
            if (parseOwner(readFileSync(path, "utf-8"))?.token === token) unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stale = staleContent(path, staleMs);
    if (stale) {
      reclaim(path, stale);
      continue;
    }
    const waited = Date.now() - started;
    if (waited >= waitMs) {
      let holder: LockOwner | undefined;
      try {
        holder = parseOwner(readFileSync(path, "utf-8"));
      } catch {
        // gone
      }
      throw new LedgerLockTimeoutError(path, waited, holder);
    }
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
}
