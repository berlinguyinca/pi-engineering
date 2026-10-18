import type { MaintenanceOutcome, MaintenanceRequest, RuntimeDescription } from "./maintenance.ts";

interface HostControl {
  describe(): Promise<RuntimeDescription>;
  reload(options: { expectedCommit: string; sourceRoot?: string; timeoutMs?: number }): Promise<{
    ok: boolean;
    commit: string | null;
    generation: number | null;
    error?: string;
  }>;
}

interface RuntimeControl {
  prepareForMaintenance?(options: { timeoutMs: number }): Promise<{ status: string; reason?: string }>;
  resumeMissionAfterMaintenance?(
    missionId: string,
    fence: {
      expectedRevision: number;
      expectedResumptionGeneration: number;
    },
  ): Promise<{ status: string; reason?: string; mission?: { mission_id: string } }>;
}

export interface MaintenanceDependencies {
  getHost: () => HostControl | undefined;
  getRuntime: (missionId?: string) => Promise<RuntimeControl | null>;
  ownedMissionIds: () => Promise<string[]>;
}

/** Control is executed directly by the runtime, never translated to model prompts. */
export function maintenanceHandler(
  deps: MaintenanceDependencies,
): (request: MaintenanceRequest) => Promise<MaintenanceOutcome> {
  return async (request) => {
    const host = deps.getHost();
    if (!host) throw new Error("host_maintenance_unavailable_bootstrap_required");
    if (request.action === "describe") return { status: "succeeded", result: { ...(await host.describe()) } };
    if (request.action === "reload") {
      const result = await host.reload({
        expectedCommit: request.expectedCommit!,
        ...(request.sourceRoot ? { sourceRoot: request.sourceRoot } : {}),
        timeoutMs: request.timeoutMs ?? 30_000,
      });
      if (!result.ok || result.commit !== request.expectedCommit)
        return { status: "failed", result: { ...result }, error: result.error ?? "activation_not_verified" };
      return { status: "succeeded", result: { ...result } };
    }
    if (request.action === "prepare") {
      const runtime = await deps.getRuntime();
      if (!runtime?.prepareForMaintenance)
        return { status: "skipped", result: { status: "busy", reason: "runtime_not_ready" } };
      const result = await runtime.prepareForMaintenance({ timeoutMs: request.timeoutMs ?? 30_000 });
      return { status: result.status === "ready" ? "succeeded" : "skipped", result: { ...result } };
    }
    if (request.action !== "resume") throw new Error("unsupported_maintenance_action");
    const description = await host.describe();
    if (description.commit !== request.expectedCommit || description.pending) throw new Error("loaded_commit_mismatch");
    if (!(await deps.ownedMissionIds()).includes(request.missionId!)) throw new Error("mission_not_owned_by_session");
    const runtime = await deps.getRuntime(request.missionId);
    const current = await host.describe();
    if (current.commit !== description.commit || current.generation !== description.generation || current.pending)
      throw new Error("runtime_generation_changed");
    if (!runtime?.resumeMissionAfterMaintenance) throw new Error("maintenance_resume_unavailable");
    const result = await runtime.resumeMissionAfterMaintenance(request.missionId!, {
      expectedRevision: request.expectedRevision!,
      expectedResumptionGeneration: request.expectedResumptionGeneration!,
    });
    return {
      status: result.status === "resumed" ? "succeeded" : "skipped",
      result: {
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        missionId: request.missionId,
      },
    };
  };
}
