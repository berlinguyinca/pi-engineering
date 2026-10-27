import type { RuntimeMissionActivityEvent } from "../runtime/EngineeringRuntime.ts";
import { missionActivityAge } from "../tools/missionReport.ts";

/** What the footer, the panel and mission presence all render for one mission. */
export interface MissionActivityRendering {
  phase: string;
  detail: string;
  missionStatus: { token: string; reason: string; next: string; live?: string };
}

/** Feed live mission detail into persistent surfaces without creating notices. */
export function formatMissionActivity(event: RuntimeMissionActivityEvent): MissionActivityRendering {
  const now = event.observedAt ? Date.parse(event.observedAt) : Date.now();
  const age = (at?: string | null) => missionActivityAge(at, now);
  const liveWorkers = event.workersDetail?.filter((entry) => entry.status === "running" || entry.status === "waiting");
  const worker =
    liveWorkers?.find((entry) => entry.health === "stalled") ??
    liveWorkers?.[0] ??
    event.workersDetail?.find((entry) => entry.status === "failed" || entry.status === "completed");
  const activity = (worker?.currentActivity ?? event.summary).replace(/\s+/g, " ").slice(0, 100);
  const duration = worker?.currentActivityStartedAt ? ` for ${age(worker.currentActivityStartedAt)}` : "";
  const lastHeartbeat = worker ? worker.lastHeartbeatAt : event.lastHeartbeatAt;
  const lastProgress = worker ? worker.lastMeaningfulProgressAt : event.lastMeaningfulProgressAt;
  const heartbeat = ` · heartbeat ${age(lastHeartbeat)}${lastHeartbeat ? " ago" : ""}`;
  const lastOutput = worker ? worker.lastOutputAt : event.lastOutputAt;
  const output = `output ${age(lastOutput)}${lastOutput ? " ago" : ""}`;
  const progress = `progress ${age(lastProgress)}${lastProgress ? " ago" : ""}`;
  const model = worker?.model ? ` · ${worker.route ? `${worker.route} → ` : ""}${worker.model}` : "";
  const waiting = event.waitingReason
    ? ` · wait ${event.waitingReason.replaceAll("_", " ")}${event.waitingSince ? ` for ${age(event.waitingSince)}` : ""}`
    : "";
  const live = `${event.health.toUpperCase()} · ${activity.slice(0, 36)}${duration} · ${output}`;
  const workers = ` · workers ${event.activeWorkers} active/${event.waitingWorkers} waiting/${event.failedWorkers} failed`;

  const compact = (value: string | null, fallback: string, length = 80) => (value ?? fallback).slice(0, length);
  const scope =
    `repo ${compact(event.repository, "unknown")} · task ${compact(worker?.taskId ?? event.task, "none")} · ` +
    `owner ${compact(event.owner, "unowned")}`;
  const recovery = `recovery ${event.recovery.attempt}/${event.recovery.maxAttempts}`;
  const next = `next ${event.nextAction.slice(0, 120)}${event.nextActionAt ? ` at ${event.nextActionAt}` : ""}`;
  const preserved =
    event.preservedWork.length > 0 ? ` · preserved ${event.preservedWork.join(", ").slice(0, 120)}` : "";
  const nextVerb = event.nextAction.trim().split(/\s+/)[0]?.slice(0, 12) || "monitor";
  const recoveryToken =
    event.recovery.maxAttempts > 0 ? `R${event.recovery.attempt}/${event.recovery.maxAttempts}` : "R–";
  const pausedByOperator = event.operatorPausedAt
    ? `PAUSED by operator at ${event.operatorPausedAt} — automatic repair is off; resume with /mission resume ${event.missionId} (add --model auto to release a model pin)`
    : null;
  const pin = event.operatorModelPin ? ` · model: ${event.operatorModelPin} (operator pin)` : "";
  const token = pausedByOperator
    ? `${recoveryToken} PAUSED (operator)`
    : `${recoveryToken} ${event.action.slice(0, 12).toUpperCase()}→${nextVerb}`;
  return {
    phase:
      `acceptance ${event.acceptanceCoverage.completed}/${event.acceptanceCoverage.total} ` +
      `(${event.acceptanceCoverage.approximatePercent}%) · workflow ${event.workflowProgress.completed}/` +
      `${event.workflowProgress.total} (${event.workflowProgress.approximatePercent}%) · ${event.health}`,
    detail:
      `Now: ${activity}${duration} · ${output}${heartbeat} · ${progress}${model}${waiting}${workers} · ${scope} · ` +
      `${recovery}${preserved} · ${event.action}: ${event.reason.slice(0, 120)} · ${next}${pin}`,
    missionStatus: pausedByOperator
      ? { token, reason: "paused by the operator (Esc); automatic repair is off", next: pausedByOperator }
      : {
          token,
          live,
          reason: event.reason.slice(0, 160),
          next: `${event.nextAction.slice(0, 160)}${event.nextActionAt ? ` at ${event.nextActionAt}` : ""}`,
        },
  };
}
