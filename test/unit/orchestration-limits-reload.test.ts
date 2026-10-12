/**
 * Mission time limits are operator policy, not process constants.
 *
 * Regression (2026-10-10): `limits` was read once when the orchestrator was
 * constructed, so deleting `limits.max_task_wall_clock_ms` from
 * ~/.pi/agent/engineering.yaml left the running process enforcing the deleted
 * cap — missions kept settling BLOCKED at exactly the old value ("configured
 * task wall-clock limit (limits.max_task_wall_clock_ms) reached") for the life
 * of the process. The orchestrator now refreshes the limits before every
 * mission and every resume.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MissionLimitsConfig } from "../../src/lifecycle/policy.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const noEnvOverride = !process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS;
const NO_CAP: MissionLimitsConfig = { worker_inactivity_ms: 3_600_000 };
const CAPPED: MissionLimitsConfig = { max_task_wall_clock_ms: 5_400_000, worker_inactivity_ms: 3_600_000 };

function harness(
  initial: MissionLimitsConfig,
  reloaded: MissionLimitsConfig,
  provider?: () => Promise<MissionLimitsConfig>,
) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  let calls = 0;
  const orchestrator = new Orchestrator({
    store,
    backends: {},
    planner: async () => [],
    worksetPolicy: { maxTaskBudgetMs: initial.max_task_wall_clock_ms },
    timeLimits: { maxMissionWallClockMs: initial.max_mission_wall_clock_ms },
    limitsProvider:
      provider ??
      (async () => {
        calls++;
        return reloaded;
      }),
  });
  return { store, orchestrator, callCount: () => calls };
}

describe("mission time limits reload from policy", () => {
  it("applies the reloaded caps and hung-worker window", async () => {
    const h = harness(CAPPED, { max_mission_wall_clock_ms: 86_400_000, worker_inactivity_ms: 10_800_000 });
    assert.equal(h.orchestrator.currentTimeLimits().maxTaskBudgetMs, 5_400_000, "startup snapshot has the cap");
    await h.orchestrator.refreshMissionLimits();
    const limits = h.orchestrator.currentTimeLimits();
    // The operator deleted the task cap: it must be gone, not still enforced.
    assert.equal(limits.maxTaskBudgetMs, undefined);
    assert.equal(limits.maxMissionWallClockMs, 86_400_000);
    if (noEnvOverride) assert.equal(limits.workerInactivityMs, 10_800_000);
  });

  it("refreshes before a mission runs, not only at construction", async () => {
    const h = harness(NO_CAP, { max_task_wall_clock_ms: 7_200_000, worker_inactivity_ms: 3_600_000 });
    assert.equal(h.orchestrator.currentTimeLimits().maxTaskBudgetMs, undefined, "construction snapshot has no cap");
    await h.orchestrator.orchestrate("Explain the reload contract", {
      repository: ".",
      baseRef: "",
      mutationRequested: false,
    });
    assert.equal(h.callCount(), 1, "the mission must re-read policy, not reuse the startup snapshot");
    assert.equal(h.orchestrator.currentTimeLimits().maxTaskBudgetMs, 7_200_000);
  });

  it("keeps the limits it started with when the policy provider fails", async () => {
    const h = harness(CAPPED, NO_CAP, async () => {
      throw new Error("policy unreadable");
    });
    await h.orchestrator.refreshMissionLimits();
    assert.equal(h.orchestrator.currentTimeLimits().maxTaskBudgetMs, 5_400_000);
  });
});
