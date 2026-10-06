/**
 * Mission custody: which live session may drive (dispatch, supervise, repair)
 * a mission.
 *
 * With per-session event streams, every session in a worktree SEES every
 * mission, but only one session may ACT on a given mission at a time — two
 * supervisors repairing the same mission would split its history. Custody is a
 * cross-process, stale-reclaimable claim per mission. A session that cannot
 * get custody simply leaves the mission to its custodian; when the custodian
 * dies, the claim is reclaimed automatically.
 */
import { join } from "node:path";
import { ExclusiveFileLock } from "../../platform/eventstore/fileLock.ts";

export type CustodyClaim = { ok: true; reclaimed: boolean } | { ok: false; holder: string };

export interface MissionCustody {
  /**
   * Take or confirm custody of a resource (`mission:<id>` or
   * `repository:<repoId>`). Never throws for contention; returns the holder.
   */
  claim(resource: string): Promise<CustodyClaim>;
  holds(resource: string): boolean;
  release(resource: string): Promise<void>;
  releaseAll(): Promise<void>;
}

/**
 * Custody backed by one stale-reclaimable process lock per mission in the
 * namespace's `custody/` directory. The lock records pid + boot id + process
 * start time, so a dead (or PID-reused) holder is reclaimed automatically.
 */
export class FileLockMissionCustody implements MissionCustody {
  private readonly dir: string;
  private readonly held = new Map<string, ExclusiveFileLock>();
  private readonly flights = new Map<string, Promise<CustodyClaim>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  claim(resource: string): Promise<CustodyClaim> {
    if (this.held.has(resource)) return Promise.resolve({ ok: true, reclaimed: false });
    const active = this.flights.get(resource);
    if (active) return active;
    const flight = (async (): Promise<CustodyClaim> => {
      try {
        const lock = await ExclusiveFileLock.acquire(join(this.dir, encodeURIComponent(resource)));
        this.held.set(resource, lock);
        return { ok: true, reclaimed: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Without a verifiable process incarnation (non-Linux) there is no
        // safe cross-process proof either way; behave as a single session.
        if (/trustworthy process incarnation/.test(message)) return { ok: true, reclaimed: false };
        const pid = /pid=(\d+)/.exec(message)?.[1];
        return { ok: false, holder: pid ? `pid ${pid}` : message };
      }
    })().finally(() => this.flights.delete(resource));
    this.flights.set(resource, flight);
    return flight;
  }

  holds(resource: string): boolean {
    return this.held.has(resource);
  }

  async release(resource: string): Promise<void> {
    const lock = this.held.get(resource);
    if (!lock) return;
    this.held.delete(resource);
    lock.release();
  }

  async releaseAll(): Promise<void> {
    for (const resource of [...this.held.keys()]) await this.release(resource);
  }
}

/** Single-process custody (memory-only runtimes): every claim succeeds. */
export class LocalMissionCustody implements MissionCustody {
  private readonly held = new Set<string>();

  async claim(resource: string): Promise<CustodyClaim> {
    this.held.add(resource);
    return { ok: true, reclaimed: false };
  }

  holds(resource: string): boolean {
    return this.held.has(resource);
  }

  async release(resource: string): Promise<void> {
    this.held.delete(resource);
  }

  async releaseAll(): Promise<void> {
    this.held.clear();
  }
}
