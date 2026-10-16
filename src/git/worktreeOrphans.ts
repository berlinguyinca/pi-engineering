/**
 * Worktree orphan classifier: pure classification of candidate worktrees into
 * keep / adopt / quarantine, before any destructive action is taken.
 *
 * Unlike the janitor (`worktreeJanitor.ts`), which acts on disk, this module is
 * deliberately side-effect free. Given the candidate worktrees, the resource
 * registry, the lease table, the mission statuses and an optional set of
 * durably referenced paths, it returns one {@link OrphanClassification} per
 * input worktree in input order, using a strict first-match-wins rule set so a
 * cleanup pipeline can make one deterministic decision per worktree.
 */

import type { MissionStatus } from "../orchestration/types.ts";
import type { ResourceRecord } from "../resources/ResourceRegistry.ts";
import type { LeaseRecord } from "../runtime/isolation/LeaseManager.ts";
import { parseWorktreeOwner } from "./worktreeJanitor.ts";

/** A candidate worktree, exactly as listed by `git worktree list`. */
export interface ListedWorktree {
  path: string;
  /** The branch checked out in the worktree, or null when detached. */
  branch: string | null;
  /** The commit the worktree points at (HEAD), or null when unknown. */
  head: string | null;
}

/** What the cleanup pipeline should do with a classified worktree. */
export type OrphanDecision = "keep" | "adopt" | "quarantine";

/** The reason a worktree received a decision. */
type OrphanReason =
  | "durable_reference"
  | "lease_live"
  | "mission_live"
  | "registry_active"
  | "owner_unknown"
  | "owner_terminal"
  | "unowned";

/** A single classified worktree. */
export interface OrphanClassification {
  /** The worktree's path. */
  path: string;
  /** The worktree's branch, or null when detached. */
  branch: string | null;
  /** The mission the worktree resolved to, when any. */
  missionId: string | null;
  decision: OrphanDecision;
  reason: string;
}

/** Mission statuses after which a mission never touches its worktrees again. */
export const TERMINAL_MISSION_STATUSES: ReadonlySet<string> = new Set<string>(["COMPLETE", "CANCELED", "FAILED"]);

export interface ClassifyWorktreesInput {
  worktrees: readonly ListedWorktree[];
  registry: readonly ResourceRecord[];
  leases: readonly LeaseRecord[];
  /** missionId -> mission status. */
  missionStatuses: Readonly<Record<string, MissionStatus | string>>;
  /** Paths durably referenced (e.g. by another repo's config); always kept. */
  durablyReferenced?: ReadonlySet<string>;
  /** Current wall-clock time in ms, for lease expiry checks. */
  nowMs: number;
}

/**
 * Resolve the mission a worktree belongs to: from its branch first, else the
 * owning mission of the first `worktree` registry record whose locator equals
 * the worktree's path, else null.
 */
function resolveMissionId(worktree: ListedWorktree, registry: readonly ResourceRecord[]): string | null {
  const fromBranch = parseWorktreeOwner(worktree.branch).missionId;
  if (fromBranch) return fromBranch;
  for (const record of registry) {
    if (record.kind === "worktree" && record.locator === worktree.path) return record.ownerMissionId;
  }
  return null;
}

function hasLiveLease(missionId: string, leases: readonly LeaseRecord[], nowMs: number): boolean {
  // A mission lease is recorded as `mission:<id>` or as `<ns>#mission:<id>`;
  // strip anything up to and including the first '#' so both forms match.
  const resourceId = `mission:${missionId}`;
  for (const lease of leases) {
    const leaseId = lease.resourceId.includes("#")
      ? lease.resourceId.slice(lease.resourceId.indexOf("#") + 1)
      : lease.resourceId;
    if (leaseId === resourceId && nowMs <= lease.expiresAtMs) return true;
  }
  return false;
}

function statusTerminal(status: MissionStatus | string | undefined): boolean {
  return status !== undefined && TERMINAL_MISSION_STATUSES.has(status);
}

/**
 * Classify each candidate worktree using the documented first-match-wins rule
 * set. Pure: performs no IO, reads no environment, and takes the current time
 * as an argument. Returns classifications in input worktree order.
 */
export function classifyWorktrees(input: ClassifyWorktreesInput): OrphanClassification[] {
  const { worktrees, registry, leases, missionStatuses, durablyReferenced, nowMs } = input;
  const durable = durablyReferenced ?? new Set<string>();

  return worktrees.map((worktree) => {
    const missionId = resolveMissionId(worktree, registry);
    const { path, branch } = worktree;

    // Rule 1: durably referenced path is always kept.
    if (durable.has(worktree.path)) {
      return { path, branch, decision: "keep", missionId, reason: "durable_reference" };
    }

    // Rule 2: a live lease on `mission:<id>` (either lease form) keeps it.
    if (missionId && hasLiveLease(missionId, leases, nowMs)) {
      return { path, branch, decision: "keep", missionId, reason: "lease_live" };
    }

    // Rule 3: a known mission that is still live keeps it.
    if (missionId && missionStatuses[missionId] !== undefined && !statusTerminal(missionStatuses[missionId])) {
      return { path, branch, decision: "keep", missionId, reason: "mission_live" };
    }

    // Rule 4: an active registry record whose owner is not terminal keeps it.
    const record = registry.find((r) => r.kind === "worktree" && r.locator === worktree.path);
    if (record && record.state === "active" && !statusTerminal(missionStatuses[record.ownerMissionId])) {
      return { path, branch, decision: "keep", missionId, reason: "registry_active" };
    }

    // Rule 5: a known mission with no recorded status is kept pending.
    if (missionId && missionStatuses[missionId] === undefined) {
      return { path, branch, decision: "keep", missionId, reason: "owner_unknown" };
    }

    // Rule 6: a known, terminal mission with no live lease is handed to cleanup.
    if (missionId && statusTerminal(missionStatuses[missionId]) && !hasLiveLease(missionId, leases, nowMs)) {
      return { path, branch, decision: "adopt", missionId, reason: "owner_terminal" };
    }

    // Rule 7: no mission and no registry record is quarantined.
    return { path, branch, decision: "quarantine", missionId: null, reason: "unowned" };
  });
}
