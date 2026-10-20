/**
 * What an operator (or the parent model) needs to act on a mission that did
 * not complete: the preserved work, why tasks failed, what is left, and the
 * next step. Kept compact: bounded counts and truncated text, never logs.
 */

import { stripVTControlCharacters } from "node:util";
import { formatWaitingFor } from "../gateway/admissionNotice.ts";
import { latestTaskCheckpoints } from "../orchestration/checkpoints.ts";
import type { MissionStore } from "../orchestration/missionStore.ts";
import { taskFailureReason } from "../orchestration/recovery.ts";
import { PLANNER_CLARIFICATION_CATEGORY } from "../orchestration/types.ts";
import { describeMissionControl } from "../runtime/operatorModelPin.ts";
import { redactSecrets } from "../security/SecurityPolicy.ts";

export function missionActivityAge(at: string | null | undefined, now = Date.now()): string {
  const stamp = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(stamp) ? formatWaitingFor(Math.max(0, now - stamp)) : "not recorded";
}

const MAX_ITEMS = 5;

function clip(text: string, max: number): string {
  const flat = redactSecrets(stripVTControlCharacters(text))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  lines.push(...describeMissionControl(mission));
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
      // Never "no reason recorded": a task that recorded none still has an
      // execution outcome and a failure classification to name (#112).
      const reason = taskFailureReason(
        task,
        store.listExecutions(missionId),
        store.listFailureClassifications(missionId),
      );
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

  const asked = store
    .listFindings(missionId)
    .filter((finding) => finding.category === PLANNER_CLARIFICATION_CATEGORY && finding.status === "open")
    .at(-1);
  if (asked?.evidence) lines.push(`Planner question: ${clip(asked.evidence, 300)}`);

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

/** Operator-requested inspection of recorded, bounded telemetry; never hidden reasoning. */
export function formatMissionInspection(
  projection: import("../orchestration/observability/types.ts").MissionProjection,
  workerId?: string,
  now = Date.now(),
): string {
  const { summary, tests } = projection;
  const workers = projection.workers.filter((worker) => !workerId || worker.workerId === workerId);
  if (workerId && workers.length === 0) return `Worker ${clip(workerId, 80)} not found in ${summary.missionId}.`;
  const age = (at?: string | null) => missionActivityAge(at, now);
  const lines = [
    `${clip(summary.missionId, 80)} — ${clip(summary.title, 120)} [${summary.state}; ${summary.health.toUpperCase()}]`,
    `Acceptance ${summary.acceptanceCoverage.completed}/${summary.acceptanceCoverage.total} (${summary.acceptanceCoverage.approximatePercent}%) · workflow ${summary.workflowProgress.completed}/${summary.workflowProgress.total}`,
    `Now: ${clip(summary.currentActivity?.summary ?? summary.reason, 240)}`,
    `Heartbeat: ${age(summary.lastHeartbeatAt)} · meaningful progress: ${age(summary.lastMeaningfulProgressAt)}`,
    ...(summary.waitingReason ? [`Waiting: ${summary.waitingReason} for ${age(summary.waitingSince)}`] : []),
    `Next: ${clip(summary.nextAction, 240)}`,
    "Workers:",
  ];
  for (const worker of workers.slice(0, 20)) {
    lines.push(
      `  ${clip(worker.workerId, 80)} · task ${clip(worker.taskId ?? "not recorded", 80)} · ${worker.health ?? worker.state} · ${worker.route ? `${clip(worker.route, 80)} → ` : ""}${clip(worker.model ?? "model not recorded", 160)}${worker.node ? ` · node ${clip(worker.node, 80)}` : ""}`,
      `    ${clip(worker.currentActivity ?? "activity not recorded", 240)} · running ${age(worker.startedAt)} · output ${age(worker.lastOutputAt)} · heartbeat ${age(worker.lastHeartbeatAt)} · progress ${age(worker.lastMeaningfulProgressAt)}`,
      worker.lastOutputPreview
        ? `    Tool output (latest captured preview): ${clip(worker.lastOutputPreview, 1_000)}`
        : "    Tool output: not recorded (no captured tool result/update yet).",
    );
  }
  if (workers.length === 0) lines.push("  No workers recorded.");
  if (workers.length > 20) lines.push(`  ${workers.length - 20} more workers; inspect one by worker ID.`);
  lines.push("Recent activity (latest 20; recorded summaries):");
  for (const entry of projection.activity
    .filter((activity) => !workerId || activity.workerId === workerId)
    .slice(-20)) {
    lines.push(
      `  ${clip(entry.at, 40)} ${entry.workerId ? `[${clip(entry.workerId, 80)}] ` : ""}${clip(entry.summary, 300)}`,
    );
  }
  lines.push(
    `Changed files: ${
      projection.changes.changedFiles
        .slice(0, 20)
        .map((file) => clip(file, 120))
        .join(", ") || "none recorded"
    }`,
    `Tests: ${tests.running ? "running · " : ""}${tests.passed} passed · ${tests.failed} failed · ${tests.skipped} skipped · ${tests.retries} retries`,
    ...tests.failures.slice(-5).map((failure) => `  Failure: ${clip(failure, 240)}`),
    `Recovery attempts: ${projection.recovery.length}`,
    ...projection.recovery
      .slice(-5)
      .map(
        (attempt) =>
          `  ${attempt.attempt}: ${clip(attempt.action, 80)} [${attempt.status}] ${clip(attempt.summary, 240)}`,
      ),
    `Open blocking findings: ${projection.review.blockingOpen}`,
    ...projection.review.findings
      .filter((finding) => finding.severity === "blocking" && finding.status === "open")
      .slice(-5)
      .map((finding) => `  ${clip(finding.summary, 240)}`),
    ...projection.errors.slice(-5).map((error) => `  Error (${error.count}): ${clip(error.example, 240)}`),
  );
  return lines.join("\n");
}
