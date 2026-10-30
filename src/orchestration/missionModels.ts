import type { WorkerObservability } from "./observability/types.ts";
/**
 * Which models and agents a mission uses, for the dashboard. Pure: it reads the
 * mission's persisted pin (the model its session started on, or the operator's
 * choice) and the workers the observability layer already tracks, and reports
 * each agent against that pin. An agent on another model is reported as such,
 * so a mission that left its starting model is visible instead of silent.
 */
import type { Mission, OrchestrationTask } from "./types.ts";

export interface MissionModelAgent {
  workerId: string;
  taskId: string | null;
  role: string | null;
  model: string | null;
  state: string;
  /** True/false against the pin; null when there is no pin or the worker reported no model. */
  onPin: boolean | null;
}

export interface MissionModelSummary {
  /** "provider/id" the mission is pinned to, or null when it routes by role. */
  pin: string | null;
  pinnedAt: string | null;
  agents: MissionModelAgent[];
  /** Agents known to be running on a model other than the pin. */
  elsewhere: number;
}

const keyOf = (pin: { provider: string; id: string }): string => `${pin.provider}/${pin.id}`;

export function summarizeMissionModels(
  mission: Pick<Mission, "operator_model_pin">,
  tasks: ReadonlyArray<Pick<OrchestrationTask, "task_id" | "role">>,
  workers: ReadonlyArray<Pick<WorkerObservability, "workerId" | "taskId" | "model" | "state">>,
): MissionModelSummary {
  const pin = mission.operator_model_pin ? keyOf(mission.operator_model_pin) : null;
  const roles = new Map(tasks.map((task) => [task.task_id, task.role]));
  const agents = workers.map((worker): MissionModelAgent => {
    const model = worker.model ?? null;
    return {
      workerId: worker.workerId,
      taskId: worker.taskId ?? null,
      role: (worker.taskId ? roles.get(worker.taskId) : undefined) ?? null,
      model,
      state: worker.state,
      onPin: pin && model ? model === pin || model === mission.operator_model_pin?.id : null,
    };
  });
  return {
    pin,
    pinnedAt: mission.operator_model_pin?.set_at ?? null,
    agents,
    elsewhere: agents.filter((agent) => agent.onPin === false).length,
  };
}
