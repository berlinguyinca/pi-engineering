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
}

export const missionCustodyKey = (missionId: string): string => `mission:${missionId}`;
export const repositoryCustodyKey = (repoId: string): string => `repository:${repoId}`;

export type OwnershipIdentity = MissionLease | RepositoryLease;

export interface DispatchAuthority {
  readonly missionIdentity: MissionLease;
  readonly repositoryIdentity?: RepositoryLease;
  readonly resumptionGeneration?: number;
  assertAuthoritative(): void;
  onInvalidated(listener: (error: Error) => void): void;
  /** Stops renewal and releases repository authority. Release failures are returned, never thrown. */
  close(): Promise<Error | undefined>;
}

function isRepositoryIdentity(identity: OwnershipIdentity): identity is RepositoryLease {
  return "repoId" in identity;
}

/** Durable single-controller leases backed exclusively by MissionStore events. */
export class MissionOwnership {
  private readonly store: MissionStore;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly custody: MissionCustody | undefined;
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
    this.now = options.now ?? Date.now;
    this.custody = options.custody;
  }

  /** Claim custody of a resource and catch up on other sessions' events. */
  private async claimCustody(resource: string, what: string): Promise<void> {
    if (!this.custody) return;
    const claim = await this.custody.claim(resource);
    if (!claim.ok) throw new Error(`${what} is in the custody of another live session (${claim.holder})`);
    this.store.syncExternal();
  }

  private releaseCustody(resource: string): void {
    void this.custody?.release(resource).catch(() => undefined);
  }

  async maintain(identity: MissionLease, repoId?: string): Promise<DispatchAuthority> {
    const mission = await this.renew(identity);
    const repository = repoId ? await this.acquireRepository(mission, repoId) : undefined;
    return new RenewableDispatchAuthority(this, mission, repository, this.heartbeatMs);
  }

  async acquire(missionId: string, options: { resumptionGeneration?: number } = {}): Promise<MissionLease> {
    this.assertWriterAuthority();
    await this.claimCustody(missionCustodyKey(missionId), `mission ${missionId}`);
    const current = this.store.getMissionLease(missionId);
    const now = this.now();
    if (current && !this.isExpired(current, now)) {
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
    if (current && !this.isExpired(current, now)) {
      if (current.missionId !== identity.missionId || current.ownerId !== identity.ownerId) {
        throw new Error(`repository ${repoId} is leased to mission ${current.missionId} by ${current.ownerId}`);
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
  private stopped = false;
  private readonly invalidationListeners = new Set<(error: Error) => void>();

  constructor(
    ownership: MissionOwnership,
    mission: MissionLease,
    repository: RepositoryLease | undefined,
    heartbeatMs: number,
  ) {
    this.ownership = ownership;
    this.mission = mission;
    this.repository = repository;
    this.timer = setInterval(() => {
      this.pulseChain = this.pulseChain
        .then(() => this.pulse())
        .catch((error) => {
          this.failure = error instanceof Error ? error : new Error(String(error));
          for (const listener of this.invalidationListeners) listener(this.failure);
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
    if (this.repository) this.repository = await this.ownership.renewRepository(this.repository);
  }
}
