/**
 * Offline operator cancellation of stale missions.
 *
 * A mission is canceled in-session only through the AbortSignal of the
 * `orchestrate()` call that owns it. A mission whose controller is gone (a
 * killed `pi` process) and that sits BLOCKED or stopped has no such caller, yet
 * the supervisor of every later runtime over the same store keeps reporting or
 * repairing it. This module settles such missions through the store's own
 * lifecycle transitions, under the store's single-writer lock, without
 * starting a supervisor or touching Git. Candidate worktrees and branches are
 * deliberately preserved (and reported) for diagnosis, as for any canceled
 * mission.
 */
import type { MissionStore } from "./missionStore.ts";
import { canTransitionMission, canTransitionTask } from "./state.ts";
import type { Mission, MissionStatus } from "./types.ts";

const TERMINAL: ReadonlySet<MissionStatus> = new Set(["COMPLETE", "FAILED", "CANCELED"]);

export interface MissionSelector {
  /** Workspace-manifest repository id the mission must be bound to. */
  repoId?: string;
  /** Only missions created strictly after this instant (ISO-8601). */
  createdAfter?: string;
  /** Explicit mission ids; combined with the other filters by AND. */
  missionIds?: string[];
  /** Include terminal missions in a listing (never cancelable). */
  includeTerminal?: boolean;
}

export interface MissionListing {
  missionId: string;
  status: MissionStatus;
  createdAt: string;
  repoIds: string[];
  title: string;
  terminal: boolean;
  stopped: boolean;
  resumeCondition: string | null;
}

export interface MissionCancellation {
  missionId: string;
  fromStatus: MissionStatus;
  status: MissionStatus;
  canceledTasks: string[];
  canceledExecutions: string[];
  settledRecoveries: string[];
  preservedWork: string[];
}

/** Transition one mission to CANCELED through CANCELING where the lifecycle requires it. */
export function transitionMissionToCanceled(store: MissionStore, missionId: string): Mission {
  let mission = store.getMission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  if (mission.status === "CANCELED") return mission;
  if (canTransitionMission(mission.status, "CANCELING")) {
    mission = store.transitionMission(missionId, "CANCELING");
  }
  if (canTransitionMission(mission.status, "CANCELED")) {
    mission = store.transitionMission(missionId, "CANCELED");
  }
  return mission;
}

function missionRepoIds(store: MissionStore, missionId: string): string[] {
  return [...new Set(store.getWorkspaceManifest(missionId)?.repositories.map((repository) => repository.repoId) ?? [])];
}

function currentStop(store: MissionStore, missionId: string) {
  const generation = store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
  return store
    .listMissionStops(missionId)
    .filter((stop) => stop.resumptionGeneration === generation)
    .at(-1);
}

export function listMissions(store: MissionStore, selector: MissionSelector = {}): MissionListing[] {
  const after = selector.createdAfter ? Date.parse(selector.createdAfter) : null;
  if (after !== null && !Number.isFinite(after)) throw new Error(`invalid createdAfter ${selector.createdAfter}`);
  const ids = selector.missionIds?.length ? new Set(selector.missionIds) : null;
  return store
    .listMissions()
    .filter((mission) => (ids ? ids.has(mission.mission_id) : true))
    .filter((mission) => (after === null ? true : Date.parse(mission.created_at) > after))
    .filter((mission) => (selector.repoId ? missionRepoIds(store, mission.mission_id).includes(selector.repoId) : true))
    .filter((mission) => selector.includeTerminal || !TERMINAL.has(mission.status))
    .map((mission) => {
      const stop = currentStop(store, mission.mission_id);
      return {
        missionId: mission.mission_id,
        status: mission.status,
        createdAt: mission.created_at,
        repoIds: missionRepoIds(store, mission.mission_id),
        title: mission.title.split("\n")[0]!.slice(0, 120),
        terminal: TERMINAL.has(mission.status),
        stopped: !!stop,
        resumeCondition: stop?.resumeCondition ?? null,
      };
    });
}

/**
 * Cancel one non-terminal mission whose controller is gone. Refuses a mission
 * whose controller lease is still live (`now` < renewBy): that mission has an
 * owner, which must cancel it through its own signal.
 */
export function cancelStaleMission(
  store: MissionStore,
  missionId: string,
  options: { now?: number } = {},
): MissionCancellation {
  const mission = store.getMission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  if (TERMINAL.has(mission.status)) {
    throw new Error(`mission ${missionId} is terminal (${mission.status}) and cannot be canceled`);
  }
  const now = options.now ?? Date.now();
  const lease = store.getMissionLease(missionId);
  if (lease && now < Date.parse(lease.renewBy)) {
    throw new Error(
      `mission ${missionId} has a live controller lease held by ${lease.ownerId} until ${lease.renewBy}; cancel it from that session`,
    );
  }
  const canceledExecutions: string[] = [];
  for (const execution of store.listExecutions(missionId)) {
    if (execution.status === "PENDING" || execution.status === "RUNNING") {
      store.setExecutionStatus(execution.execution_id, "CANCELED", { exit_status: "canceled" });
      canceledExecutions.push(execution.execution_id);
    }
  }
  const canceledTasks: string[] = [];
  for (const task of store.listTasks(missionId)) {
    if (canTransitionTask(task.status, "CANCELED")) {
      store.transitionTask(task.task_id, "CANCELED");
      canceledTasks.push(task.task_id);
    }
  }
  const settledRecoveries: string[] = [];
  for (const decision of store.listRecoveryDecisions(missionId)) {
    if (decision.status === "planned" || decision.status === "started") {
      store.transitionRecovery(decision.recoveryId, "failed");
      settledRecoveries.push(decision.recoveryId);
    }
  }
  const settled = transitionMissionToCanceled(store, missionId);
  if (settled.status !== "CANCELED") {
    throw new Error(`mission ${missionId} could not transition ${mission.status} -> CANCELED`);
  }
  const preservedWork = [
    ...new Set(
      store
        .listTaskCheckpoints(missionId)
        .flatMap((checkpoint) => [checkpoint.worktree, checkpoint.branch])
        .filter((value): value is string => !!value?.trim()),
    ),
  ];
  return {
    missionId,
    fromStatus: mission.status,
    status: settled.status,
    canceledTasks,
    canceledExecutions,
    settledRecoveries,
    preservedWork,
  };
}
