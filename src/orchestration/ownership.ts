import type { MissionStore } from "./missionStore.ts";
import type { MissionLease, RepositoryLease } from "./types.ts";

export interface MissionOwnershipOptions {
  ownerId: string;
  leaseMs?: number;
  now?: () => number;
}

export type OwnershipIdentity = MissionLease | RepositoryLease;

function isRepositoryIdentity(identity: OwnershipIdentity): identity is RepositoryLease {
  return "repoId" in identity;
}

/** Durable single-controller leases backed exclusively by MissionStore events. */
export class MissionOwnership {
  private readonly store: MissionStore;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(store: MissionStore, options: MissionOwnershipOptions) {
    if (!options.ownerId.trim()) throw new Error("MissionOwnership ownerId is required");
    if (!Number.isFinite(options.leaseMs ?? 30_000) || (options.leaseMs ?? 30_000) <= 0) {
      throw new Error("MissionOwnership leaseMs must be positive");
    }
    this.store = store;
    this.ownerId = options.ownerId;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async acquire(missionId: string): Promise<MissionLease> {
    this.assertWriterAuthority();
    const current = this.store.getMissionLease(missionId);
    const now = this.now();
    if (current && !this.isExpired(current, now)) {
      if (current.ownerId !== this.ownerId) {
        throw new Error(`mission ${missionId} is owned by ${current.ownerId} until ${current.renewBy}`);
      }
      return this.renew(current);
    }
    if (current) {
      this.store.transitionMissionLease("expired", current);
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
    };
    this.store.transitionMissionLease("acquired", lease);
    await this.store.flush();
    return { ...lease };
  }

  async renew(identity: MissionLease): Promise<MissionLease> {
    const current = this.store.getMissionLease(identity.missionId);
    this.assertSameEpoch(identity, current, "mission");
    const now = this.now();
    if (this.isExpired(current!, now)) {
      this.store.transitionMissionLease("expired", current!);
      await this.store.flush();
      throw new Error(`mission ${identity.missionId} lease expired at ${current!.renewBy}`);
    }
    const renewed = { ...current!, renewBy: new Date(now + this.leaseMs).toISOString() };
    this.store.transitionMissionLease("renewed", renewed);
    await this.store.flush();
    return { ...renewed };
  }

  async acquireRepository(identity: MissionLease, repoId: string): Promise<RepositoryLease> {
    this.assertWriterAuthority();
    this.assertAuthoritative(identity);
    const current = this.store.getRepositoryLeaseByRepoId(repoId);
    const now = this.now();
    if (current && !this.isExpired(current, now)) {
      if (current.missionId !== identity.missionId || current.ownerId !== identity.ownerId) {
        throw new Error(`repository ${repoId} is leased to mission ${current.missionId} by ${current.ownerId}`);
      }
      return this.renewRepository(current);
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
    const renewed = { ...current!, renewBy: new Date(now + this.leaseMs).toISOString() };
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
    if (isRepositoryIdentity(identity)) this.store.transitionRepositoryLease("fenced", identity);
    else this.store.transitionMissionLease("fenced", identity);
    await this.store.flush();
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
    this.assertNotExpired(current!, "mission", identity.missionId);
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
      throw new Error("mission ownership takeover requires the JSONL writer lock");
    }
  }
}
