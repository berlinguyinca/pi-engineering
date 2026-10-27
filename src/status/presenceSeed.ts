/**
 * Fill the presence strip from durable state instead of waiting for a live
 * event: missions started earlier, or by another process, would otherwise be
 * invisible until they happened to emit something.
 *
 * Two sources, in order of trust: the observability summary (the read model the
 * runtime already computes) when it exists, the mission store row when it does
 * not. A store row carries no proof of life, and says so. Neither may overwrite activity the runtime reported for this session —
 * a backstop must never make a live mission look quieter than it is.
 */
import { storeOnlyEvent } from "./presence.ts";
import type { MissionPresenceController } from "./MissionPresenceController.ts";
import type { Mission } from "../orchestration/types.ts";
import type { MissionObservabilitySummary } from "../orchestration/observability/types.ts";
import type { RuntimeMissionActivityEvent } from "../runtime/EngineeringRuntime.ts";

export interface PresenceSource {
  /** The durable rows: `runtime.missionStore.listMissions()`. */
  missions: readonly Mission[];
  /** The read model for one mission, when observability has one. */
  summary?(missionId: string): MissionObservabilitySummary | null | undefined;
}

/** The read model and the activity event share their vocabulary one for one. */
export function activityFromSummary(summary: MissionObservabilitySummary): RuntimeMissionActivityEvent {
  return {
    missionId: summary.missionId,
    title: summary.title,
    phase: summary.phase,
    state: summary.state,
    health: summary.health,
    approximatePercent: summary.progress.approximatePercent,
    acceptanceCoverage: {
      completed: summary.acceptanceCoverage.completed,
      total: summary.acceptanceCoverage.total,
      approximatePercent: summary.acceptanceCoverage.approximatePercent,
    },
    workflowProgress: {
      completed: summary.workflowProgress.completed,
      total: summary.workflowProgress.total,
      approximatePercent: summary.workflowProgress.approximatePercent,
    },
    summary: summary.currentActivity?.summary ?? summary.currentObjective ?? "",
    activeWorkers: summary.workers.active,
    waitingWorkers: summary.workers.waiting,
    failedWorkers: summary.workers.failed,
    lastMeaningfulProgressAt: summary.lastMeaningfulProgressAt,
    ...(summary.lastHeartbeatAt ? { lastHeartbeatAt: summary.lastHeartbeatAt } : {}),
    action: summary.action,
    reason: summary.reason,
    recovery: { attempt: summary.recovery.attempt, maxAttempts: summary.recovery.maxAttempts },
    nextAction: summary.nextAction,
    nextActionAt: summary.nextActionAt,
    owner: summary.owner,
    repository: summary.repository,
    task: summary.task,
    preservedWork: [...summary.preservedWork],
  };
}

export function seedPresence(presence: MissionPresenceController, source: PresenceSource): void {
  for (const mission of source.missions) {
    const summary = source.summary?.(mission.mission_id) ?? null;
    const event = summary
      ? activityFromSummary(summary)
      : storeOnlyEvent({ mission_id: mission.mission_id, title: mission.title, status: mission.status });
    presence.update(event, summary?.progress.basis, "store");
  }
}
