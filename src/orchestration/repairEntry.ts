/**
 * The one way a mission enters active repair.
 *
 * `MissionStore.transitionMission` refuses `BLOCKED -> REPAIRING` unless the
 * caller names a durable recovery decision for the current blocked episode. That
 * invariant is correct; what was wrong is that the run/repair paths called it
 * with no decision and let the store's precondition escape as the user-visible
 * error ("BLOCKED -> REPAIRING requires a durable repair recovery decision ID").
 * A precondition with no door is a deadlock: the agent's remaining options were
 * a raw store error on a fresh run and a resume refusal, and the mission stayed
 * `BLOCKED` blocking its scope indefinitely (#629).
 *
 * So the paths go through here. When the mission is `BLOCKED` they consume the
 * planned decision the recovery planner already recorded for this episode — the
 * same authority the orchestrator's repair branches pass explicitly. When no
 * such decision exists, the refusal names the mission, its episode, and both
 * commands that actually move it.
 */
import type { MissionStore } from "./missionStore.ts";
import type { Mission, RecoveryAction, RecoveryDecision } from "./types.ts";

/** Decisions that park the mission; none of them is authority to do work. */
const WAITING_ACTIONS: ReadonlySet<RecoveryAction> = new Set(["STOP", "WAIT_FOR_REQUIREMENT", "PAUSE_FOR_PERSISTENCE"]);

/** Kinds whose failure a probe re-runs as active work (mirrors the store's rule). */
const GATE_TASK_KINDS: ReadonlySet<string> = new Set(["validation", "review", "integration"]);

/** True when a probe decision re-runs a gate that died, rather than only waiting. */
function probesGate(store: MissionStore, decision: RecoveryDecision): boolean {
  const taskId = store.getFailureClassification(decision.classificationId)?.taskId;
  const kind = taskId ? store.getTask(taskId)?.kind : undefined;
  return typeof kind === "string" && GATE_TASK_KINDS.has(kind);
}

/**
 * The planned decision that may carry this `BLOCKED` mission into repair: one
 * recorded against the *current* blocked episode, still `planned`, whose action
 * does work. A decision from a superseded episode never qualifies — the operator
 * resuming opens a new episode that needs its own decision.
 */
export function plannedRepairDecision(store: MissionStore, missionId: string): RecoveryDecision | undefined {
  const episode = store.getMission(missionId)?.blocked_episode_id;
  if (!episode) return undefined;
  return store
    .listRecoveryDecisions(missionId)
    .find(
      (decision) =>
        decision.status === "planned" &&
        decision.blockedEpisodeId === episode &&
        !WAITING_ACTIONS.has(decision.action) &&
        (decision.action !== "PROBE_AND_BACKOFF" || probesGate(store, decision)),
    );
}

/** Why the mission cannot enter repair, written so the caller has a next command. */
export function repairEntryBlocker(mission: Mission): string {
  const episode = mission.blocked_episode_id ?? "no recorded blocked episode";
  return `mission ${mission.mission_id} is BLOCKED (episode ${episode}) with no planned repair recovery decision for that episode, so it cannot enter REPAIRING. Resume it with /mission resume ${mission.mission_id} (or the mission tool's resume action), which plans recovery and repairs the episode; end it with /mission cancel ${mission.mission_id}.`;
}

/**
 * A repair entry the caller cannot satisfy. Typed so the mission tool can answer
 * with the door instead of an unlabelled tool failure — the same reason
 * `MissionRefusedError` exists (#511): a caller that catches errors generically
 * absorbs "no recovery decision" as "nothing to do", and the mission stays
 * `BLOCKED` holding its scope.
 */
export class RepairEntryBlockedError extends Error {
  readonly missionId: string;
  readonly blockedEpisodeId: string | null;
  readonly resumeCommand: string;

  constructor(mission: Mission) {
    super(repairEntryBlocker(mission));
    this.name = "RepairEntryBlockedError";
    this.missionId = mission.mission_id;
    this.blockedEpisodeId = mission.blocked_episode_id ?? null;
    this.resumeCommand = `/mission resume ${mission.mission_id}`;
  }
}

/**
 * Move a mission into `REPAIRING`, honouring the durable authority the store
 * demands. Idempotent when it is already repairing. A mission in any other state
 * needs no recovery decision — this is the backward move the gate paths route
 * through (REVIEWING/FINAL_VALIDATION -> VALIDATING is deliberately illegal).
 *
 * @param recoveryDecisionId a decision the caller already holds; otherwise the
 *   planner's decision for the current episode is used.
 */
export function enterRepairing(store: MissionStore, missionId: string, recoveryDecisionId?: string): Mission {
  const mission = store.getMission(missionId);
  if (!mission) throw new Error(`unknown mission ${missionId}`);
  if (mission.status === "REPAIRING") return mission;
  if (mission.status !== "BLOCKED") return store.transitionMission(missionId, "REPAIRING");
  const decision = recoveryDecisionId
    ? store.getRecoveryDecision(recoveryDecisionId)
    : plannedRepairDecision(store, missionId);
  if (!decision) throw new RepairEntryBlockedError(mission);
  return store.transitionMission(missionId, "REPAIRING", "system", { recoveryDecisionId: decision.recoveryId });
}
