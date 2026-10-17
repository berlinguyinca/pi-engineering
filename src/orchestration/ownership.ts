import type { MissionCustody } from "../runtime/isolation/MissionCustody.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionLease, RepositoryLease } from "./types.ts";

export interface MissionOwnershipOptions {
  ownerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /**
   * Cross-process custody. With per-session event streams several live
   * sessions see the same missions; only the custodian of a mission (and of a
   * repository) may take a lease on it. Omitted for single-writer stores.
   */
  custody?: MissionCustody;
  /**
   * True when the runtime that holds an in-store lease is provably gone (dead
   * process / unregistered session). Lets the custodian take over at once
   * instead of waiting for the dead owner's lease to expire.
   */
  isOwnerGone?: (ownerId: string) => boolean;
  /**
   * How long to WAIT for custody held by another live session before giving up
   * (default 10 minutes). Contention between concurrent sessions on one machine
   * is normal, and failing the task on the first failed claim turned ordinary
   * queueing into a mission-blocking failure. On exhaustion the error names the
   * holder so the operator can close it or wait, instead of guessing.
   */
  custodyWaitMs?: number;
  /** Interval between custody re-claims while waiting (default 5s). */
  custodyPollMs?: number;
  /** Injectable sleep so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How many CONSECUTIVE lease-renewal failures a live dispatch authority
   * tolerates before invalidating itself (default 3). A single transient renew
   * blip (custody contention, a slow write) must not lapse a healthy controller
   * lease and orphan a running mission; only sustained failure does. The counter
   * resets on the next successful renewal.
   */
  maxConsecutiveRenewFailures?: number;
}

export const missionCustodyKey = (missionId: string): string => `mission:${missionId}`;
export const repositoryCustodyKey = (repoId: string): string => `repository:${repoId}`;

export type OwnershipIdentity = MissionLease | RepositoryLease;

export interface DispatchAuthority {
  readonly missionIdentity: MissionLease;
  readonly repositoryIdentity?: RepositoryLease;
  readonly resumptionGeneration?: number;
  /**
   * The underlying error from the most recent failed renewal. Retained for
   * observability (not cleared on a subsequent successful renewal); a live
   * authority tolerates up to `maxConsecutiveRenewFailures` CONSECUTIVE of
   * these before invalidating itself.
   */
  readonly lastPulseError?: Error;
  assertAuthoritative(): void;
  onInvalidated(listener: (error: Error) => void): void;
  /** Stops renewal and releases repository authority. Release failures are returned, never thrown. */
  close(): Promise<Error | undefined>;
}

function isRepositoryIdentity(identity: OwnershipIdentity): identity is RepositoryLease {
  return "repoId" in identity;
}

/** Durable single-controller leases backed exclusively by MissionStore events. */
const CUSTODY_FIRST_PAUSE_MS = 250;

/** Another mission holds the repository lease: a wait condition, not a failure. */
export class RepositoryLeasedError extends Error {
  readonly repoId: string;
  readonly holderMissionId: string;
  readonly holderOwnerId: string;
  constructor(repoId: string, holderMissionId: string, holderOwnerId: string) {
    super(`repository ${repoId} is leased to mission ${holderMissionId} by ${holderOwnerId}`);
    this.name = "RepositoryLeasedError";
    this.repoId = repoId;
    this.holderMissionId = holderMissionId;
    this.holderOwnerId = holderOwnerId;
  }
}

/**
 * True when a lease renewal failed because the cached fencing identity is stale for the named
 * resource ("stale mission fencing identity ..." / "stale repository fencing identity ...").
 * A stale identity is a PERMANENT mismatch (the lease was re-fenced to a new generation), not a
 * transient blip; callers must re-acquire the lease against the current identity instead of
 * counting it toward the failure threshold.
 */
function isStaleFencingIdentity(error: unknown, resource: "mission" | "repository"): boolean {
  return error instanceof Error && error.message.includes(`stale ${resource} fencing identity`);
}

export class MissionOwnership {
  private readonly store: MissionStore;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxConsecutiveRenewFailures: number;
  private readonly now: () => number;
  private readonly custody: MissionCustody | undefined;
  private readonly isOwnerGone: ((ownerId: string) => boolean) | undefined;
  private readonly custodyWaitMs: number;
  private readonly custodyPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly missionHolders = new Map<string, number>();
  private readonly repositoryHolders = new Map<string, number>();

  constructor(store: MissionStore, options: MissionOwnershipOptions) {
    if (!options.ownerId.trim()) throw new Error("MissionOwnership ownerId is required");
    if (!Number.isFinite(options.leaseMs ?? 30_000) || (options.leaseMs ?? 30_000) <= 0) {
      throw new Error("MissionOwnership leaseMs must be positive");
    }
    this.store = store;
    this.ownerId = options.ownerId;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs <= 0 || this.heartbeatMs >= this.leaseMs) {
      throw new Error("MissionOwnership heartbeatMs must be positive and shorter than leaseMs");
    }
    this.maxConsecutiveRenewFailures = options.maxConsecutiveRenewFailures ?? 3;
    if (!Number.isInteger(this.maxConsecutiveRenewFailures) || this.maxConsecutiveRenewFailures < 1) {
      throw new Error("MissionOwnership maxConsecutiveRenewFailures must be a positive integer");
    }
    this.now = options.now ?? Date.now;
    this.custody = options.custody;
    this.isOwnerGone = options.isOwnerGone;
    this.custodyWaitMs = options.custodyWaitMs ?? 600_000;
    this.custodyPollMs = options.custodyPollMs ?? 5_000;
    if (!Number.isFinite(this.custodyWaitMs) || this.custodyWaitMs < 0) {
      throw new Error("MissionOwnership custodyWaitMs must be a non-negative number");
    }
    if (!Number.isFinite(this.custodyPollMs) || this.custodyPollMs <= 0) {
      throw new Error("MissionOwnership custodyPollMs must be positive");
    }
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  }

  /** A lease held by another runtime that is provably gone counts as expired. */
  private heldByGoneOwner(lease: { ownerId: string }): boolean {
    return lease.ownerId !== this.ownerId && this.isOwnerGone?.(lease.ownerId) === true;
  }

  /** Renewal is only valid while this session still holds custody. */
  private async confirmCustody(resource: string, what: string): Promise<void> {
    if (!this.custody) return;
    const claim = await this.custody.claim(resource);
    if (!claim.ok) throw new Error(`${what} custody was lost to another live session (${claim.holder})`);
  }

  /** Claim custody of a resource and catch up on other sessions' events. */
  private async claimCustody(resource: string, what: string): Promise<void> {
    if (!this.custody) return;
    // Contention is queueing, not failure: wait for the other session to release,
    // then take over. Only an exhausted wait is reported, and it names the holder.
    // The poll budget is counted as well as timed, so the wait is bounded even
    // when the injected clock does not advance (tests, frozen timers).
    const deadline = this.now() + this.custodyWaitMs;
    // Backoff, not a fixed cadence: a release is usually quick, so start with
    // short pauses and grow to the configured poll interval. The ceiling is the
    // same custodyWaitMs; the poll count bound holds even with a frozen clock.
    const firstPauseMs = Math.min(CUSTODY_FIRST_PAUSE_MS, this.custodyPollMs);
    const maxPolls = Math.max(1, Math.ceil(this.custodyWaitMs / firstPauseMs) + 1);
    let backoffMs = firstPauseMs;
    let waitedMs = 0;
    let holder = "";
    for (let poll = 0; poll < maxPolls; poll++) {
      const claim = await this.custody.claim(resource);
      if (claim.ok) {
        this.store.syncExternal();
        return;
      }
      holder = claim.holder;
      if (this.now() >= deadline) break;
      const pause = Math.min(backoffMs, Math.max(1, deadline - this.now()));
      await this.sleep(pause);
      waitedMs += pause;
      backoffMs = Math.min(backoffMs * 2, this.custodyPollMs);
    }
    throw new Error(
      `${what} is in the custody of another live session (${holder}). Waited ${Math.round(
        waitedMs / 1000,
      )}s for it to release. Close that session (or let it finish) and resume this mission.`,
    );
  }

  private releaseCustody(resource: string): void {
    void this.custody?.release(resource).catch(() => undefined);
  }

  /** How often a live controller must renew a lease it holds. */
  get renewalIntervalMs(): number {
    return this.heartbeatMs;
  }

  async maintain(identity: MissionLease, repoId?: string): Promise<DispatchAuthority> {
    const mission = await this.renew(identity);
    const repository = repoId ? await this.acquireRepository(mission, repoId) : undefined;
    return new RenewableDispatchAuthority(this, mission, repository, this.heartbeatMs, this.maxConsecutiveRenewFailures);
  }

  async acquire(missionId: string, options: { resumptionGeneration?: number } = {}): Promise<MissionLease> {
    this.assertWriterAuthority();
    await this.claimCustody(missionCustodyKey(missionId), `mission ${missionId}`);
    const current = this.store.getMissionLease(missionId);
    const now = this.now();
    if (current && !this.isExpired(current, now) && !this.heldByGoneOwner(current)) {
      if (current.ownerId !== this.ownerId) {
        throw new Error(`mission ${missionId} is owned by ${current.ownerId} until ${current.renewBy}`);
      }
      if (
        options.resumptionGeneration !== undefined &&
        (current.resumptionGeneration ?? 0) !== options.resumptionGeneration
      ) {
        this.store.transitionMissionLease("fenced", current);
        for (const repository of this.store.listRepositoryLeases(missionId)) {
          this.store.transitionRepositoryLease("fenced", repository);
        }
        this.missionHolders.delete(this.epochKey(current));
        await this.store.flush();
      } else {
        const renewed = await this.renew(current);
        const key = this.epochKey(renewed);
        this.missionHolders.set(key, (this.missionHolders.get(key) ?? 0) + 1);
        return renewed;
      }
    }
    if (current && this.store.getMissionLease(missionId)) {
      this.store.transitionMissionLease("expired", current);
      for (const repository of this.store.listRepositoryLeases(missionId)) {
        this.store.transitionRepositoryLease("expired", repository);
      }
      await this.store.flush();
    }

    const previous = this.store.getLatestMissionLease(missionId);
    const lease: MissionLease = {
      missionId,
      generation: (previous?.generation ?? 0) + 1,
      ownerId: this.ownerId,
      acquiredAt: new Date(now).toISOString(),
      renewBy: new Date(now + this.leaseMs).toISOString(),
      fencingToken: (previous?.fencingToken ?? 0) + 1,
      resumptionGeneration:
        options.resumptionGeneration ?? this.store.listMissionResumptions(missionId).at(-1)?.generation ?? 0,
    };
    this.store.transitionMissionLease("acquired", lease);
    await this.store.flush();
    this.missionHolders.set(this.epochKey(lease), 1);
    return { ...lease };
  }

  async renew(identity: MissionLease): Promise<MissionLease> {
    await this.confirmCustody(missionCustodyKey(identity.missionId), `mission ${identity.missionId}`);
    const current = this.store.getMissionLease(identity.missionId);
    this.assertSameEpoch(identity, current, "mission");
    const now = this.now();
    if (this.isExpired(current!, now)) {
      this.store.transitionMissionLease("expired", current!);
      for (const repository of this.store.listRepositoryLeases(identity.missionId)) {
        this.store.transitionRepositoryLease("expired", repository);
      }
      await this.store.flush();
      throw new Error(`mission ${identity.missionId} lease expired at ${current!.renewBy}`);
    }
    const renewed = {
      ...current!,
      renewBy: new Date(now + this.leaseMs).toISOString(),
    };
    this.store.transitionMissionLease("renewed", renewed);
    await this.store.flush();
    return { ...renewed };
  }

  async acquireRepository(identity: MissionLease, repoId: string): Promise<RepositoryLease> {
    this.assertWriterAuthority();
    this.assertAuthoritative(identity);
    await this.claimCustody(repositoryCustodyKey(repoId), `repository ${repoId}`);
    const current = this.store.getRepositoryLeaseByRepoId(repoId);
    const now = this.now();
    if (current && !this.isExpired(current, now) && !this.heldByGoneOwner(current)) {
      if (current.missionId !== identity.missionId || current.ownerId !== identity.ownerId) {
        throw new RepositoryLeasedError(repoId, current.missionId, current.ownerId);
      }
      const renewed = await this.renewRepository(current);
      const key = this.repositoryEpochKey(renewed);
      this.repositoryHolders.set(key, (this.repositoryHolders.get(key) ?? 0) + 1);
      return renewed;
    }
    if (current) {
      this.store.transitionRepositoryLease("expired", current);
      await this.store.flush();
    }

    const previous = this.store.getLatestRepositoryLease(repoId);
    const lease: RepositoryLease = {
      missionId: identity.missionId,
      repoId,
      generation: (previous?.generation ?? 0) + 1,
      ownerId: this.ownerId,
      acquiredAt: new Date(now).toISOString(),
      renewBy: new Date(now + this.leaseMs).toISOString(),
      fencingToken: (previous?.fencingToken ?? 0) + 1,
    };
    this.store.transitionRepositoryLease("acquired", lease);
    await this.store.flush();
    this.repositoryHolders.set(this.repositoryEpochKey(lease), 1);
    return { ...lease };
  }

  async renewRepository(identity: RepositoryLease): Promise<RepositoryLease> {
    await this.confirmCustody(repositoryCustodyKey(identity.repoId), `repository ${identity.repoId}`);
    const current = this.store.getRepositoryLeaseByRepoId(identity.repoId);
    this.assertSameEpoch(identity, current, "repository");
    this.assertMissionOwner(identity.missionId, identity.ownerId);
    const now = this.now();
    if (this.isExpired(current!, now)) {
      this.store.transitionRepositoryLease("expired", current!);
      await this.store.flush();
      throw new Error(`repository ${identity.repoId} lease expired at ${current!.renewBy}`);
    }
    const renewed = {
      ...current!,
      renewBy: new Date(now + this.leaseMs).toISOString(),
    };
    this.store.transitionRepositoryLease("renewed", renewed);
    await this.store.flush();
    return { ...renewed };
  }

  async fence(identity: OwnershipIdentity): Promise<void> {
    this.assertAuthoritative(identity);
    if (isRepositoryIdentity(identity)) this.store.transitionRepositoryLease("fenced", identity);
    else this.store.transitionMissionLease("fenced", identity);
    await this.store.flush();
  }

  async release(identity: OwnershipIdentity): Promise<void> {
    const current = isRepositoryIdentity(identity)
      ? this.store.getRepositoryLeaseByRepoId(identity.repoId)
      : this.store.getMissionLease(identity.missionId);
    if (!current) return;
    this.assertAuthoritative(identity);
    if (isRepositoryIdentity(identity)) {
      const key = this.repositoryEpochKey(identity);
      const holders = this.repositoryHolders.get(key) ?? 1;
      if (holders > 1) {
        this.repositoryHolders.set(key, holders - 1);
        return;
      }
      this.repositoryHolders.delete(key);
      this.store.transitionRepositoryLease("fenced", identity);
    } else {
      const key = this.epochKey(identity);
      const holders = this.missionHolders.get(key) ?? 1;
      if (holders > 1) {
        this.missionHolders.set(key, holders - 1);
        return;
      }
      this.missionHolders.delete(key);
      this.store.transitionMissionLease("fenced", identity);
    }
    await this.store.flush();
    // Custody follows the durable lease: once it is fenced and flushed, another
    // live session may take the resource over.
    this.releaseCustody(
      isRepositoryIdentity(identity) ? repositoryCustodyKey(identity.repoId) : missionCustodyKey(identity.missionId),
    );
  }

  assertAuthoritative(identity: OwnershipIdentity): void {
    if (isRepositoryIdentity(identity)) {
      const current = this.store.getRepositoryLeaseByRepoId(identity.repoId);
      this.assertSameEpoch(identity, current, "repository");
      this.assertNotExpired(current!, "repository", identity.repoId);
      this.assertMissionOwner(identity.missionId, identity.ownerId);
      return;
    }
    const current = this.store.getMissionLease(identity.missionId);
    this.assertSameEpoch(identity, current, "mission");
    const resumptionGeneration = this.store.listMissionResumptions(identity.missionId).at(-1)?.generation ?? 0;
    if ((identity.resumptionGeneration ?? 0) !== resumptionGeneration) {
      throw new Error(
        `stale mission resumption identity for ${identity.missionId}: generation=${identity.resumptionGeneration ?? 0}, current=${resumptionGeneration}`,
      );
    }
    this.assertNotExpired(current!, "mission", identity.missionId);
  }

  private epochKey(identity: MissionLease): string {
    return `${identity.missionId}:${identity.generation}:${identity.fencingToken}`;
  }

  private repositoryEpochKey(identity: RepositoryLease): string {
    return `${identity.missionId}:${identity.repoId}:${identity.generation}:${identity.fencingToken}`;
  }

  private assertMissionOwner(missionId: string, ownerId: string): void {
    const mission = this.store.getMissionLease(missionId);
    if (!mission || mission.ownerId !== ownerId || this.isExpired(mission, this.now())) {
      throw new Error(`stale mission ownership for ${missionId}`);
    }
  }

  private assertSameEpoch(
    identity: OwnershipIdentity,
    current: OwnershipIdentity | undefined,
    scope: "mission" | "repository",
  ): void {
    if (
      !current ||
      current.ownerId !== identity.ownerId ||
      current.generation !== identity.generation ||
      current.fencingToken !== identity.fencingToken
    ) {
      throw new Error(
        `stale ${scope} fencing identity for ${identity.missionId}: generation=${identity.generation} fencingToken=${identity.fencingToken}`,
      );
    }
  }

  private isExpired(lease: MissionLease, now: number): boolean {
    return now >= Date.parse(lease.renewBy);
  }

  private assertNotExpired(lease: MissionLease, scope: "mission" | "repository", id: string): void {
    if (this.isExpired(lease, this.now())) throw new Error(`${scope} ${id} lease expired at ${lease.renewBy}`);
  }

  private assertWriterAuthority(): void {
    if (!this.store.hasExclusiveWriterAuthority()) {
      throw new Error("mission ownership takeover requires explicit JSONL writer authority");
    }
  }
}

class RenewableDispatchAuthority implements DispatchAuthority {
  private mission: MissionLease;
  private repository?: RepositoryLease;
  private readonly ownership: MissionOwnership;
  private readonly timer: ReturnType<typeof setInterval>;
  private pulseChain: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  /** Most recent renewal error. Retained for observability (the failure COUNTER is reset on the next successful pulse, not this). */
  private lastError: Error | undefined;
  private stopped = false;
  private consecutiveRenewFailures = 0;
  private readonly maxConsecutiveRenewFailures: number;
  private readonly invalidationListeners = new Set<(error: Error) => void>();

  constructor(
    ownership: MissionOwnership,
    mission: MissionLease,
    repository: RepositoryLease | undefined,
    heartbeatMs: number,
    maxConsecutiveRenewFailures: number = 3,
  ) {
    this.maxConsecutiveRenewFailures = maxConsecutiveRenewFailures;
    this.ownership = ownership;
    this.mission = mission;
    this.repository = repository;
    this.timer = setInterval(() => {
      this.pulseChain = this.pulseChain
        .then(() => this.pulse())
        .catch((error) => {
          // A single transient renewal failure does NOT invalidate the authority:
          // custody contention and slow writes are expected between live sessions.
          // Only SUSTAINED failure (>= threshold consecutive) lapses the lease.
          this.lastError = error instanceof Error ? error : new Error(String(error));
          this.consecutiveRenewFailures += 1;
          if (this.consecutiveRenewFailures >= this.maxConsecutiveRenewFailures && !this.failure) {
            this.failure = new Error(
              `lease renewal failed ${this.consecutiveRenewFailures} times in a row: ${this.lastError.message}`,
            );
            for (const listener of this.invalidationListeners) listener(this.failure);
          }
        });
    }, heartbeatMs);
    this.timer.unref?.();
  }

  get missionIdentity(): MissionLease {
    return { ...this.mission };
  }

  get repositoryIdentity(): RepositoryLease | undefined {
    return this.repository ? { ...this.repository } : undefined;
  }

  get resumptionGeneration(): number {
    return this.mission.resumptionGeneration ?? 0;
  }

  get lastPulseError(): Error | undefined {
    return this.lastError;
  }

  assertAuthoritative(): void {
    if (this.failure) throw this.failure;
    this.ownership.assertAuthoritative(this.mission);
    if (this.repository) this.ownership.assertAuthoritative(this.repository);
  }

  onInvalidated(listener: (error: Error) => void): void {
    this.invalidationListeners.add(listener);
    if (this.failure) listener(this.failure);
  }

  async close(): Promise<Error | undefined> {
    if (this.stopped) return this.failure;
    this.stopped = true;
    clearInterval(this.timer);
    await this.pulseChain;
    if (!this.repository) return this.failure;
    try {
      await this.ownership.release(this.repository);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return this.failure;
  }

  private async pulse(): Promise<void> {
    if (this.stopped || this.failure) return;
    this.mission = await this.ownership.renew(this.mission);
    if (this.repository) {
      try {
        this.repository = await this.ownership.renewRepository(this.repository);
      } catch (error) {
        // A stale repository fencing identity means the repository lease was re-fenced to a new
        // generation while this authority still held the old one (a FENCE_RECONCILE_AND_RESUME
        // recovery fences the prior owner and re-acquires the lease). Renewing against the cached
        // old identity is a permanent mismatch, not a transient blip: it would otherwise count
        // toward the failure threshold and lap the lease dead. Re-acquire the repository lease
        // against the just-renewed mission identity so the authority tracks the new generation.
        if (isStaleFencingIdentity(error, "repository")) {
          // Retain the error for observability (lastPulseError) even though it is recovered from.
          this.lastError = error instanceof Error ? error : new Error(String(error));
          this.repository = await this.ownership.acquireRepository(this.mission, this.repository.repoId);
        } else {
          throw error;
        }
      }
    }
    // A successful renewal clears any prior transient-failure streak (the
    // counter, not the last-observed error, which is retained for observability).
    this.consecutiveRenewFailures = 0;
  }
}
