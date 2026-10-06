/**
 * Runtime mutation lock (spec §28): update, reload, rollback, activation and
 * migration exclude each other, in this process (mutex) and across processes
 * sharing an install root (a lock file naming its owner).
 *
 * A lock file whose owning process is gone is stale and is taken over: a Pi
 * killed mid-update must not lock Pi Engineering out forever. "Gone" is judged
 * on the owner's process incarnation (boot id + kernel start time, as the
 * isolation file locks do), not the PID alone: a reused PID must not make a
 * dead owner's lock read busy forever.
 *
 * Race-freedom (the same protocol as src/plannerWorker/missionLock.ts): the
 * lock file is never deleted or renamed away by anyone but its owner. A fresh
 * lock is created exclusively (hard link of a fully written draft, or an
 * O_EXCL create where hard links are unsupported). A dead owner's lock is
 * replaced IN PLACE (atomic rename over it) only by the single claimant that
 * exclusively created `<lock>.takeover-<dead token>`, after re-checking under
 * that claim that the lock still names the dead owner. A claim abandoned by a
 * crashed claimant is itself taken over the same way, which leaves it in
 * place so nobody can create it afresh meanwhile. A live claimant's claim is
 * never touched.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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

/** Test seams; production callers omit them. */
export interface MutationLockHooks {
  /** Runs while this process holds the takeover claim, before it replaces the stale lock. */
  afterTakeoverClaimed?: (claim: string) => void;
}

/** In-process holders by lock file: the mutex half. */
const held = new Map<string, LockOwner>();

/**
 * An unreadable (empty or partial) lock or claim younger than this may still
 * be being written by an O_EXCL creator (no hard links, or a writer killed
 * mid-write is indistinguishable for a moment): it is held, not abandoned.
 */
const FRESH_MS = 5_000;

type Read =
  | { kind: "record"; owner: LockOwner }
  | { kind: "missing" }
  | { kind: "corrupt"; token: string; ageMs: number };

function readRecord(path: string): Read {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const owner = value as Partial<LockOwner>;
      if (
        typeof owner.pid === "number" &&
        Number.isInteger(owner.pid) &&
        owner.pid > 0 &&
        typeof owner.token === "string" &&
        owner.token.length > 0
      ) {
        return { kind: "record", owner: owner as LockOwner };
      }
    }
  } catch {
    // Unreadable: judged by age below.
  }
  const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
  return {
    kind: "corrupt",
    token: `corrupt-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    ageMs: Date.now() - mtime,
  };
}

const isDead = (r: Read): boolean =>
  r.kind === "corrupt" ? r.ageMs > FRESH_MS : r.kind === "record" && !isAlive(r.owner);
const tokenOf = (r: Read): string | null =>
  r.kind === "record" ? r.owner.token : r.kind === "corrupt" ? r.token : null;

/** A token as a file-name-safe suffix. */
function suffix(token: string): string {
  return /^[A-Za-z0-9-]{1,64}$/.test(token) ? token : createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Create `path` exclusively with `content`: a hard link of the written draft
 * (never visible half-written), or an O_EXCL create on filesystems without
 * hard links. False when it already exists.
 */
function createExclusive(path: string, draft: string, content: string): boolean {
  try {
    linkSync(draft, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(code ?? "")) throw error;
  }
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Become the single claimant allowed to replace `target`, whose holder (token
 * `deadToken`) is dead. Returns the claim files created, outermost first, or
 * null when a live claimant got there first.
 */
function claimTakeover(target: string, deadToken: string, draft: string, content: string): string[] | null {
  const marker = `${target}.takeover-${suffix(deadToken)}`;
  for (let tries = 0; tries < 5; tries++) {
    if (createExclusive(marker, draft, content)) return [marker];
    const holder = readRecord(marker);
    if (holder.kind === "missing") continue;
    if (!isDead(holder)) return null;
    // A claimant crashed mid-takeover: take over its claim (left in place).
    const inner = claimTakeover(marker, tokenOf(holder) as string, draft, content);
    return inner ? [...inner, marker] : null;
  }
  return null;
}

export class RuntimeMutationLock {
  readonly file: string;
  private readonly hooks: MutationLockHooks;

  constructor(file: string, hooks: MutationLockHooks = {}) {
    this.file = file;
    this.hooks = hooks;
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
    const content = `${JSON.stringify(owner)}\n`;
    mkdirSync(dirname(this.file), { recursive: true });
    const draft = `${this.file}.${owner.token}.tmp`;
    writeFileSync(draft, content, { mode: 0o600 });
    try {
      for (let tries = 0; tries < 5; tries++) {
        if (createExclusive(this.file, draft, content)) return this.handle(owner);
        const holder = readRecord(this.file);
        if (holder.kind === "missing") continue;
        if (!isDead(holder)) throw new MutationLockBusyError(holder.kind === "record" ? holder.owner : null);
        const stale = tokenOf(holder) as string;
        const claims = claimTakeover(this.file, stale, draft, content);
        if (!claims) throw new MutationLockBusyError(null);
        try {
          this.hooks.afterTakeoverClaimed?.(claims[0] as string);
          // Exclusive claimant now: replace the lock only if it still names the dead owner.
          if (tokenOf(readRecord(this.file)) !== stale) continue;
          const replacement = `${draft}.replace`;
          writeFileSync(replacement, content, { mode: 0o600 });
          renameSync(replacement, this.file);
          return this.handle(owner);
        } finally {
          // Only after the lock was replaced (or found changed): a later
          // claimant re-checks the lock and finds it no longer names the dead owner.
          for (const file of claims) rmSync(file, { force: true });
        }
      }
      throw new MutationLockBusyError(this.readOwner());
    } finally {
      rmSync(draft, { force: true });
    }
  }

  private handle(owner: LockOwner): MutationLockHandle {
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
        if (this.readOwner()?.token === owner.token) rmSync(this.file, { force: true });
      },
    };
  }

  /** Who holds the lock, if anyone. */
  readOwner(): LockOwner | null {
    try {
      const r = readRecord(this.file);
      return r.kind === "record" ? r.owner : null;
    } catch {
      return null;
    }
  }

  isHeldByLiveProcess(): boolean {
    const owner = this.readOwner();
    return !!owner && isAlive(owner);
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
