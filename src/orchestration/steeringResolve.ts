import type { ResolvedTarget } from "./steering.ts";
/**
 * Maps a Herdr graph node id (`task:<id>` / `mission:<id>`) to what Pi owns right now (T12/T16).
 *
 * `digest` is the plan digest of the target's mission, from the plan revision ledger: it is the value Herdr's
 * `expected_digest` names for a gate decision, so a request that carries one is only applied while it still holds
 * (see `applySteering`, which refuses a request naming a digest when none is available).
 */
import type { OrchestrationTask } from "./types.ts";

export interface SteeringStoreView {
  getTask(id: string): Pick<OrchestrationTask, "task_id" | "mission_id" | "status"> | undefined;
  getMission(id: string): { mission_id: string; status: string; operator_paused_at?: string | null } | undefined;
  listPlanRevisions(missionId: string): ReadonlyArray<{ planDigest: string }>;
}

export function currentPlanDigest(store: SteeringStoreView, missionId: string): string | null {
  const revisions = store.listPlanRevisions(missionId);
  return revisions.length > 0 ? (revisions[revisions.length - 1]?.planDigest ?? null) : null;
}

export function resolveSteeringTarget(store: SteeringStoreView, nodeId: string): ResolvedTarget | null {
  const [kind, ...rest] = nodeId.split(":");
  const id = rest.join(":");
  if (kind === "task") {
    const t = store.getTask(id);
    if (!t) return null;
    return {
      kind: "task",
      taskId: t.task_id,
      missionId: t.mission_id,
      running: t.status === "RUNNING",
      terminal: ["SUCCEEDED", "FAILED", "CANCELED", "SKIPPED"].includes(t.status),
      digest: currentPlanDigest(store, t.mission_id),
    };
  }
  if (kind === "mission") {
    const m = store.getMission(id);
    if (!m) return null;
    return {
      kind: "mission",
      missionId: m.mission_id,
      paused: m.status === "PAUSED_INFRASTRUCTURE",
      operatorPaused: Boolean(m.operator_paused_at),
      terminal: ["COMPLETE", "FAILED", "CANCELED"].includes(m.status),
      digest: currentPlanDigest(store, m.mission_id),
    };
  }
  return null;
}
