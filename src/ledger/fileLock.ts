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

/**
 * Atomically move a stale lock aside (only one reclaimer wins), then drop it.
 *
 * Residual window, deliberately accepted. POSIX has no atomic "unlink this path only if it still holds THIS content",
 * so a reclaimer judges (read) and then acts (rename) in two steps. If, between them, the judged lock is released and a
 * new owner A creates a fresh one, `rename` captures A's live lock. The code then notices (content differs) and puts it
 * back with `link`, which never overwrites. The remaining hazard is a third process B creating the lock in the instant
 * between the rename and the link: then `link` fails, A's lock is dropped and A and B overlap for one critical section.
 * Reaching it needs ALL of: a lock older than `staleMs` (default 30 s) or whose owner died, that lock released or
 * replaced in the microseconds between two adjacent syscalls, a new owner in that same gap, and a third contender in
 * the next one. For a dead owner (same host, pid gone) it cannot happen at all, because nobody can release or replace
 * the judged lock but another reclaimer, and a loser's rename fails with ENOENT. Every append is also re-judged by
 * its own idempotency/revision fence under the lock, so an overlap can at worst duplicate-order two appends of
 * different writers, not corrupt a line (appends are single `write(2)` calls in O_APPEND mode).
 * The check is deliberately not hardened with a second lock: that lock would need its own stale reclaim and so
 * would just move the same window. `@internal`, exported for tests.
 */
export function reclaimStaleLock(path: string, stale: { raw: string }): "removed" | "restored" | "lost" | "raced" {
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    return "raced"; // another reclaimer or the owner got there first
  }
  let outcome: "removed" | "restored" | "lost" = "removed";
  try {
    if (readFileSync(aside, "utf-8") !== stale.raw) {
      // We moved a lock that was re-created after we judged the old one: put it back (never overwrite).
      try {
        linkSync(aside, path);
        outcome = "restored";
      } catch {
        outcome = "lost"; // someone took the lock in the gap; see the residual-window note above
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
  return outcome;
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
      reclaimStaleLock(path, stale);
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
