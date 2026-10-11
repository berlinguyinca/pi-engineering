/**
 * Git-ref lane coordinator: cross-host lane claims over a shared origin.
 *
 * One ref per repo (`refs/lanes/<sha256(repoId)>`) holds the JSON lane index
 * (`{ version: 1, claims: [...] }`). Every mutation is a compare-and-swap push
 * (see GitRepo.casPushRef): read the ref, apply a pure claim-array operation,
 * push with the observed sha as the CAS lease; a push rejection means another
 * host wrote first, so we re-read and retry with bounded backoff.
 *
 * Host crashes self-heal: a dead host stops renewing, its claims go stale, and
 * the next acquirer on any host removes them (emitting `lane.stale_taken`).
 *
 * Repos without a shared origin (multi-host contention impossible) delegate to
 * an in-memory coordinator under backend=auto; backend=git on such a repo is a
 * configuration error.
 */
import type { GitRepo } from "../git/GitRepo.ts";
import { type BackoffConfig, backoffDelayMs } from "../guard/transient.ts";
import {
  InMemoryLaneCoordinator,
  type LaneAcquireInput,
  LaneBackendMisconfiguredError,
  type LaneClaim,
  type LaneConfig,
  type LaneCoordinator,
  type LaneEventSink,
  LaneIndexCorruptError,
  type LaneLease,
  grantClaims,
  laneKeyFor,
  pruneStale,
  releaseClaims,
  renewClaims,
} from "./lanes.ts";

const RETRY_CONFIG: BackoffConfig = {
  baseMs: 10,
  maxMs: 250,
  factor: 2,
  jitter: 0.3,
  maxAttempts: 8,
};

interface ReadIndex {
  sha: string;
  claims: LaneClaim[];
}

export class GitRefLaneCoordinator implements LaneCoordinator {
  readonly maxRepoWriters: number;
  readonly leaseMs: number;
  private readonly config: LaneConfig;
  private readonly openRepo: (repoId: string, missionId: string) => Promise<GitRepo | null>;
  private readonly onLaneEvent?: LaneEventSink;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly memoryFallback: InMemoryLaneCoordinator;

  constructor(opts: {
    config: LaneConfig;
    openRepo: (repoId: string, missionId: string) => Promise<GitRepo | null>;
    onLaneEvent?: LaneEventSink;
    now?: () => number;
    rand?: () => number;
  }) {
    this.config = opts.config;
    this.maxRepoWriters = opts.config.maxRepoWriters;
    this.leaseMs = opts.config.leaseMs;
    this.openRepo = opts.openRepo;
    this.onLaneEvent = opts.onLaneEvent;
    this.now = opts.now ?? (() => Date.now());
    this.rand = opts.rand ?? Math.random;
    this.memoryFallback = new InMemoryLaneCoordinator({
      config: { backend: "memory", leaseMs: opts.config.leaseMs, maxRepoWriters: opts.config.maxRepoWriters },
      now: this.now,
    });
  }

  /**
   * Route a repo to git-backed coordination, or null for in-memory delegation.
   * Throws LaneBackendMisconfiguredError only for backend=git on an origin-less
   * repo.
   */
  private async route(repoId: string, missionId: string): Promise<GitRepo | null> {
    const repo = await this.openRepo(repoId, missionId);
    if (!repo) return null; // no git provider at all → in-memory
    if (this.config.backend === "git") {
      if (!(await repo.hasRemoteOrigin())) throw new LaneBackendMisconfiguredError(repoId);
      return repo;
    }
    // backend "auto": git when a shared origin exists, else in-memory.
    return (await repo.hasRemoteOrigin()) ? repo : null;
  }

  /**
   * CAS loop over the durable git index. `mutate(claims) => { claims, result }`
   * is pure; on a lost race we re-read and retry with backoff. Stale claims
   * removed by a successful write are reported as lane.stale_taken.
   */
  private async casMutate<T>(
    repo: GitRepo,
    repoId: string,
    mutate: (claims: LaneClaim[]) => { claims: LaneClaim[]; result: T },
  ): Promise<T> {
    const key = laneKeyFor(repoId);
    let last: ReadIndex | null = await this.readIndex(repo, key, repoId);
    for (let attempt = 0; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      const claims = last?.claims ?? [];
      const stale = pruneStale(claims, this.now()).stale;
      const outcome = mutate(claims);
      const content = JSON.stringify({ version: 1, claims: outcome.claims });
      const pushed = await repo.casPushRef(key, content, last?.sha ?? null);
      if (pushed.ok) {
        for (const claim of stale) {
          this.onLaneEvent?.("lane.stale_taken", claim.missionId, {
            repo_id: repoId,
            owner_id: claim.ownerId,
            mission_id: claim.missionId,
            task_id: claim.taskId,
            domain: claim.domain,
          });
        }
        return outcome.result;
      }
      const refreshed = await this.readIndex(repo, key, repoId);
      if (refreshed && refreshed.sha === pushed.remoteSha) {
        // Remote unchanged yet push still rejected: a real error, not a race.
        throw new Error(`lane CAS push failed for ${key}`);
      }
      last = refreshed;
      if (attempt < RETRY_CONFIG.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt, RETRY_CONFIG, this.rand)));
      }
    }
    throw new Error(`lane CAS retries exhausted for ${key}`);
  }

  private async readIndex(repo: GitRepo, key: string, repoId: string): Promise<ReadIndex | null> {
    const read = await repo.readRemoteRef(key);
    if (read === null) return null;
    return { sha: read.sha, claims: this.parseIndex(read.content, repoId) };
  }

  private parseIndex(content: string, repoId: string): LaneClaim[] {
    try {
      const parsed = JSON.parse(content) as { version?: number; claims?: LaneClaim[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.claims)) {
        throw new Error(`unexpected shape (version=${parsed.version})`);
      }
      return parsed.claims;
    } catch (error) {
      throw new LaneIndexCorruptError(`repo ${repoId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async acquire(input: LaneAcquireInput): Promise<LaneLease> {
    const repo = await this.route(input.repoId, input.missionId);
    if (repo === null) return this.memoryFallback.acquire(input);
    return this.casMutate(repo, input.repoId, (claims) => {
      const { claims: next, lease } = grantClaims(claims, input, this.config.leaseMs, this.maxRepoWriters, this.now());
      return { claims: next, result: lease };
    });
  }

  async renew(lease: LaneLease): Promise<LaneLease | null> {
    const repo = await this.route(lease.repoId, lease.missionId);
    if (repo === null) return this.memoryFallback.renew(lease);
    return this.casMutate(repo, lease.repoId, (claims) => {
      const { claims: next, next: result } = renewClaims(claims, lease, this.config.leaseMs, this.now());
      return { claims: next, result };
    });
  }

  async release(lease: LaneLease): Promise<void> {
    const repo = await this.route(lease.repoId, lease.missionId);
    if (repo === null) return this.memoryFallback.release(lease);
    await this.casMutate(repo, lease.repoId, (claims) => ({
      claims: releaseClaims(claims, lease),
      result: undefined,
    }));
  }

  async listClaims(repoId: string): Promise<LaneClaim[]> {
    const repo = await this.route(repoId, "");
    if (repo === null) return this.memoryFallback.listClaims(repoId);
    const read = await this.readIndex(repo, laneKeyFor(repoId), repoId);
    if (read === null) return [];
    return pruneStale(read.claims, this.now()).live.map((claim) => ({ ...claim }));
  }
}
