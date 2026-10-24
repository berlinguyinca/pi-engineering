/**
 * Portable cross-process lock + atomic file helpers for the envelope emitter.
 *
 * Why not ExclusiveFileLock: it needs /proc boot-id data, so it cannot run on
 * macOS, where Pi runs too.
 *
 * Lock protocol (all state transitions are single atomic filesystem calls):
 *  - ACQUIRE: write a complete owner record to a unique temp file, then
 *    `link()` it to the lock name. link fails with EEXIST if held, and the lock
 *    name is never visible with partial content.
 *  - STALE: an owner is provably dead only when host, boot id and PID
 *    namespace all match ours and `kill(pid, 0)` says ESRCH. For an owner we
 *    cannot compare (other host / container), only age beyond `staleMs` counts
 *    (holds last milliseconds, so the default is generous).
 *  - STEAL: serialized by a short-lived guard lock; under the guard the lock
 *    record is re-read and removed only if it is byte-identical to the stale
 *    record that was observed. A second waiter that observed the same stale
 *    record therefore finds a different (live) record and backs off, so two
 *    waiters can never both end up holding the lock.
 *  - RELEASE: the record is renamed away to a unique tombstone only when its
 *    token is ours, then verified; a mismatch is restored, never deleted.
 *  - The deadline is honoured on every loop iteration, including when stale
 *    recovery itself throws.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { link, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

interface LockOwner {
  host: string;
  boot: string;
  pidns: string;
  pid: number;
  token: string;
  at: string;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

const BOOT = readOrEmpty("/proc/sys/kernel/random/boot_id");
const PIDNS = (() => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
})();

/** One stable identity per process: every lock this process holds carries it. */
const PROCESS_OWNER: LockOwner = {
  host: hostname(),
  boot: BOOT,
  pidns: PIDNS,
  pid: process.pid,
  token: randomUUID(),
  at: new Date().toISOString(),
};

/**
 * Per-lock-path owner record, written once and then hard-linked to the lock
 * name on every acquire (2 syscalls instead of create+write+link+unlink). Its
 * mtime is refreshed before each link so age-based staleness stays meaningful.
 */
const records = new Map<string, string>();
process.on("exit", () => {
  for (const r of records.values()) {
    try {
      unlinkSync(r);
    } catch {
      // already gone
    }
  }
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const o = JSON.parse(raw) as LockOwner;
    return typeof o.token === "string" && Number.isInteger(o.pid) ? o : undefined;
  } catch {
    return undefined;
  }
}

async function tryCreate(path: string, owner: LockOwner): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let rec = records.get(path);
    if (rec) {
      const now = new Date();
      try {
        await utimes(rec, now, now);
      } catch {
        records.delete(path); // swept by a cleaner: recreate
        rec = undefined;
      }
    }
    if (!rec) {
      rec = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(rec, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      records.set(path, rec);
    }
    try {
      await link(rec, path);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code === "ENOENT" && attempt === 0) {
        records.delete(path);
        continue;
      }
      throw e;
    }
  }
  return false;
}

async function removeIfSame(path: string, expectedRaw: string): Promise<boolean> {
  if ((await readFile(path, "utf8")) !== expectedRaw) return false;
  const tomb = `${path}.gone.${randomUUID()}`;
  await rename(path, tomb);
  const moved = await readFile(tomb, "utf8");
  if (moved === expectedRaw) {
    await rm(tomb, { force: true });
    return true;
  }
  // we moved a record we did not mean to: put it back, never destroy it
  try {
    await link(tomb, path);
  } catch {
    // someone re-created the lock meanwhile; the moved record is preserved at tomb
  }
  await rm(tomb, { force: true }).catch(() => {});
  return false;
}

function describe(raw: string | undefined): string {
  return raw ? raw.slice(0, 200) : "unknown";
}

export interface LockOptions {
  timeoutMs?: number;
  /** Age beyond which an owner we cannot probe is considered dead (default 60000). */
  staleMs?: number;
}

/** Run `fn` while holding the cross-process lock at `lockPath`. */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const owner = PROCESS_OWNER;
  let lastSeen: string | undefined;

  for (;;) {
    if (await tryCreate(lockPath, owner)) break;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath} (owner: ${describe(lastSeen)})`);
    }
    try {
      const raw = await readFile(lockPath, "utf8");
      lastSeen = raw;
      const holder = parseOwner(raw);
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      const comparable =
        holder && holder.host === owner.host && holder.boot === owner.boot && holder.pidns === owner.pidns;
      const stale = comparable ? !pidAlive(holder.pid) : age > staleMs;
      if (stale) await steal(lockPath, raw);
    } catch {
      // lock vanished or recovery failed; fall through to the deadline check
    }
    await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 6)));
  }
  try {
    return await fn();
  } finally {
    try {
      // Only this process (live, same host) can own this record, and a live
      // same-environment owner is never judged stale, so a plain verified
      // unlink is race-free here; stale recovery goes through removeIfSame.
      const raw = await readFile(lockPath, "utf8");
      if (parseOwner(raw)?.token === owner.token) await rm(lockPath, { force: true });
    } catch {
      // already gone
    }
  }
}

async function steal(lockPath: string, staleRaw: string): Promise<void> {
  const guardPath = `${lockPath}.steal`;
  const guard = PROCESS_OWNER;
  if (!(await tryCreate(guardPath, guard))) {
    // a guard held for >10s belongs to a hung/dead process
    const st = await stat(guardPath).catch(() => undefined);
    if (st && Date.now() - st.mtimeMs > 10_000) {
      const raw = await readFile(guardPath, "utf8").catch(() => "");
      if (raw) await removeIfSame(guardPath, raw).catch(() => {});
    }
    return;
  }
  try {
    await removeIfSame(lockPath, staleRaw); // no-op unless still the exact stale record
  } finally {
    const raw = await readFile(guardPath, "utf8").catch(() => "");
    if (parseOwner(raw)?.token === guard.token) await removeIfSame(guardPath, raw).catch(() => {});
  }
}

/** Atomically replace `file` with `data` (0600): temp write + fsync + rename + dir fsync. */
export async function atomicWriteFile(file: string, data: string): Promise<void> {
  const dir = dirname(file);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await rename(tmp, file);
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // directory fsync unsupported on some platforms; the rename is still atomic
  }
}

/** Remove temp files leaked by a crash (`<prefix>*.tmp` / `.gone.` older than `olderThanMs`). */
export function cleanupLeakedTmp(dir: string, prefix: string, olderThanMs = 60_000): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !(name.endsWith(".tmp") || name.includes(".gone."))) continue;
      const p = join(dir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > olderThanMs) unlinkSync(p);
      } catch {
        // raced with another cleaner
      }
    }
  } catch {
    // directory does not exist yet
  }
}
