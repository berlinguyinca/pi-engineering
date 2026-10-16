export interface SupervisableMission {
  mission_id: string;
  status: string;
}

/**
 * Supervisor custody for externally submitted missions (MSN-ext-*).
 *
 * An external mission in NEW is owned by the external pump: the runtime adopts it
 * via runSubmittedMission, which acquires the mission lease and moves it past NEW.
 * While it is still NEW (submission receipt lease live or not) the supervisor must
 * not run its health/recovery lifecycle over it — "no tasks yet" is the expected
 * state of an unstarted external mission, not REQUIREMENT_AMBIGUITY. Every other
 * mission, and every external mission already adopted (status past NEW), is
 * supervised normally.
 */
export function supervisorAdmitsMission(mission: SupervisableMission): boolean {
  return !(mission.mission_id.startsWith("MSN-ext-") && mission.status === "NEW");
}
