/**
 * Runtime mutation lock (spec §28): update, reload, rollback, activation and
 * migration exclude each other, in this process (mutex) and across processes
 * sharing an install root (an O_EXCL lock file naming its owner).
 *
 * A lock file whose owning process is gone is stale and is taken over: a Pi
 * killed mid-update must not lock Pi Engineering out forever. "Gone" is judged
 * on the owner's process incarnation (boot id + kernel start time, as the
 * isolation file locks do), not the PID alone: a reused PID must not make a
 * dead owner's lock read busy forever.
 */

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { assessProcess, currentProcessIdentity } from "../runtime/isolation/processIdentity.ts";

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
  /** Owner's process incarnation (absent in locks written by older runtimes). */
  host?: string;
  bootId?: string | null;
  processStartTime?: string | null;
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
    const self = currentProcessIdentity();
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      operation,
      acquiredAt: new Date().toISOString(),
      host: self.host,
      bootId: self.bootId,
      processStartTime: self.processStartTime,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
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
        if (existing && isAlive(existing)) throw new MutationLockBusyError(existing);
        // Unreadable but fresh: a holder between create and write, not garbage.
        if (!existing && ageMs(this.file) < FRESH_MS) throw new MutationLockBusyError(null);
        if (!this.breakStale(existing)) throw new MutationLockBusyError(this.readOwner());
      }
    }
    throw new MutationLockBusyError(this.readOwner());
  }

  /**
   * Remove a stale lock file, but only the one we judged stale.
   *
   * Two processes may both see the same dead owner. Without care, the slower
   * one deletes the file the faster one has just created, and both "hold" the
   * lock. Breaking therefore requires an exclusive claim file, and under that
   * claim the owner is re-read: the file is removed only when it still names
   * the owner we judged dead.
   */
  private breakStale(judged: LockOwner | null, retried = false): boolean {
    const claim = `${this.file}.claim`;
    let fd: number;
    try {
      fd = openSync(claim, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Someone else is breaking it. A claim left by a dead claimant expires,
      // and so does one that never got its content (killed between create and
      // write, disk full): unreadable, but only once no writer can still be
      // filling it in.
      const claimant = readClaimant(claim);
      const age = ageMs(claim);
      if (age === Number.POSITIVE_INFINITY) return retried ? false : this.breakStale(judged, true); // Just went away.
      const expired = claimant === null ? age > FRESH_MS : !isAlive(claimant) && age > FRESH_MS;
      if (!expired) return false;
      try {
        unlinkSync(claim);
      } catch {
        // Raced with another expirer.
      }
      return retried ? false : this.breakStale(judged, true);
    }
    try {
      const self = currentProcessIdentity();
      writeSync(
        fd,
        JSON.stringify({
          pid: self.pid,
          host: self.host,
          bootId: self.bootId,
          processStartTime: self.processStartTime,
        }),
      );
      const now = this.readOwner();
      const same = judged === null ? now === null : now?.token === judged.token;
      if (same) {
        try {
          unlinkSync(this.file);
        } catch {
          // Already gone; the retry creates it.
        }
      }
      return true;
    } finally {
      closeSync(fd);
      try {
        unlinkSync(claim);
      } catch {
        // Already gone.
      }
    }
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
    return !!owner && isAlive(owner);
  }
}

type Claimant = Pick<LockOwner, "pid" | "host" | "bootId" | "processStartTime">;

/** The process named by a claim file, or null when it is unreadable or incomplete. */
function readClaimant(claim: string): Claimant | null {
  let raw: string;
  try {
    raw = readFileSync(claim, "utf8").trim();
  } catch {
    return null;
  }
  // Older runtimes wrote a bare PID.
  if (/^\d+$/.test(raw)) return { pid: Number(raw) };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? (parsed as Claimant) : null;
  } catch {
    return null;
  }
}

/** A just-created lock file may not have its owner written yet. */
const FRESH_MS = 5_000;

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Is the owner's process (that incarnation) still alive? Unknown liveness
 * (another host, /proc hidden, no permission) counts as alive: a lock is
 * never broken without proof that its holder is gone.
 */
function isAlive(owner: Pick<LockOwner, "pid" | "host" | "bootId" | "processStartTime">): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (owner.host === undefined) {
    // Written by an older runtime: only the PID is known.
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  return (
    assessProcess({
      pid: owner.pid,
      host: owner.host,
      bootId: owner.bootId ?? null,
      processStartTime: owner.processStartTime ?? null,
    }).state !== "dead"
  );
}
