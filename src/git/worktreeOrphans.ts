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
}

/** What the cleanup pipeline should do with a classified worktree. */
export type OrphanDecision = "keep" | "adopt" | "quarantine";

/** The reason a worktree received a decision. */
export type OrphanReason =
  | "durable_reference"
  | "lease_live"
  | "mission_live"
  | "registry_active"
  | "owner_unknown"
  | "owner_terminal"
  | "unowned";

/** A single classified worktree. */
export interface OrphanClassification {
  worktree: ListedWorktree;
  decision: OrphanDecision;
  /** 1-based index of the matched rule in the first-match-wins set. */
  rule: number;
  /** The mission the worktree resolved to, when any. */
  missionId: string | null;
  reason: OrphanReason;
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
  const resourceId = `mission:${missionId}`;
  for (const lease of leases) {
    if (lease.resourceId === resourceId && nowMs <= lease.expiresAtMs) return true;
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

    // Rule 1: durably referenced path is always kept.
    if (durable.has(worktree.path)) {
      return { worktree, decision: "keep", rule: 1, missionId, reason: "durable_reference" as const };
    }

    // Rule 2: a live lease on `mission:<id>` keeps it.
    if (missionId && hasLiveLease(missionId, leases, nowMs)) {
      return { worktree, decision: "keep", rule: 2, missionId, reason: "lease_live" as const };
    }

    // Rule 3: a known mission that is still live keeps it.
    if (missionId && missionStatuses[missionId] !== undefined && !statusTerminal(missionStatuses[missionId])) {
      return { worktree, decision: "keep", rule: 3, missionId, reason: "mission_live" as const };
    }

    // Rule 4: an active registry record whose owner is not terminal keeps it.
    const record = registry.find((r) => r.kind === "worktree" && r.locator === worktree.path);
    if (record && record.state === "active" && !statusTerminal(missionStatuses[record.ownerMissionId])) {
      return { worktree, decision: "keep", rule: 4, missionId, reason: "registry_active" as const };
    }

    // Rule 5: a known mission with no recorded status is kept pending.
    if (missionId && missionStatuses[missionId] === undefined) {
      return { worktree, decision: "keep", rule: 5, missionId, reason: "owner_unknown" as const };
    }

    // Rule 6: a known, terminal mission with no live lease is handed to cleanup.
    if (missionId && statusTerminal(missionStatuses[missionId]) && !hasLiveLease(missionId, leases, nowMs)) {
      return { worktree, decision: "adopt", rule: 6, missionId, reason: "owner_terminal" as const };
    }

    // Rule 7: no mission and no registry record is quarantined.
    return { worktree, decision: "quarantine", rule: 7, missionId: null, reason: "unowned" as const };
  });
}
