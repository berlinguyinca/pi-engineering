/**
 * Multi-mission lanes: durable, crash-self-healing per-repo write-domain
 * claims that let concurrent missions make parallel progress on one repo.
 *
 * The model (spec 2026-10-05-multi-mission-lanes): one index per repo holds
 * all live lane claims; every mutation is compare-and-swap, so overlap
 * checking is race-free. A task blocked on lanes WAITS — lane contention is
 * never a failure, never consumes an attempt, and never blocks a mission.
 *
 * The reserved `<integration>` domain overlaps only other integration
 * claims: workers (even whole-repo ones) run while an integrator is active,
 * but two integrators never are.
 */
import { createHash } from "node:crypto";
import { domainsOverlap, normalizeDomain } from "./workset.ts";

/** Reserved lane domain: the integration critical section of a repo. */
export const INTEGRATION_DOMAIN = "<integration>";

export interface LaneClaim {
  domain: string;
  ownerId: string;
  missionId: string;
  taskId: string;
  fence: number;
  acquiredAt: number;
  renewBy: number;
}

export interface LaneLease {
  repoId: string;
  ownerId: string;
  missionId: string;
  taskId: string;
  domains: string[];
  fence: number;
  renewBy: number;
}

/** Lane contention: the claim set that currently prevents acquisition. */
export class LaneBlockedError extends Error {
  readonly blockingClaims: LaneClaim[];

  constructor(blockingClaims: LaneClaim[]) {
    super(`lane blocked by ${blockingClaims.length} live claim(s)`);
    this.name = "LaneBlockedError";
    this.blockingClaims = blockingClaims;
  }
}

/** The durable lane index could not be parsed — fail closed, never rewrite. */
export class LaneIndexCorruptError extends Error {
  constructor(detail: string) {
    super(`lane index is corrupt: ${detail}`);
    this.name = "LaneIndexCorruptError";
  }
}

/** PI_ENGINEERING_LANE_BACKEND=git on a repo without a remote origin. */
export class LaneBackendMisconfiguredError extends Error {
  constructor(repoId: string) {
    super(
      `PI_ENGINEERING_LANE_BACKEND=git requires a remote origin, but repo ${repoId} has none — use backend=auto (per-repo selection) or memory for single-host operation`,
    );
    this.name = "LaneBackendMisconfiguredError";
  }
}

export interface LaneCoordinator {
  /**
   * Acquire lane claims for all of the task's domains. Resolves once held;
   * rejects with LaneBlockedError when an overlap or the repo writer cap
   * prevents acquisition. Never times out — the scheduler decides waits.
   * Re-acquire with the same taskId refreshes the holder's own claims
   * (a retried task must never self-deadlock).
   */
  acquire(input: {
    repoId: string;
    domains: string[];
    ownerId: string;
    missionId: string;
    taskId: string;
  }): Promise<LaneLease>;
  /** Refresh the holder's renewBy. Resolves null when the claim is gone (taken over). */
  renew(lease: LaneLease): Promise<LaneLease | null>;
  /** Drop the holder's claims. Idempotent; never throws on absence. */
  release(lease: LaneLease): Promise<void>;
  /** Live claims on a repo (renewBy >= now) for scheduling pre-checks. */
  listClaims(repoId: string): Promise<LaneClaim[]>;
  /** Concurrent mutating tasks allowed per repo; 0 = unlimited. */
  readonly maxRepoWriters: number;
  /** Lease length in ms; the scheduler renews at ~half this interval. */
  readonly leaseMs: number;
}

export interface LaneConfig {
  backend: "auto" | "memory" | "git";
  leaseMs: number;
  maxRepoWriters: number;
}

export const DEFAULT_LANE_CONFIG: LaneConfig = { backend: "auto", leaseMs: 300_000, maxRepoWriters: 4 };

/**
 * Resolve lane config from the environment (PI_ENGINEERING_LANE_BACKEND /
 * PI_ENGINEERING_LANE_LEASE_MS / PI_ENGINEERING_MAX_REPO_WRITERS). Invalid
 * values fall back to the default for that key only — one bad env var must
 * not disable lanes or zero a limit. Unknown backend values mean "auto".
 */
export function resolveLaneConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): LaneConfig {
  const positiveInt = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const nonNegativeInt = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const backend = env.PI_ENGINEERING_LANE_BACKEND;
  return {
    backend: backend === "memory" || backend === "git" ? backend : "auto",
    leaseMs: positiveInt(env.PI_ENGINEERING_LANE_LEASE_MS) ?? DEFAULT_LANE_CONFIG.leaseMs,
    maxRepoWriters: nonNegativeInt(env.PI_ENGINEERING_MAX_REPO_WRITERS) ?? DEFAULT_LANE_CONFIG.maxRepoWriters,
  };
}

/** The durable ref that holds a repo's lane index (one CAS point per repo). */
export function laneKeyFor(repoId: string): string {
  return `refs/lanes/${createHash("sha256").update(repoId).digest("hex")}`;
}

/** The lane domains a task claims: integration → the reserved domain; a
 * mutating task with no declared domains is whole-repo (most conservative). */
export function laneDomainsOf(task: { kind: string; write_domains: string[] }): string[] {
  if (task.kind === "integration") return [INTEGRATION_DOMAIN];
  const domains = [...new Set((task.write_domains ?? []).map((d) => normalizeDomain(d)).filter((d) => d.length > 0))];
  return domains.length > 0 ? domains : ["**"];
}

/**
 * Overlap between two lane domains. The integration domain never overlaps a
 * work domain (workers run while an integrator holds its lane, spec 4.4);
 * it overlaps only other integration claims.
 */
export function laneDomainOverlap(a: string, b: string): boolean {
  if (a === INTEGRATION_DOMAIN || b === INTEGRATION_DOMAIN) return a === b;
  return domainsOverlap([a], [b]);
}

export type LaneEventKind = "lane.acquired" | "lane.released" | "lane.wait" | "lane.stale_taken" | "lane.index_corrupt";

export type LaneEventSink = (kind: LaneEventKind, missionId: string, payload: Record<string, unknown>) => void;

/**
 * Single-process lane coordinator: the provably-safe fast path for repos
 * without a shared origin (multi-host contention is impossible there), and
 * the hermetic-test backend. Same semantics as the git-ref coordinator.
 */
// ── Pure claim-array operations ────────────────────────────────────────────
// Both coordinators (in-memory and git-ref) run identical claim semantics by
// sharing these pure mutations over a LaneClaim[] — the backends differ only
// in where the array lives and how it is persisted (Map vs CAS'd git ref).

export interface LaneAcquireInput {
  repoId: string;
  domains: string[];
  ownerId: string;
  missionId: string;
  taskId: string;
}

export interface GrantResult {
  claims: LaneClaim[];
  lease: LaneLease;
}

/**
 * Live (renewBy >= now) vs stale claims. Stale claims are still counted for
 * fence history by grantClaims but are not blocking and are dropped on write.
 */
export function pruneStale(claims: LaneClaim[], now: number): { live: LaneClaim[]; stale: LaneClaim[] } {
  const live: LaneClaim[] = [];
  const stale: LaneClaim[] = [];
  for (const claim of claims) (claim.renewBy >= now ? live : stale).push(claim);
  return { live, stale };
}

/** Live claims whose domain overlaps any of the given domains. */
export function findOverlaps(claims: LaneClaim[], domains: string[]): LaneClaim[] {
  return claims.filter((claim) => domains.some((d) => laneDomainOverlap(d, claim.domain)));
}

/**
 * Pure acquire: returns the new claims array and the lease, or throws
 * LaneBlockedError. Fences are never reused (max over ALL entries, stale
 * included, for the claimed domains, +1). Own prior entries (redispatch)
 * are dropped before overlap/cap checks.
 */
export function grantClaims(
  claims: LaneClaim[],
  input: LaneAcquireInput,
  leaseMs: number,
  maxRepoWriters: number,
  now: number,
): GrantResult {
  const domains = [...new Set(input.domains.map((d) => normalizeDomain(d)).filter((d) => d.length > 0))];
  let fence = 1;
  for (const claim of claims) {
    if (domains.includes(claim.domain) && claim.fence >= fence) fence = claim.fence + 1;
  }
  const others = claims.filter((claim) => claim.renewBy >= now && claim.taskId !== input.taskId);
  const blocking = findOverlaps(others, domains);
  if (blocking.length > 0) throw new LaneBlockedError(blocking);
  const integrationOnly = domains.every((d) => d === INTEGRATION_DOMAIN);
  if (!integrationOnly && maxRepoWriters > 0) {
    const writers = new Set(others.filter((claim) => claim.domain !== INTEGRATION_DOMAIN).map((c) => c.taskId));
    if (writers.size >= maxRepoWriters) {
      throw new LaneBlockedError(others.filter((claim) => claim.domain !== INTEGRATION_DOMAIN));
    }
  }
  const renewBy = now + leaseMs;
  const granted: LaneClaim[] = domains.map((domain) => ({
    domain,
    ownerId: input.ownerId,
    missionId: input.missionId,
    taskId: input.taskId,
    fence,
    acquiredAt: now,
    renewBy,
  }));
  return {
    claims: [...others, ...granted],
    lease: {
      repoId: input.repoId,
      ownerId: input.ownerId,
      missionId: input.missionId,
      taskId: input.taskId,
      domains,
      fence,
      renewBy,
    },
  };
}

/** Pure renew: refresh the holder's renewBy; null when the claim is gone. */
export function renewClaims(
  claims: LaneClaim[],
  lease: LaneLease,
  leaseMs: number,
  now: number,
): { claims: LaneClaim[]; next: LaneLease | null } {
  const renewBy = now + leaseMs;
  let next: LaneLease | null = null;
  const nextClaims = claims.map((claim) => {
    if (claim.taskId === lease.taskId && claim.fence === lease.fence) {
      next ??= { ...lease, renewBy };
      return { ...claim, renewBy };
    }
    return claim;
  });
  return { claims: nextClaims, next };
}

/** Pure release: drop the holder's claims (idempotent). */
export function releaseClaims(claims: LaneClaim[], lease: LaneLease): LaneClaim[] {
  return claims.filter((claim) => !(claim.taskId === lease.taskId && claim.fence === lease.fence));
}

export class InMemoryLaneCoordinator implements LaneCoordinator {
  private readonly repos = new Map<string, LaneClaim[]>();
  readonly maxRepoWriters: number;
  readonly leaseMs: number;
  private readonly now: () => number;

  constructor(opts: { config?: Partial<LaneConfig>; now?: () => number } = {}) {
    const config = { ...DEFAULT_LANE_CONFIG, ...opts.config };
    this.leaseMs = config.leaseMs > 0 ? config.leaseMs : DEFAULT_LANE_CONFIG.leaseMs;
    this.maxRepoWriters = config.maxRepoWriters >= 0 ? config.maxRepoWriters : DEFAULT_LANE_CONFIG.maxRepoWriters;
    this.now = opts.now ?? (() => Date.now());
  }

  async acquire(input: LaneAcquireInput): Promise<LaneLease> {
    const { claims, lease } = grantClaims(
      this.repos.get(input.repoId) ?? [],
      input,
      this.leaseMs,
      this.maxRepoWriters,
      this.now(),
    );
    this.repos.set(input.repoId, claims);
    return lease;
  }

  async renew(lease: LaneLease): Promise<LaneLease | null> {
    const { claims, next } = renewClaims(this.repos.get(lease.repoId) ?? [], lease, this.leaseMs, this.now());
    this.repos.set(lease.repoId, claims);
    return next;
  }

  async release(lease: LaneLease): Promise<void> {
    this.repos.set(lease.repoId, releaseClaims(this.repos.get(lease.repoId) ?? [], lease));
  }

  async listClaims(repoId: string): Promise<LaneClaim[]> {
    return pruneStale(this.repos.get(repoId) ?? [], this.now()).live.map((claim) => ({ ...claim }));
  }
}
