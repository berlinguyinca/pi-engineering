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
import type { LeaseManager, LeaseOwner } from "./LeaseManager.ts";

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
 * Custody backed by generation-fenced SQLite leases in the machine registry
 * (the normal path). Every claim re-validates against the registry, so a
 * session that lost custody (e.g. it was declared dead while suspended) finds
 * out instead of acting on a stale belief.
 */
export class LeaseMissionCustody implements MissionCustody {
  private readonly leases: () => LeaseManager | null;
  private readonly namespace: string;
  private readonly owner: () => LeaseOwner;
  private readonly held = new Map<string, string>();

  /** `leases` is resolved per call: the registry may be reopened (e.g. relocated state dir). */
  constructor(leases: () => LeaseManager | null, namespace: string, owner: () => LeaseOwner) {
    this.leases = leases;
    this.namespace = namespace;
    this.owner = owner;
  }

  private key(resource: string): string {
    return `${this.namespace}#${resource}`;
  }

  async claim(resource: string): Promise<CustodyClaim> {
    let outcome: ReturnType<LeaseManager["acquire"]>;
    try {
      const leases = this.leases();
      if (!leases) throw new Error("not registered");
      outcome = leases.acquire(this.key(resource), this.owner());
    } catch (error) {
      // Coordination is unreachable right now: act on nothing rather than guess.
      this.held.delete(resource);
      return { ok: false, holder: `registry unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!outcome.ok) {
      this.held.delete(resource);
      return { ok: false, holder: `session ${outcome.holder.sessionId.slice(0, 8)} (pid ${outcome.holder.pid})` };
    }
    this.held.set(resource, outcome.lease.generationId);
    return { ok: true, reclaimed: outcome.reclaimed !== null };
  }

  holds(resource: string): boolean {
    return this.held.has(resource);
  }

  async release(resource: string): Promise<void> {
    const generationId = this.held.get(resource);
    if (!generationId) return;
    this.held.delete(resource);
    try {
      this.leases()?.release(this.key(resource), generationId);
    } catch {
      // An unreleased lease is reclaimed once this session stops heartbeating.
    }
  }

  async releaseAll(): Promise<void> {
    for (const resource of [...this.held.keys()]) await this.release(resource);
  }
}

/**
 * Degraded-mode custody (the registry database is unavailable): one
 * stale-reclaimable process lock per mission in the
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
