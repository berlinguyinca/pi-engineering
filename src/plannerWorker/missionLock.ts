/**
 * One live owner per planner-worker mission.
 *
 * Running and resuming a mission rebuild its integration worktree and discard
 * the worktrees of unfinished contracts, so two processes driving the same
 * mission would delete worktrees under each other's live workers. The owner
 * records itself in `<stateDir>/mission.lock` by pid AND process incarnation
 * (boot id + `/proc/<pid>/stat` start time), so a reused pid is not mistaken
 * for the owner. A live (or undeterminable) owner refuses the lock; a dead
 * owner's lock — a crash, a SIGKILL — is reclaimed.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ProcessIdentity, assessProcess, currentProcessIdentity } from "../runtime/isolation/processIdentity.ts";

const LOCK_FILE = "mission.lock";

interface LockRecord extends ProcessIdentity {
  token: string;
  acquired_at: string;
}

export class MissionLockedError extends Error {
  constructor(stateDir: string, holder: LockRecord | null) {
    super(
      holder
        ? `mission in ${stateDir} is being run by pid ${holder.pid} on ${holder.host} (since ${holder.acquired_at}); not resuming it concurrently`
        : `mission in ${stateDir} is locked by another process`,
    );
    this.name = "MissionLockedError";
  }
}

export interface MissionLock {
  /** Remove the lock if it is still ours (a no-op once reclaimed by another owner). */
  release(): Promise<void>;
}

async function readRecord(path: string): Promise<LockRecord | "missing" | "corrupt"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    const r = JSON.parse(text) as Partial<LockRecord>;
    return typeof r.pid === "number" && typeof r.token === "string" && typeof r.host === "string"
      ? (r as LockRecord)
      : "corrupt";
  } catch {
    return "corrupt";
  }
}

/** Take the mission's lock, reclaiming it from a dead owner; throws `MissionLockedError` when held. */
export async function acquireMissionLock(stateDir: string): Promise<MissionLock> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, LOCK_FILE);
  const record: LockRecord = {
    ...currentProcessIdentity(),
    token: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
  // Written in full, then linked into place: the lock never exists half-written.
  const draft = `${path}.${record.token}.tmp`;
  await writeFile(draft, `${JSON.stringify(record)}\n`);
  try {
    for (let tries = 0; tries < 5; tries++) {
      try {
        await link(draft, path);
        return { release: () => releaseIfOwned(path, record.token) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readRecord(path);
      if (holder === "missing") continue;
      if (holder !== "corrupt" && assessProcess(holder).state !== "dead")
        throw new MissionLockedError(stateDir, holder);
      // Reclaim: move the stale lock aside, and make sure it is the one judged
      // dead — a racing claimant may have replaced it meanwhile.
      const aside = `${path}.stale-${record.token}`;
      try {
        await rename(path, aside);
      } catch {
        continue;
      }
      const moved = await readRecord(aside);
      const sameStale =
        holder === "corrupt" ? moved === "corrupt" : typeof moved === "object" && moved.token === holder.token;
      if (!sameStale) {
        // We moved a fresh owner's lock: put it back and yield to it.
        await link(aside, path).catch(() => undefined);
        await rm(aside, { force: true });
        throw new MissionLockedError(stateDir, typeof moved === "object" ? moved : null);
      }
      await rm(aside, { force: true });
    }
    throw new MissionLockedError(stateDir, null);
  } finally {
    await rm(draft, { force: true });
  }
}

async function releaseIfOwned(path: string, token: string): Promise<void> {
  const holder = await readRecord(path).catch(() => "missing" as const);
  if (typeof holder === "object" && holder.token === token) await rm(path, { force: true });
}
