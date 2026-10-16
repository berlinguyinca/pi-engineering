/** Pure restart-safety model for deciding whether a supervisor session may be safely restarted. */

export interface RestartStatusSession {
  sessionId: string;
  role: "supervisor" | "worker";
  state: "idle" | "running" | "paused" | "terminated";
  missionId?: string;
  lastHeartbeatAt?: string;
}

export interface RestartStatusOptions {
  /** Heartbeat staleness threshold in milliseconds. Defaults to 45000. */
  staleAfterMs?: number;
}

export interface RestartStatusResult {
  safeToRestartSupervisor: boolean;
  blockers: string[];
  staleSessions: string[];
  inFlightMissions: string[];
  summary: string;
}

export const DEFAULT_STALE_AFTER_MS = 45000;

/**
 * Compute whether it is safe to restart the supervisor session given the current
 * session snapshot. This is a pure function: no I/O, no mutation of inputs.
 */
export function computeRestartStatus(
  sessions: RestartStatusSession[],
  now: Date,
  opts?: RestartStatusOptions,
): RestartStatusResult {
  const staleAfterMs = opts?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const nowMs = now.getTime();
  const staleCutoffMs = nowMs - staleAfterMs;

  const blockers: string[] = [];
  const staleSessions: string[] = [];
  const inFlightMissions: string[] = [];
  const seenMissions = new Set<string>();

  let anyWorkerRunning = false;
  let supervisorState: RestartStatusSession["state"] | undefined;

  for (const session of sessions) {
    const isSupervisor = session.role === "supervisor";

    // Stale detection: a session that is not terminated with a heartbeat strictly
    // older than the cutoff is considered stale. A heartbeat exactly at the cutoff
    // is NOT stale. A missing or unparseable heartbeat is not stale.
    if (session.state !== "terminated" && session.lastHeartbeatAt !== undefined) {
      const heartbeatMs = Date.parse(session.lastHeartbeatAt);
      if (!Number.isNaN(heartbeatMs) && heartbeatMs < staleCutoffMs) {
        staleSessions.push(session.sessionId);
      }
    }

    // In-flight missions from workers that are running or paused with a mission.
    if (session.role === "worker" && (session.state === "running" || session.state === "paused") && session.missionId) {
      if (!seenMissions.has(session.missionId)) {
        seenMissions.add(session.missionId);
        inFlightMissions.push(session.missionId);
      }
    }

    // Blockers.
    if (session.role === "worker" && session.state === "running") {
      anyWorkerRunning = true;
      blockers.push(
        session.missionId
          ? `worker ${session.sessionId} (mission ${session.missionId}) is running`
          : `worker ${session.sessionId} is running`,
      );
    } else if (isSupervisor && session.state === "running") {
      blockers.push(`supervisor ${session.sessionId} is running`);
    }

    if (isSupervisor) {
      supervisorState = session.state;
    }
  }

  const supervisorBlocking =
    supervisorState !== undefined && supervisorState !== "idle" && supervisorState !== "paused";
  const safeToRestartSupervisor = !anyWorkerRunning && !supervisorBlocking;

  const summary = `safe=${safeToRestartSupervisor};blockers=${blockers.length};stale=${staleSessions.length};inFlight=${inFlightMissions.length}`;

  return { safeToRestartSupervisor, blockers, staleSessions, inFlightMissions, summary };
}
