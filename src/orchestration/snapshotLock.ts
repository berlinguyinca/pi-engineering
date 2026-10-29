/**
 * Single-writer discipline for the published mission snapshot (#427).
 *
 * A dev box normally runs several `pi` sessions against one project, and each
 * one publishes `<workDir>/orchestration-snapshot.json`. Writes were already
 * atomic (per-pid temp file + rename), so nothing was torn — but atomicity is
 * not ordering: the file ended up holding whichever publisher wrote last, and
 * each publisher only knew its own live missions. A mission that existed, and
 * had blocked, read back as absent minutes later.
 *
 * Merging fixes the content; merging needs a serialised read-modify-write, or
 * two publishers each merge against the pre-merge file and the loss returns.
 * This lock is that serialisation.
 *
 * It **refuses rather than steals**. A live holder is given a bounded wait; only
 * a holder that is provably gone (dead pid, torn file, unreadable pid field)
 * loses the lock. Refusing is cheap here because a skipped publish leaves the
 * snapshot dirty and the next mutation republishes — the alternative, writing
 * over a concurrent merge, silently loses another session's missions.
 */

import { open, readFile, unlink } from "node:fs/promises";

export const SNAPSHOT_LOCK_FILENAME = ".orchestration-snapshot.lock";

export interface SnapshotLockHandle {
  /** Removes the lock only if this handle still owns it. Safe to call twice. */
  release(): Promise<void>;
}

export interface SnapshotLockOptions {
  /** The directory the lock lives in — the same directory as the snapshot. */
  dir: string;
  /** Identity written into the lock (default `process.pid`). */
  pid?: number;
  /** Optional session id, so an operator can tell which `pi` holds it. */
  sessionId?: string;
  /** Liveness probe, injectable so a test can model a dead holder. */
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** How long to wait for a live holder before skipping (default 250ms). */
  waitMs?: number;
  /** Interval between re-checks while waiting (default 25ms). */
  pollMs?: number;
  /**
   * Fallback horizon used ONLY when the holder's liveness cannot be determined
   * (the probe threw, or the lock names no pid). Age alone never proves a lock
   * abandoned while the holder is alive. Default 30s.
   */
  staleMs?: number;
}

interface LockContents {
  pid?: number;
  sessionId?: string;
  token?: string;
  atMs?: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parse(contents: string): LockContents | null {
  try {
    const parsed = JSON.parse(contents) as LockContents;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the publisher lock, or return `null` when a live holder owns it and the
 * wait budget ran out. `null` is a normal outcome, not a failure: the caller
 * leaves the snapshot dirty and republishes on the next mutation.
 */
export async function acquireSnapshotPublisherLock(options: SnapshotLockOptions): Promise<SnapshotLockHandle | null> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isPidAlive ?? defaultIsPidAlive;
  const now = options.now ?? (() => Date.now());
  const waitMs = options.waitMs ?? 250;
  const pollMs = options.pollMs ?? 25;
  const staleMs = options.staleMs ?? 30_000;
  const token = `${pid}-${Math.random().toString(36).slice(2, 10)}`;
  const path = `${options.dir}/${SNAPSHOT_LOCK_FILENAME}`;
  const deadline = now() + Math.max(0, waitMs);

  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid, ...(options.sessionId ? { sessionId: options.sessionId } : {}), token, atMs: now() }),
          "utf8",
        );
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          // Only ever remove the lock this handle wrote. If this publisher was
          // fenced and another session took over, unlinking would destroy theirs.
          try {
            const current = parse(await readFile(path, "utf8"));
            if (current?.token !== token) return;
          } catch {
            return; // gone already
          }
          await unlink(path).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await tryTakeover(path, isAlive, now, staleMs)) continue;
      if (now() >= deadline) return null;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
  }
}

/** True when the existing lock is provably abandoned and was removed. */
async function tryTakeover(
  path: string,
  isAlive: (pid: number) => boolean,
  now: () => number,
  staleMs: number,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return true; // vanished between the failed create and the read
  }
  const parsed = parse(contents);
  // A torn or empty lock file is a crash artifact, not a holder.
  if (!parsed) {
    await unlink(path).catch(() => undefined);
    return true;
  }
  if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) {
    await unlink(path).catch(() => undefined);
    return true;
  }
  let alive: boolean;
  try {
    alive = isAlive(parsed.pid);
  } catch {
    // Liveness unknowable: fall back to age, and only then.
    alive = typeof parsed.atMs === "number" && now() - parsed.atMs <= staleMs;
  }
  if (alive) return false;
  await unlink(path).catch(() => undefined);
  return true;
}
