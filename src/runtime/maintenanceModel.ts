import type { RoleRouterAdapter } from "../capability/adapter.ts";
import { routerRoleFor } from "../capability/roles.ts";
import { type ModelRef, modelKey } from "../lifecycle/types.ts";
import type { OrchestrationTask } from "../orchestration/types.ts";
import type { UnavailableModels } from "./modelRouting.ts";

/** Fail closed: maintenance may replace a pin, never relax its execution contracts. */
export async function validateMaintenanceModel(options: {
  router?: Pick<RoleRouterAdapter, "registry" | "select">;
  selectedModel: ModelRef;
  previousModel?: ModelRef | null;
  baseline?: { contextWindow?: number; input?: readonly string[]; reasoning?: boolean };
  tasks: readonly Pick<OrchestrationTask, "role" | "kind" | "status" | "execution_requirements">[];
  unavailable: UnavailableModels;
}): Promise<string | undefined> {
  const { router, selectedModel, unavailable } = options;
  if (!router) return "model catalogue unavailable";
  await router.registry.ensureFresh();
  if (!router.registry.get(selectedModel)) return "selected model is not registered";
  if (unavailable.has(selectedModel)) return "selected model is unavailable";
  const previous = options.previousModel ? router.registry.get(options.previousModel) : undefined;
  if (options.previousModel && !previous) return "previous model capability contract is unavailable";
  const minContext = Math.max(previous?.contextWindow ?? 0, options.baseline?.contextWindow ?? 0);
  const preserveVision = previous?.capabilities.values.vision || options.baseline?.input?.includes("image");
  const preserveReasoning = previous?.capabilities.values.reasoning || options.baseline?.reasoning;
  const pending = options.tasks.filter(
    (task) =>
      !["SUCCEEDED", "CANCELED", "SKIPPED"].includes(task.status) &&
      ["agent", "research", "review"].includes(task.kind),
  );
  const roles = pending.length ? pending : [{ role: "planner", execution_requirements: {} }];
  for (const task of roles) {
    const role = routerRoleFor(task.role);
    if (!role) return `unknown worker role ${task.role}`;
    const requirements: Record<string, unknown> = task.execution_requirements;
    if (requirements.model !== undefined && requirements.model !== modelKey(selectedModel))
      return `task requires exact model ${String(requirements.model)}`;
    if (
      requirements.capabilities !== undefined &&
      (!Array.isArray(requirements.capabilities) ||
        requirements.capabilities.some((value) => typeof value !== "string"))
    )
      return "invalid task capability contract";
    const decision = await router.select(role, {
      taskOverride: modelKey(selectedModel),
      minContext,
      extraRequires: [
        ...(preserveVision ? ["vision"] : []),
        ...(preserveReasoning ? ["reasoning"] : []),
        ...((requirements.capabilities as string[] | undefined) ?? []),
      ],
    });
    if (!decision.selected || modelKey(decision.selected) !== modelKey(selectedModel))
      return (
        decision.rejected.find((entry) => modelKey(entry.model) === modelKey(selectedModel))?.reason ??
        `selected model cannot serve ${role}`
      );
  }
  return undefined;
}
