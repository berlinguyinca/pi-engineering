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
import type { GitRepo } from "../../src/git/GitRepo.ts";
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
  /** Fail the first N post-resume validation runs, then recover. */
  validationFailTimes?: number;
  onValidation?: (signal: AbortSignal) => Promise<void>;
  probe?: () => Promise<{ healthy: boolean }>;
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
      runValidation: async ({ signal }) => {
        calls.validation++;
        await opts.onValidation?.(signal);
        if (calls.validation <= (opts.validationFailTimes ?? 0)) {
          return { executionId: "e", exitStatus: "failed", summary: "suite red", artifactRefs: [], usage: {} };
        }
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "valid",
          artifactRefs: [],
          usage: {},
          validationEvidence: {
            command: "npm test",
            profile: "test",
            exitCode: 0,
            testSummary: { passed: 1 },
            noTargets: false,
            accessible: true,
            acceptanceResults: [],
          },
        };
      },
    },
    review: {
      runReview: async ({ acceptanceCriteria }) => {
        calls.review++;
        return {
          executionId: "e",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings: [],
          reviewEvidence: {
            reviewerSessionId: "review-resilience",
            model: "test",
            provider: "test",
            verdict: "approve",
            independenceMode: "independent",
            findings: [],
            outputValid: true,
            accessible: true,
            acceptanceResults: (acceptanceCriteria ?? []).map((criterion) => ({
              acceptanceId: criterion.acceptanceId,
              status: "passed" as const,
              detail: "checked",
            })),
          },
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
    git: {
      root: process.cwd(),
      headCommit: async () => "candidate-test-sha",
      captureDiff: async () => "diff --git a/src/health.ts b/src/health.ts",
      changedFiles: async () => ["src/health.ts"],
    } as unknown as GitRepo,
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "none" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id ? [criterion.acceptance_id] : [],
        ),
        max_attempts: 3,
        failure_policy: "retry" as const,
      },
    ],
    resilience: shortResilience,
    probe: { probe: opts.probe ?? (async () => ({ healthy: probeHealthy })) },
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

  it("forced resume completes the full lifecycle with validation and independent review", async () => {
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

    // The worker can run again even though the probe has not caught up yet.
    down = false;
    const resumed = await h.orchestrator.resume(missionId, { force: true });
    // Resume is equivalent to an uninterrupted run: it does not stop at EXECUTING.
    const agentTask = h.store.listTasks(missionId).find((t) => t.kind === "agent")!;
    assert.equal(agentTask.status, "SUCCEEDED");
    assert.equal(resumed.status, "COMPLETE");
    assert.equal(h.calls.validation, 1, "required validation must run after the resumed worker settles");
    assert.equal(h.calls.review, 1, "required independent review must run after resumed validation");
    assert.equal(h.orchestrator.gate.evaluate(resumed).can_complete, true);
  });

  it("resume attempts bounded repair and blocks when validation remains red", async () => {
    let down = true;
    const h = harness({ failWhileDown: () => down, validationFailTimes: 99 });
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const missionId = result.mission.mission_id;
    down = false;

    const resumed = await h.orchestrator.resume(missionId, { force: true });

    assert.equal(resumed.status, "BLOCKED");
    assert.ok(h.calls.validation >= 2, "the resumed repair path must re-run validation");
    assert.ok(h.calls.review >= 2, "the resumed repair path must perform a fresh review");
    const repairs = h.store
      .listTasks(missionId)
      .filter((task) => task.kind === "agent" && task.objective.includes("Fix the failing validation"));
    assert.ok(repairs.length >= 1, "a failed resumed gate must create repair work");
    assert.ok(repairs.length <= 4, `repair must remain bounded, got ${repairs.length}`);
  });

  it("aborting a resumed mission cancels its active finalization gate", async () => {
    let down = true;
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const h = harness({
      failWhileDown: () => down,
      onValidation: async (signal) => {
        validationStarted();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    });
    const initial = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    down = false;
    const controller = new AbortController();
    const pending = h.orchestrator.resume(initial.mission.mission_id, { force: true, signal: controller.signal });

    await started;
    controller.abort();
    const resumed = await pending;

    assert.equal(resumed.status, "CANCELED");
    assert.equal(h.calls.review, 0);
    assert.ok(
      h.store
        .listTasks(initial.mission.mission_id)
        .some((task) => task.kind === "validation" && task.status === "CANCELED"),
    );
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

  it("a pre-aborted resume cancels without probing or launching work", async () => {
    const h = harness({ failWhileDown: () => true });
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const before = h.calls.agent;
    const controller = new AbortController();
    controller.abort();

    const resumed = await h.orchestrator.resume(result.mission.mission_id, { signal: controller.signal });

    assert.equal(resumed.status, "CANCELED");
    assert.equal(h.calls.agent, before);
  });

  it("aborting resume interrupts an in-flight gateway health probe", async () => {
    let hangProbe = false;
    const h = harness({
      failWhileDown: () => true,
      probe: async () => {
        if (hangProbe) return new Promise(() => {});
        return { healthy: false };
      },
    });
    const initial = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    hangProbe = true;
    const controller = new AbortController();
    const pending = h.orchestrator.resume(initial.mission.mission_id, { signal: controller.signal });
    controller.abort();

    const resumed = await pending;

    assert.equal(resumed.status, "CANCELED");
  });
});
