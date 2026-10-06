/**
 * What an operator (or the parent model) needs to act on a mission that did
 * not complete: the preserved work, why tasks failed, what is left, and the
 * next step. Kept compact: bounded counts and truncated text, never logs.
 */

import { latestTaskCheckpoints } from "../orchestration/checkpoints.ts";
import type { MissionStore } from "../orchestration/missionStore.ts";

const MAX_ITEMS = 5;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function missionReportLines(store: MissionStore, missionId: string): string[] {
  const mission = store.getMission(missionId);
  if (!mission || mission.status === "COMPLETE") return [];
  const lines: string[] = [];
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
      `Next step: the mission is still ${mission.status}; check it with {action:"status", missionId:"${missionId}"}.`,
    );
  }
  return lines;
}
