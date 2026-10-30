import { closeSync, existsSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { emitTelemetry } from "../telemetry/sink.ts";

/** `20261030T101500Z`: the compact UTC timestamp used in rotated / superseded names. */
export function compactStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** O_EXCL sidecar lock (`<file>.rotate.lock`) so concurrent processes rotate one at a time. */
function withRotateLock<T>(file: string, run: () => T): T {
  const lock = `${file}.rotate.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); // a crashed holder's lock file
      } catch {
        // raced with the holder releasing it
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the rotation lock ${lock}`);
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
 * Rotate `file` to `<file>.<ISO-compact>.<n>` and return the new name. A target
 * that already exists is never overwritten: `n` counts up to the first free
 * name, so every earlier generation survives. Concurrent processes are
 * serialised by a sidecar lock. `stillNeeded(size)` is re-evaluated under the
 * lock so a process that lost the race does not rotate a fresh file; null is
 * returned then. Real failures (permissions, lock timeout, rename errors)
 * throw: callers must report them, a log that cannot rotate grows without limit.
 */
export function rotateWithoutOverwrite(file: string, stillNeeded?: (size: number) => boolean): string | null {
  return withRotateLock(file, () => {
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
      if (existsSync(target)) continue;
      renameSync(file, target);
      return target;
    }
  });
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
