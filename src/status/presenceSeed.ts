import type { MissionObservabilitySummary } from "../orchestration/observability/types.ts";
import type { Mission } from "../orchestration/types.ts";
import type { RuntimeMissionActivityEvent } from "../runtime/EngineeringRuntime.ts";
import type { MissionPresenceController } from "./MissionPresenceController.ts";
/**
 * Fill the presence strip from durable state instead of waiting for a live
 * event: missions this session started earlier would otherwise be invisible
 * until they happened to emit something.
 *
 * Two sources, in order of trust: the observability summary (the read model the
 * runtime already computes) when it exists, the mission store row when it does
 * not. A store row carries no proof of life, and says so. Neither may overwrite activity the runtime reported for this session —
 * a backstop must never make a live mission look quieter than it is.
 *
 * Seeding reads a durable store shared by every pi window on the machine, so it
 * is scoped by default: a window draws the missions it owns (`parent_session_id`
 * is the session that started them) and nothing else. Mission output belongs in
 * the window the mission runs at; a strip that mirrors every window turns an
 * operator's status line into someone else's queue. `scope: "all"` restores the
 * machine-wide view for an operator who wants one dashboard.
 */
import { storeOnlyEvent } from "./presence.ts";

/** Whose durable rows a strip may draw. */
export type PresenceSeedScope = "session" | "all";

export interface PresenceSource {
  /** The durable rows: `runtime.missionStore.listMissions()`. */
  missions: readonly Mission[];
  /** The read model for one mission, when observability has one. */
  summary?(missionId: string): MissionObservabilitySummary | null | undefined;
  /** Defaults to "session": this window's missions only. */
  scope?: PresenceSeedScope;
  /** This session's id (`RuntimeSession.current().sessionId`). */
  sessionId?: string | null;
}

/**
 * The mission belongs to this window only when the session that started it is
 * this session. A row with no owner was not started by a session at all, so no
 * session may claim it; a strip that cannot name its own id draws nothing.
 */
export function missionBelongsToSession(
  mission: Pick<Mission, "parent_session_id">,
  sessionId?: string | null,
): boolean {
  return !!sessionId && mission.parent_session_id === sessionId;
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
  const scoped = (source.scope ?? "session") === "session";
  for (const mission of source.missions) {
    if (scoped && !missionBelongsToSession(mission, source.sessionId)) continue;
    const summary = source.summary?.(mission.mission_id) ?? null;
    const event = summary
      ? activityFromSummary(summary)
      : storeOnlyEvent({ mission_id: mission.mission_id, title: mission.title, status: mission.status });
    presence.update(event, summary?.progress.basis, "store");
  }
}
