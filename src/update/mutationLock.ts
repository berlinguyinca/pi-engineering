/**
 * Runtime mutation lock (spec §28): update, reload, rollback, activation and
 * migration exclude each other, in this process (mutex) and across processes
 * sharing an install root (an O_EXCL lock file naming its owner).
 *
 * A lock file whose owning process is gone is stale and is taken over: a Pi
 * killed mid-update must not lock Pi Engineering out forever.
 */

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export class MutationLockBusyError extends Error {
  readonly holder: LockOwner | null;
  constructor(holder: LockOwner | null) {
    super("Pi Engineering runtime update already in progress.");
    this.name = "MutationLockBusyError";
    this.holder = holder;
  }
}

export interface LockOwner {
  pid: number;
  token: string;
  operation: string;
  acquiredAt: string;
}

export interface MutationLockHandle {
  readonly owner: LockOwner;
  release(): void;
}

/** In-process holders by lock file: the mutex half. */
const held = new Map<string, LockOwner>();

export class RuntimeMutationLock {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Acquire or throw MutationLockBusyError. Never waits: a concurrent request is told, not queued. */
  acquire(operation: string): MutationLockHandle {
    if (held.has(this.file)) throw new MutationLockBusyError(held.get(this.file) ?? null);
    const owner: LockOwner = { pid: process.pid, token: randomUUID(), operation, acquiredAt: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, "wx", 0o600);
        try {
          writeSync(fd, `${JSON.stringify(owner)}\n`);
        } finally {
          closeSync(fd);
        }
        held.set(this.file, owner);
        let released = false;
        return {
          owner,
          release: () => {
            if (released) return;
            released = true;
            held.delete(this.file);
            // Only remove our own file: a stale-takeover by another process
            // must not be undone by our late release.
            if (this.readOwner()?.token === owner.token) {
              try {
                unlinkSync(this.file);
              } catch {
                // Already gone.
              }
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = this.readOwner();
        if (existing && isAlive(existing.pid)) throw new MutationLockBusyError(existing);
        // Owner died (or the file is unreadable garbage): stale, take it over.
        try {
          unlinkSync(this.file);
        } catch {
          // Someone else took it over first; the retry decides.
        }
      }
    }
    throw new MutationLockBusyError(this.readOwner());
  }

  /** Who holds the lock, if anyone. */
  readOwner(): LockOwner | null {
    try {
      const owner = JSON.parse(readFileSync(this.file, "utf8")) as LockOwner;
      return typeof owner.pid === "number" && typeof owner.token === "string" ? owner : null;
    } catch {
      return null;
    }
  }

  isHeldByLiveProcess(): boolean {
    const owner = this.readOwner();
    return !!owner && isAlive(owner.pid);
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
