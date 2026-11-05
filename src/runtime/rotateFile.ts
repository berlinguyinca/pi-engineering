import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { emitTelemetry } from "../telemetry/sink.ts";

/** `20261030T101500Z`: the compact UTC timestamp used in rotated / superseded names. */
export function compactStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

const LOCK_STALE_MS = 30_000;
/** Rotation is optional (the file just grows a little): never stall a writer for long. */
const OPTIONAL_LOCK_WAIT_MS = 200;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock whose holder (pid recorded in the file) is dead, or that is implausibly old, is stale. */
function lockIsStale(lock: string): boolean {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    return age > LOCK_STALE_MS || (Number.isInteger(pid) && pid > 0 && !pidAlive(pid));
  } catch {
    return false; // vanished or unreadable: the next attempt decides
  }
}

/**
 * O_EXCL sidecar lock (`<file>.rotate.lock`, holder pid inside) so concurrent processes rotate one at a time.
 * Returns undefined when the lock could not be taken within `waitMs`.
 */
function withRotateLock<T>(file: string, waitMs: number, run: () => T): T | undefined {
  const lock = `${file}.rotate.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockIsStale(lock)) {
        try {
          unlinkSync(lock); // a crashed holder's lock file
        } catch {
          // raced with another stealer
        }
        continue;
      }
      if (Date.now() > deadline) return undefined;
      sleep(5);
    }
  }
  try {
    return run();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/**
 * Rotate `file` to `<file>.<ISO-compact>.<n>` and return the new name. The name is claimed with a
 * hard link (EEXIST-safe), so an existing generation is never overwritten, then the original name
 * is unlinked. Concurrent processes are serialised by a sidecar lock. `stillNeeded(size)` is
 * re-evaluated under the lock so a process that lost the race does not rotate a fresh file. Returns
 * null when no rotation happened (file gone, no longer needed, or the lock stayed busy for
 * `waitMs`; rotation is optional and is retried by the next write). Real failures throw.
 */
export function rotateWithoutOverwrite(
  file: string,
  stillNeeded?: (size: number) => boolean,
  waitMs = OPTIONAL_LOCK_WAIT_MS,
): string | null {
  const result = withRotateLock(file, waitMs, () => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // someone else already rotated it
      throw error;
    }
    if (stillNeeded && !stillNeeded(size)) return null;
    const stamp = compactStamp();
    for (let n = 1; ; n++) {
      const target = `${file}.${stamp}.${n}`;
      try {
        linkSync(file, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      unlinkSync(file);
      return target;
    }
  });
  return result ?? null;
}

const reported = new Set<string>();

/**
 * Rotate when `size + incoming > max`; a rotation failure is reported once per file
 * (the file keeps growing until it is fixed) and never thrown to the writer.
 */
export function rotateIfOver(file: string, incoming: number, max: number): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return; // no file yet
  }
  if (size + incoming <= max) return;
  try {
    rotateWithoutOverwrite(file, (current) => current + incoming > max);
  } catch (error) {
    if (reported.has(file)) return;
    reported.add(file);
    emitTelemetry({
      level: "warning",
      text: `log rotation failed for ${file}; it will keep growing until fixed: ${error instanceof Error ? error.message : error}`,
    });
  }
}
