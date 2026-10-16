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
  warnings: string[];
  summary: string;
}

export const DEFAULT_STALE_AFTER_MS = 45000;

const ROLES = new Set(["supervisor", "worker"]);
const STATES = new Set(["idle", "running", "paused", "terminated"]);

function invalidInput(reason: string): RestartStatusResult {
  return {
    safeToRestartSupervisor: false,
    blockers: [`invalid input: ${reason}`],
    staleSessions: [],
    inFlightMissions: [],
    warnings: [],
    summary: "safe=false;invalid-input",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Compute whether it is safe to restart the supervisor session given the current
 * session snapshot. This is a pure function: no I/O, no mutation of inputs.
 */
export function computeRestartStatus(
  sessions: RestartStatusSession[],
  now: Date,
  opts?: RestartStatusOptions,
): RestartStatusResult {
  if (!Array.isArray(sessions)) {
    return invalidInput("sessions is not an array");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return invalidInput("now is not a Date with a finite time");
  }
  const staleAfterMs = opts?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    return invalidInput("staleAfterMs is not a finite number > 0");
  }

  for (const session of sessions) {
    if (!isPlainObject(session)) {
      return invalidInput("a session is not a plain object");
    }
    if (typeof session.sessionId !== "string") {
      return invalidInput("a session sessionId is not a string");
    }
    if (typeof session.role !== "string" || !ROLES.has(session.role)) {
      return invalidInput(`a session role is invalid: ${String(session.role)}`);
    }
    if (typeof session.state !== "string" || !STATES.has(session.state)) {
      return invalidInput(`a session state is invalid: ${String(session.state)}`);
    }
  }

  const nowMs = now.getTime();
  const staleCutoffMs = nowMs - staleAfterMs;

  const blockers: string[] = [];
  const staleSessions: string[] = [];
  const inFlightMissions: string[] = [];
  const warnings: string[] = [];
  const seenMissions = new Set<string>();

  for (const session of sessions) {
    // Terminated sessions are ignored for every purpose.
    if (session.state === "terminated") {
      continue;
    }

    const isSupervisor = session.role === "supervisor";

    // Stale detection: a missing or unparseable heartbeat is stale (fail
    // closed); a heartbeat strictly older than the cutoff is stale. A
    // heartbeat exactly at the cutoff is NOT stale.
    const heartbeatMs = session.lastHeartbeatAt !== undefined ? Date.parse(session.lastHeartbeatAt) : Number.NaN;
    if (Number.isNaN(heartbeatMs)) {
      staleSessions.push(session.sessionId);
    } else if (heartbeatMs < staleCutoffMs) {
      staleSessions.push(session.sessionId);
    }

    // In-flight missions from workers that are running or paused with a mission.
    if (session.role === "worker" && (session.state === "running" || session.state === "paused") && session.missionId) {
      if (!seenMissions.has(session.missionId)) {
        seenMissions.add(session.missionId);
        inFlightMissions.push(session.missionId);
      }
    }

    // Blockers. A worker blocks ONLY when running with a non-empty missionId.
    // A running worker without a missionId is a warning, not a blocker.
    if (session.role === "worker" && session.state === "running") {
      if (typeof session.missionId === "string" && session.missionId.length > 0) {
        blockers.push(`worker ${session.sessionId} (mission ${session.missionId}) is running`);
      } else {
        warnings.push(`worker ${session.sessionId} is running without a mission`);
      }
    } else if (isSupervisor && session.state === "running") {
      blockers.push(`supervisor ${session.sessionId} is running`);
    }
  }

  const safeToRestartSupervisor = blockers.length === 0;

  const summary = `safe=${safeToRestartSupervisor};blockers=${blockers.length};stale=${staleSessions.length};inFlight=${inFlightMissions.length};warnings=${warnings.length}`;

  return { safeToRestartSupervisor, blockers, staleSessions, inFlightMissions, warnings, summary };
}
