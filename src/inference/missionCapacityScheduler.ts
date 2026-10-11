/**
 * Production ResilientStreamScheduler (fault-tolerance spec §20/§21/§23).
 *
 * Bridges the resilient stream layer and the durable orchestration state
 * machine:
 *
 *   park(info)            → persist WAITING_FOR_CAPACITY on the mission. The
 *                           mission does NOT fail when inference capacity is
 *                           briefly absent — the state survives a restart and
 *                           the in-call keep-alive probe (or the long
 *                           transient-outage machinery after one) resumes it.
 *   resumed(info)         → bring the mission back to EXECUTING when capacity
 *                           returned and the same request was served.
 *   isCapacityAvailable() → ask the capability pool: is at least one model
 *                           neither penalized (modelHealth) nor circuit-OPEN
 *                           — the same shared services every armed runtime
 *                           reads, so the answer matches what the retry
 *                           ladder sees.
 *
 * Both transitions go through the caller-supplied guarded transition hook
 * (illegal transitions are ignored, never thrown), so a race with the
 * orchestrator's own state machine cannot take a mission down.
 */

import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import type { ModelRef } from "../lifecycle/types.ts";
import { resilientServices } from "./resilientInstall.ts";
import type { ResilientStreamScheduler } from "./resilientStream.ts";

export interface MissionCapacitySchedulerHooks {
  /**
   * Persist a mission state transition. Must not throw on illegal
   * transitions (the orchestrator's guarded transition semantics). Absent
   * (e.g. an interactive session with no mission store): park/resumed are
   * no-ops and only the in-call keep-alive owns the wait.
   */
  transitionMission?: (missionId: string, state: "WAITING_FOR_CAPACITY" | "EXECUTING", reason: string) => void;
  /** Capability pool for the capacity query. */
  registry?: () => ModelCapabilityRegistry | undefined;
}

export class MissionCapacityScheduler implements ResilientStreamScheduler {
  private readonly hooks: MissionCapacitySchedulerHooks;

  constructor(hooks: MissionCapacitySchedulerHooks = {}) {
    this.hooks = hooks;
  }

  /** Durable WAITING_FOR_INFERENCE_CAPACITY park (the mission does NOT fail). */
  park(info: { missionId?: string; workerId?: string; role: string; reason: string; untilMs: number }): void {
    if (!info.missionId || !this.hooks.transitionMission) return;
    this.hooks.transitionMission(
      info.missionId,
      "WAITING_FOR_CAPACITY",
      `inference capacity wait: ${info.reason} (until ${new Date(info.untilMs).toISOString()})`,
    );
  }

  /** Resume notice: capacity returned, the mission returns to execution. */
  resumed(info: { missionId?: string; role: string; waitedMs: number }): void {
    if (!info.missionId || !this.hooks.transitionMission) return;
    this.hooks.transitionMission(
      info.missionId,
      "EXECUTING",
      `inference capacity recovered after ${Math.max(0, Math.round(info.waitedMs / 1000))}s`,
    );
  }

  /** True iff at least one model in the pool is usable right now. */
  isCapacityAvailable(): boolean {
    const registry = this.hooks.registry?.();
    if (!registry || registry.size === 0) return false;
    const { health, breakers } = resilientServices();
    return registry.all().some((rec) => {
      const ref: ModelRef = { provider: rec.provider, id: rec.id };
      if (health.isPenalized(ref)) return false;
      return breakers.forModel(rec.provider, rec.id).getState() !== "OPEN";
    });
  }
}
