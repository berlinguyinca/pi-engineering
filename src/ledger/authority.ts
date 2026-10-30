import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type FileLockOptions, acquireFileLock } from "./fileLock.ts";

/**
 * A runtime's `authority_generation` for the Ledger path: a persisted, strictly
 * increasing epoch per ledger file, claimed once when a runtime opens. It is
 * the same idea as MissionStore's lease epochs (the last epoch survives release
 * so a restarted owner can never reuse a token), without a Mission: Ledger
 * work has no Mission lease to borrow a generation from. A process holding an
 * older generation is rejected by the Ledger once a newer one has written to
 * the same work item (`LedgerAuthorityStaleError`).
 *
 * `floor` is the highest generation already recorded in the log, so a lost or
 * reset counter file can never hand out a generation the log already outranks.
 */
export async function claimAuthorityGeneration(ledgerFile: string, floor = 0, lock?: FileLockOptions): Promise<number> {
  const counter = `${ledgerFile}.generation`;
  mkdirSync(dirname(counter), { recursive: true });
  const held = await acquireFileLock(`${counter}.lock`, lock);
  try {
    let current = 0;
    try {
      const n = Number.parseInt(readFileSync(counter, "utf-8").trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) current = n;
    } catch {
      // first claim
    }
    const next = Math.max(current, floor) + 1;
    const tmp = `${counter}.${process.pid}.tmp`;
    writeFileSync(tmp, `${next}\n`);
    renameSync(tmp, counter);
    return next;
  } finally {
    held.release();
  }
}
