/**
 * What an operator (or the parent model) needs to act on a mission that did
 * not complete: the preserved work, why tasks failed, what is left, and the
 * next step. Kept compact: bounded counts and truncated text, never logs.
 */

import { formatWaitingFor } from "../gateway/admissionNotice.ts";
import { latestTaskCheckpoints } from "../orchestration/checkpoints.ts";
import type { MissionStore } from "../orchestration/missionStore.ts";
import { describeMissionModel } from "../runtime/operatorModelPin.ts";

const MAX_ITEMS = 5;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * How long the mission has been running, when anything last happened, and
 * what it is doing now. Missions have no deadline, so a long-running one must
 * always be observable — and cancellable by the user — rather than cut off.
 */
export function missionProgressLine(store: MissionStore, missionId: string, now: number = Date.now()): string | null {
  const mission = store.getMission(missionId);
  if (!mission) return null;
  const started = Date.parse(mission.created_at);
  const stamps = [
    mission.updated_at,
    ...store.listTasks(missionId).flatMap((task) => [task.started_at, task.completed_at]),
    ...store.listExecutions(missionId).flatMap((execution) => [execution.started_at, execution.ended_at]),
    ...store.listTaskCheckpoints(missionId).map((checkpoint) => checkpoint.createdAt),
  ]
    .map((stamp) => (stamp ? Date.parse(stamp) : Number.NaN))
    .filter(Number.isFinite);
  const lastActivity = stamps.length > 0 ? Math.max(...stamps) : started;
  const running = store.listTasks(missionId).filter((task) => task.status === "RUNNING");
  const stage =
    running.length > 0
      ? `${mission.status} (${running.map((task) => `${task.role} "${clip(task.objective, 60)}"`).join(", ")})`
      : mission.status;
  const elapsed = Number.isFinite(started) ? formatWaitingFor(now - started) : "unknown";
  return `Elapsed: ${elapsed} · last activity ${formatWaitingFor(now - lastActivity)} ago · stage ${stage}`;
}

export function missionReportLines(store: MissionStore, missionId: string): string[] {
  const mission = store.getMission(missionId);
  if (!mission || mission.status === "COMPLETE") return [];
  const lines: string[] = [];
  const progress = missionProgressLine(store, missionId);
  if (progress) lines.push(progress);
  const model = describeMissionModel(mission);
  if (model) lines.push(model);
  const generation = store.listMissionResumptions(missionId).at(-1)?.generation ?? 0;
  const stop = store
    .listMissionStops(missionId)
    .filter((candidate) => candidate.resumptionGeneration === generation)
    .at(-1);
  if (stop) lines.push(`Stopped: ${clip(stop.reason, 240)}`);

  const checkpoints = latestTaskCheckpoints(store.listTaskCheckpoints(missionId));
  const preserved = [
    ...checkpoints.map((checkpoint) =>
      [
        checkpoint.branch ? `branch ${checkpoint.branch}` : null,
        checkpoint.candidateSha ? `commit ${checkpoint.candidateSha.slice(0, 12)}` : null,
        checkpoint.worktree ? `worktree ${checkpoint.worktree}` : null,
      ]
        .filter(Boolean)
        .join(", "),
    ),
    ...(stop?.preservedWork ?? []).filter(
      (ref) => !checkpoints.some((checkpoint) => [checkpoint.branch, checkpoint.worktree].includes(ref)),
    ),
  ].filter((entry) => entry.length > 0);
  if (preserved.length > 0) {
    lines.push("Preserved work:");
    for (const entry of preserved.slice(0, MAX_ITEMS)) lines.push(`  - ${clip(entry, 200)}`);
  }

  const failed = store
    .listTasks(missionId)
    .filter((task) => task.status === "FAILED" && !store.isTaskSatisfiedBySupersession(task.task_id));
  if (failed.length > 0) {
    lines.push(`Failed tasks (${failed.length}):`);
    for (const task of failed.slice(-MAX_ITEMS)) {
      const reason = (task as { failure_reason?: string | null }).failure_reason ?? "no reason recorded";
      lines.push(`  - ${task.task_id} ${task.kind}:${task.role} "${clip(task.objective, 80)}": ${clip(reason, 200)}`);
    }
  }

  const remaining = [...new Set(checkpoints.flatMap((checkpoint) => checkpoint.remainingDeliverables))];
  if (remaining.length > 0) {
    lines.push("Remaining deliverables:");
    for (const deliverable of remaining.slice(0, MAX_ITEMS * 2)) lines.push(`  - ${clip(deliverable, 160)}`);
  }

  const blocking = store
    .listFindings(missionId)
    .filter((finding) => finding.severity === "blocking" && finding.status === "open");
  if (blocking.length > 0) {
    lines.push(`Open blocking findings (${blocking.length}):`);
    for (const finding of blocking.slice(-MAX_ITEMS)) lines.push(`  - ${clip(finding.summary, 200)}`);
  }

  const resume = `mission tool {action:"resume", missionId:"${missionId}"} (or /mission resume ${missionId})`;
  if (stop) {
    lines.push(`Next step: ${clip(stop.resumeCondition, 200)}; then resume with ${resume}.`);
  } else if (mission.status === "BLOCKED" || mission.status === "WAITING_FOR_USER") {
    lines.push(
      `Next step: address the reasons above, then resume with ${resume}; check progress with {action:"status"}.`,
    );
  } else if (mission.status !== "FAILED" && mission.status !== "CANCELED") {
    lines.push(
      `Next step: the mission is still ${mission.status} (no deadline: it runs while it makes progress); check it with {action:"status", missionId:"${missionId}"}, or cancel the running mission to stop it.`,
    );
  }
  return lines;
}
