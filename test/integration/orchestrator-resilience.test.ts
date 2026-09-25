/**
 * End-to-end resilience acceptance scenario (spec: mission survives gateway
 * outages).
 *
 * Proves the FULL orchestrate() path: a worker transient-infrastructure failure
 * parks the mission, pauses it (not fails it) on window exhaustion, skips
 * post-execution, and resumes cleanly when the gateway recovers. Deterministic
 * clock (each sleep advances the simulated wall clock) so no real waiting.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { GatewayResilienceConfig } from "../../src/resilience/config.ts";

const shortResilience: GatewayResilienceConfig = {
  retry_window_ms: 1000,
  probe_interval_ms: 100,
  request_timeout_ms: 120_000,
  connect_timeout_ms: 10_000,
  jitter_ms: 0,
  circuit_breaker_threshold: 5,
  retry_transient_errors: true,
  preserve_mission_on_exhaustion: true,
  auto_resume_on_recovery: true,
};

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

interface HarnessOpts {
  /** The agent worker fails with a transient-infra marker until `healthy` flips. */
  failWhileDown: () => boolean;
}

function harness(opts: HarnessOpts) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const calls = { agent: 0, validation: 0, review: 0 };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () => {
        calls.agent++;
        if (opts.failWhileDown()) {
          return {
            executionId: "e",
            exitStatus: "failed",
            summary: "Worker failed: 503 no worker for model",
            artifactRefs: [],
            usage: {},
            error: "transient:server_unavailable",
          };
        }
        return { executionId: "e", exitStatus: "succeeded", summary: "implemented", artifactRefs: [], usage: {} };
      },
    },
    validation: {
      runValidation: async () => {
        calls.validation++;
        return { executionId: "e", exitStatus: "succeeded", summary: "valid", artifactRefs: [], usage: {} };
      },
    },
    review: {
      runReview: async () => {
        calls.review++;
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings: [],
        };
      },
    },
    process: {
      runProcess: async () => ({
        executionId: "e",
        exitStatus: "succeeded",
        summary: "ran",
        artifactRefs: [],
        usage: {},
      }),
    },
  };
  let probeHealthy = false;
  const clk = clock();
  const orchestrator = new Orchestrator({
    store,
    backends,
    planner: async () => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        max_attempts: 3,
        failure_policy: "retry" as const,
      },
    ],
    resilience: shortResilience,
    probe: { probe: async () => ({ healthy: probeHealthy }) },
    now: clk.now,
    sleep: clk.sleep,
    rand: () => 0,
  });
  return {
    orchestrator,
    store,
    calls,
    setProbeHealthy: (h: boolean) => {
      probeHealthy = h;
    },
  };
}

describe("resilience e2e — a gateway outage pauses (not fails) a live mission", () => {
  it("orchestrate() returns paused=true, mission is PAUSED, and post-execution is skipped", async () => {
    // Gateway stays down for the whole run.
    const h = harness({ failWhileDown: () => true });
    h.setProbeHealthy(false);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    // The mission did NOT complete and is NOT a failure: it paused.
    assert.equal(result.completed, false);
    assert.equal(result.paused, true);
    assert.equal(result.failureReason, null);
    const mission = h.store.getMission(result.mission.mission_id)!;
    assert.equal(mission.status, "PAUSED_INFRASTRUCTURE");
    // Post-execution (validation/review) must NOT have run over an interrupted mission.
    assert.equal(h.calls.validation, 0, "validation must be skipped while paused");
    assert.equal(h.calls.review, 0, "review must be skipped while paused");
    // The interrupted task is left resumable, not failed.
    const tasks = h.store.listTasks(mission.mission_id);
    const agentTask = tasks.find((t) => t.kind === "agent")!;
    assert.equal(agentTask.status, "RETRYING");
  });

  it("resume() re-runs the paused task once the gateway recovers", async () => {
    let down = true;
    const h = harness({ failWhileDown: () => down });
    h.setProbeHealthy(false);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.paused, true);
    const missionId = result.mission.mission_id;
    assert.equal(h.store.getMission(missionId)!.status, "PAUSED_INFRASTRUCTURE");

    // Gateway recovers: the probe reports healthy and the worker now succeeds.
    down = false;
    h.setProbeHealthy(true);
    const resumed = await h.orchestrator.resume(missionId);
    // The paused task re-ran and succeeded; the mission left the paused state.
    const agentTask = h.store.listTasks(missionId).find((t) => t.kind === "agent")!;
    assert.equal(agentTask.status, "SUCCEEDED");
    assert.notEqual(resumed.status, "PAUSED_INFRASTRUCTURE");
  });

  it("resume() is a no-op while the gateway is still down", async () => {
    const h = harness({ failWhileDown: () => true });
    h.setProbeHealthy(false);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const missionId = result.mission.mission_id;
    assert.equal(result.paused, true);
    // Gateway still down: resume() must leave the mission paused.
    const before = h.calls.agent;
    const resumed = await h.orchestrator.resume(missionId);
    assert.equal(resumed.status, "PAUSED_INFRASTRUCTURE");
    assert.equal(h.calls.agent, before, "no re-run while the gateway is still down");
  });
});
