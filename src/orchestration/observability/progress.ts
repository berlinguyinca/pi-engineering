/**
 * Weighted Mission DAG progress (spec 01).
 *
 * Progress is computed by Pi-Engineering from the mission DAG — task weights,
 * completed nodes, measurable running units, and deterministic lifecycle
 * signals. It is NEVER an LLM-provided percentage.
 *
 * Rules:
 *  - completed task -> 100% of its weight;
 *  - running with measurable units -> (completed/total) * weight;
 *  - running without units -> only a conservative lifecycle fraction;
 *  - pending/blocked/failed -> 0 until resolved;
 *  - active, non-verified missions are clamped BELOW 100;
 *  - 100% is reserved for a mission whose CompletionGate passed.
 *
 * Dynamic repair work may grow the denominator (progress may move backward).
 */

import type { MissionStatus, OrchestrationTask, TaskStatus } from "../types.ts";
import type { MissionTaskProgress, MissionTaskProgressState, ProgressHistoryPoint } from "./types.ts";

/** Default weights per task kind (spec 01 phase guidance, configurable). */
const DEFAULT_KIND_WEIGHT: Record<string, number> = {
  agent: 10,
  process: 8,
  review: 4,
  integration: 5,
  validation: 3,
  approval: 2,
  aggregation: 3,
  research: 6,
};

/** Weights by role for common roles (overrides kind where more precise). */
const DEFAULT_ROLE_WEIGHT: Record<string, number> = {
  implementer: 12,
  investigator: 7,
  reviewer: 4,
  integrator: 5,
  verifier: 3,
  repair: 4,
};

/** Conservative fraction credited to a running task without measurable units. */
const RUNNING_NO_UNITS_FRACTION = 0.2;

/** Map a store TaskStatus to a progress state. */
export function taskProgressState(status: TaskStatus): MissionTaskProgressState {
  switch (status) {
    case "SUCCEEDED":
      return "completed";
    case "RUNNING":
    case "RETRYING":
      return "running";
    case "READY":
      return "ready";
    case "WAITING":
      return "waiting";
    case "BLOCKED":
      return "blocked";
    case "FAILED":
      return "failed";
    default:
      return "pending";
  }
}

/** Derive a task's weight: explicit override, else role, else kind, else 1. */
export function weightForTask(task: Pick<OrchestrationTask, "kind" | "role">, explicitWeight?: number): number {
  if (explicitWeight !== undefined && explicitWeight > 0) return explicitWeight;
  const roleWeight = DEFAULT_ROLE_WEIGHT[task.role];
  if (roleWeight !== undefined) return roleWeight;
  const kindWeight = DEFAULT_KIND_WEIGHT[task.kind];
  if (kindWeight !== undefined) return kindWeight;
  return 1;
}

/** Per-task measurable unit progress (0..1), or null when not measurable. */
export function unitFraction(task: OrchestrationTask, units?: { completed: number; total: number }): number | null {
  if (!units || !Number.isFinite(units.total) || units.total <= 0) return null;
  const f = units.completed / units.total;
  return Math.max(0, Math.min(1, f));
}

export interface ProgressInput {
  missionId: string;
  tasks: OrchestrationTask[];
  missionStatus: MissionStatus;
  verifiedComplete: boolean;
  completionStatus: string;
  /** Per-task measurable units keyed by task_id (from observability state). */
  units?: Record<string, { completed: number; total: number }>;
  /** Per-task explicit weight overrides keyed by task_id. */
  weights?: Record<string, number>;
  /** Running tasks without units: credit a conservative lifecycle fraction. */
  creditRunningWithoutUnits?: boolean;
  /** Progress-history label for the current point (e.g. current phase). */
  historyLabel?: string;
  /**
   * Weight basis. Defaults to "weighted_dag" whenever weights are derived from
   * the DAG (explicit or kind/role). "inferred" marks a legacy mission whose
   * weights are only a fallback split (no weight-bearing metadata).
   */
  basis?: "weighted_dag" | "inferred";
}

export interface ProgressResult {
  approximatePercent: number;
  basis: "weighted_dag" | "inferred";
  verifiedComplete: boolean;
  tasks: MissionTaskProgress[];
  historyPoint: ProgressHistoryPoint;
}

/**
 * Compute weighted mission progress from the DAG. Returns the clamped
 * approximate percentage plus per-task progress records.
 */
export function computeProgress(input: ProgressInput): ProgressResult {
  const { tasks, verifiedComplete } = input;
  const total = tasks.reduce((sum, t) => sum + weightForTask(t, input.weights?.[t.task_id]), 0);

  let contributed = 0;
  const taskRecords: MissionTaskProgress[] = [];
  for (const t of tasks) {
    const w = weightForTask(t, input.weights?.[t.task_id]);
    const units = input.units?.[t.task_id];
    const state = taskProgressState(t.status);
    let contribution = 0;
    if (state === "completed") {
      contribution = w;
    } else if (state === "running") {
      const uf = unitFraction(t, units);
      if (uf !== null) {
        contribution = uf * w;
      } else if (input.creditRunningWithoutUnits) {
        contribution = RUNNING_NO_UNITS_FRACTION * w;
      }
    }
    contributed += contribution;
    taskRecords.push({
      taskId: t.task_id,
      title: t.objective,
      state,
      weight: w,
      units,
      startedAt: t.started_at ?? undefined,
      completedAt: t.completed_at ?? undefined,
      assignedWorkerId: t.assigned_execution_id ?? undefined,
      dependsOn: t.depends_on,
      waitingReason: t.status === "BLOCKED" ? "other" : t.status === "WAITING" ? "worker_dependency" : undefined,
    });
  }

  const raw = total > 0 ? (contributed / total) * 100 : 0;
  const complete = verifiedComplete && tasks.length > 0;

  let approximatePercent: number;
  if (complete) {
    // Only a passed CompletionGate may render 100.
    approximatePercent = 100;
  } else if (raw >= 100) {
    // Final validation before gate passes: show ~99, never 100.
    approximatePercent = 99;
  } else {
    approximatePercent = Math.floor(raw);
  }

  const historyPoint: ProgressHistoryPoint = {
    at: new Date().toISOString(),
    approximatePercent,
    label: input.historyLabel,
    meaningfulProgress: contributed > 0,
  };

  return {
    approximatePercent,
    // Weights are derived from the DAG (explicit or kind/role) by default;
    // "inferred" is only set explicitly for legacy missions.
    basis: input.basis ?? "weighted_dag",
    verifiedComplete: complete,
    tasks: taskRecords,
    historyPoint,
  };
}
