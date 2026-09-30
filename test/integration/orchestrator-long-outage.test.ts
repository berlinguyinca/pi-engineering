/**
 * A mission whose gateway stays down past the retry horizon PAUSES (never
 * fails) and, once the recovery probe reports healthy again, resumes on its own
 * and completes — all inside one orchestrate() call, on a fake clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DEFAULT_GATEWAY_RESILIENCE, type GatewayResilienceConfig } from "../../src/resilience/config.ts";
import type { ProbeResult } from "../../src/resilience/probe.ts";

const HOUR = 3_600_000;

type AgentOutcome = Awaited<ReturnType<NonNullable<BrokerBackends["agent"]>["runAgent"]>>;

interface HarnessOverrides {
  /** Replace the outage-driven agent: receives the 0-based call index. */
  agent?: (call: number) => AgentOutcome;
  /** Replace the outage-driven probe answer. */
  probe?: () => ProbeResult;
  resilience?: GatewayResilienceConfig;
}

function run(outageMs: number, overrides: HarnessOverrides = {}) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  let now = 0;
  let agentCalls = 0;
  const statuses: string[] = [];
  const down = () => now < outageMs;
  const ok = { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () =>
        overrides.agent
          ? overrides.agent(agentCalls++)
          : down()
            ? {
                executionId: "e",
                exitStatus: "failed",
                summary: "capacity_unavailable",
                artifactRefs: [],
                usage: {},
                error: "transient:server_unavailable",
              }
            : ok,
    },
    validation: {
      runValidation: async () => ({
        ...ok,
        validationEvidence: {
          command: "npm test",
          profile: "test",
          exitCode: 0,
          testSummary: { passed: 1 },
          noTargets: false,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    review: {
      runReview: async ({ acceptanceCriteria }) => ({
        ...ok,
        findings: [],
        reviewEvidence: {
          reviewerSessionId: "review-long-outage",
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
      }),
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    git: {
      root: process.cwd(),
      headCommit: async () => "candidate-test-sha",
      captureDiff: async () => "diff --git a/src/health.ts b/src/health.ts",
      changedFiles: async () => ["src/health.ts"],
      loadCandidateLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadIntegrationRunInventory: async () => ({ records: [], diagnostics: [] }),
      loadPromotionLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
      loadPendingBranchCleanupInventory: async () => ({ records: [], diagnostics: [] }),
    } as unknown as GitRepo,
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement",
        mutates_repo: true,
        write_domains: ["src/**"],
        // This fake-clock resilience harness has no Git provider and exercises
        // retry lifecycle only, so direct execution is explicit.
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
    resilience: overrides.resilience ?? DEFAULT_GATEWAY_RESILIENCE,
    probe: {
      probe: async () => {
        statuses.push(store.listMissions()[0]?.status ?? "");
        return overrides.probe ? overrides.probe() : { healthy: !down() };
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
  });
  return { orchestrator, store, clock: () => now, statuses, agentCalls: () => agentCalls };
}

describe("orchestrator: an outage longer than the retry horizon", () => {
  it("pauses past the 12h horizon and auto-resumes to completion when the probe recovers (13h outage)", async () => {
    const h = run(13 * HOUR);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.completed, true, JSON.stringify(result.verdict.reasons));
    assert.equal(result.paused, undefined);
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "COMPLETE");
    assert.ok(h.clock() >= 13 * HOUR);
    // It really paused on the way, and the probe is what brought it back.
    assert.ok(h.statuses.includes("PAUSED_INFRASTRUCTURE"), "probed while paused");
  });

  it("stays paused (never failed) when the gateway is still down after the auto-resume horizon", async () => {
    const h = run(100 * HOUR);
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    assert.equal(result.paused, true);
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "PAUSED_INFRASTRUCTURE");
  });
});

describe("orchestrator: cancelling an auto-resume wait", () => {
  it("an aborted orchestration cancels the mission instead of watching the probe for hours", async () => {
    const h = run(100 * HOUR);
    const controller = new AbortController();
    const pending = h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      signal: controller.signal,
    });
    // Abort as soon as the mission pauses (fake clock: past the 12h window).
    const timer = setInterval(() => {
      if (h.clock() >= 12 * HOUR) controller.abort();
    }, 0);
    const result = await pending;
    clearInterval(timer);
    assert.equal(result.paused, undefined);
    assert.equal(result.completed, false);
    assert.equal(result.mission.status, "CANCELED");
    assert.ok(h.clock() < 36 * HOUR, `stopped at ${h.clock()}ms`);
  });
});

// A task that ends terminally while the mission is parked in the resilience
// window (WAITING_FOR_LLM etc.) used to leave the mission parked, and the
// orchestrator then threw `illegal mission transition WAITING_FOR_LLM ->
// VALIDATING` instead of running its normal failure handling.
describe("orchestrator: a task that fails terminally inside the resilience window", () => {
  const transient: AgentOutcome = {
    executionId: "e",
    exitStatus: "failed",
    summary: "capacity_unavailable",
    artifactRefs: [],
    usage: {},
    error: "transient:server_unavailable",
  };
  const modelNotFound: AgentOutcome = {
    ...transient,
    summary: 'Worker failed after 2 attempt(s): 404: {"code":"model_not_found"}',
    error: "transient:model_unavailable",
  };
  const start = (h: ReturnType<typeof run>) =>
    h.orchestrator.orchestrate("Add a health endpoint", { repository: ".", baseRef: "abc", mutationRequested: true });

  it("model_not_found with no alternative after unlisted probes: resolves and the mission ends BLOCKED", async () => {
    const h = run(0, {
      agent: (call) => (call === 0 ? transient : modelNotFound),
      probe: () => ({ healthy: false, authoritative: true, model_unlisted: true, reason: "model m is not served" }),
    });
    const result = await start(h);
    assert.equal(h.agentCalls(), 2);
    assert.equal(result.completed, false);
    assert.equal(result.paused, undefined);
    // BLOCKED is the orchestrator's normal end state for a failed implementer.
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "BLOCKED");
    const [task] = h.store.listTasks(result.mission.mission_id).filter((t) => t.kind === "agent");
    assert.equal(task!.status, "FAILED");
  });

  it("max_relaunches exhausted while parked: resolves and the mission ends BLOCKED", async () => {
    const h = run(0, {
      agent: () => transient,
      probe: () => ({ healthy: true, authoritative: true }),
      resilience: { ...DEFAULT_GATEWAY_RESILIENCE, max_relaunches: 2 },
    });
    const result = await start(h);
    assert.equal(h.agentCalls(), 3, "the original attempt plus two relaunches");
    assert.equal(result.completed, false);
    // BLOCKED is the orchestrator's normal end state for a failed implementer.
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "BLOCKED");
  });
});
