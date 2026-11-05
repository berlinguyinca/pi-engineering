/**
 * Which models and agents a mission uses, for the dashboard. Pure: it reads the
 * mission's persisted pin (the model its session started on, or the operator's
 * choice) and the workers the observability layer already tracks, and reports
 * each agent against that pin. An agent on another model is reported as such,
 * so a mission that left its starting model is visible instead of silent.
 */
import { ROLE_REQUIREMENTS, routerRoleFor } from "../capability/roles.ts";
import type { WorkerObservability } from "./observability/types.ts";
import { type RoutingDecision, describeRoutingDecision } from "./routingDecision.ts";
import type { Mission, OrchestrationTask } from "./types.ts";

export interface MissionModelAgent {
  workerId: string;
  taskId: string | null;
  role: string | null;
  model: string | null;
  state: string;
  /** True/false against the pin; null when there is no pin or the worker reported no model. */
  onPin: boolean | null;
  /** Why an off-pin agent is elsewhere; null when it is on the pin or there is nothing to say. */
  why: string | null;
}

export interface MissionModelSummary {
  /** "provider/id" the mission is pinned to, or null when it routes by role. */
  pin: string | null;
  pinnedAt: string | null;
  agents: MissionModelAgent[];
  /** Agents known to be running on a model other than the pin. */
  elsewhere: number;
}

function whyElsewhere(role: string | null): string {
  const routerRole = role ? routerRoleFor(role) : undefined;
  if (routerRole && ROLE_REQUIREMENTS[routerRole].independent) {
    return "independent review runs on a different model than the work it reviews";
  }
  return "the pinned model could not serve this role or was unavailable";
}

/** The recorded reason for this task+role, when it names the model the worker actually runs on. */
function recordedWhy(
  decisions: ReadonlyArray<RoutingDecision>,
  taskId: string | undefined,
  role: string | null,
  model: string | null,
): string | null {
  if (!taskId || !role || !model) return null;
  const decision = decisions.find((d) => d.taskId === taskId && d.role === role);
  if (!decision || decision.reason === "pin_honoured") return null;
  const ran = decision.chosen;
  // A decision about another model than the one running is stale: say nothing rather than guess.
  if (!ran || (ran !== model && ran.split("/").slice(1).join("/") !== model)) return null;
  return describeRoutingDecision(decision);
}

const keyOf = (pin: { provider: string; id: string }): string => `${pin.provider}/${pin.id}`;

export function summarizeMissionModels(
  mission: Pick<Mission, "operator_model_pin">,
  tasks: ReadonlyArray<Pick<OrchestrationTask, "task_id" | "role">>,
  workers: ReadonlyArray<Pick<WorkerObservability, "workerId" | "taskId" | "model" | "state">>,
  /** Recorded routing decisions (latest per task+role); the recorded reason beats the generic text. */
  decisions: ReadonlyArray<RoutingDecision> = [],
): MissionModelSummary {
  const pin = mission.operator_model_pin ? keyOf(mission.operator_model_pin) : null;
  const roles = new Map(tasks.map((task) => [task.task_id, task.role]));
  const agents = workers.map((worker): MissionModelAgent => {
    const model = worker.model ?? null;
    const role = (worker.taskId ? roles.get(worker.taskId) : undefined) ?? null;
    const onPin = pin && model ? model === pin || model === mission.operator_model_pin?.id : null;
    return {
      workerId: worker.workerId,
      taskId: worker.taskId ?? null,
      role,
      model,
      state: worker.state,
      onPin,
      why: onPin === false ? (recordedWhy(decisions, worker.taskId, role, model) ?? whyElsewhere(role)) : null,
    };
  });
  return {
    pin,
    pinnedAt: mission.operator_model_pin?.set_at ?? null,
    agents,
    elsewhere: agents.filter((agent) => agent.onPin === false).length,
  };
}
