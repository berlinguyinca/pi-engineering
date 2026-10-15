/**
 * Implementer executions that fail on the provider before any tool call ran
 * have no side effects: they are not task attempts, they re-dispatch (on
 * another eligible model when one exists and the operator did not pin this
 * one), and a dead gateway parks the mission in WAITING_FOR_LLM, never
 * BLOCKED -> STOP (issue #175).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DEFAULT_GATEWAY_RESILIENCE, type GatewayResilienceConfig } from "../../src/resilience/config.ts";
import type { ProbeResult } from "../../src/resilience/probe.ts";
import { UnavailableModels, createRouteModel } from "../../src/runtime/modelRouting.ts";
import type { WorkerExecutor, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

type AgentOutcome = Awaited<ReturnType<NonNullable<BrokerBackends["agent"]>["runAgent"]>>;

const ok: AgentOutcome = { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
const connectionError = (toolCalls: number): AgentOutcome => ({
  executionId: "e",
  exitStatus: "failed",
  summary: "Worker failed after 5 attempt(s): Connection error.",
  artifactRefs: [],
  usage: {},
  error: "transient:network",
  toolCalls,
});

interface Overrides {
  agent?: (call: number) => AgentOutcome;
  agentBackend?: BrokerBackends["agent"];
  probe?: (call: number) => ProbeResult;
  resilience?: GatewayResilienceConfig;
  onSleep?: (ms: number, sleeps: number) => void;
}

function harness(overrides: Overrides) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  let now = 0;
  let agentCalls = 0;
  let probes = 0;
  let sleeps = 0;
  const statuses: string[] = [];
  const backends: BrokerBackends = {
    agent: overrides.agentBackend ?? {
      runAgent: async () => overrides.agent!(agentCalls++),
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
          reviewerSessionId: "review-zero-tool",
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
        return overrides.probe ? overrides.probe(probes++) : { healthy: true, authoritative: true };
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      overrides.onSleep?.(ms, ++sleeps);
    },
    rand: () => 0,
  });
  const start = (signal?: AbortSignal) =>
    orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
      ...(signal ? { signal } : {}),
    });
  const implementer = () => store.listTasks(store.listMissions()[0]!.mission_id).find((t) => t.kind === "agent")!;
  return { store, start, statuses, agentCalls: () => agentCalls, implementer, clock: () => now };
}

describe("zero-tool-call provider failures are not task attempts", () => {
  it("five connection errors with no tool call keep the attempt count and the mission completes when the provider answers", async () => {
    const h = harness({ agent: (call) => (call < 5 ? connectionError(0) : ok) });
    const result = await h.start();
    assert.equal(result.completed, true, JSON.stringify(result.verdict.reasons));
    assert.equal(h.agentCalls(), 6);
    // Only the execution that really ran counts: five no-op failures did not.
    assert.equal(h.implementer().attempt, 1);
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "COMPLETE");
  });

  it("a capacity hold parks the mission in WAITING_FOR_LLM with a named wait, resumes on probe success, never BLOCKED or STOP", async () => {
    const capacity: AgentOutcome = {
      ...connectionError(0),
      summary: "Gateway capacity hold: IW-ACT-RETRY-ALTERNATE",
      error: "transient:server_unavailable",
    };
    const h = harness({
      agent: (call) => (call < 2 ? capacity : ok),
      probe: (call) =>
        call < 3
          ? { healthy: false, authoritative: true, retry_after_ms: 30_000 }
          : { healthy: true, authoritative: true },
    });
    const result = await h.start();
    assert.equal(result.completed, true, JSON.stringify(result.verdict.reasons));
    assert.ok(h.statuses.includes("WAITING_FOR_LLM"), `statuses: ${h.statuses.join(",")}`);
    assert.ok(!h.statuses.includes("BLOCKED"));
    const decisions = h.store.listRecoveryDecisions(result.mission.mission_id);
    assert.ok(decisions.length > 0);
    assert.ok(
      decisions.every((d) => d.action === "PROBE_AND_BACKOFF"),
      JSON.stringify(decisions.map((d) => d.action)),
    );
    // The named wait carries when the next action is due, not "now".
    assert.ok(decisions.some((d) => Date.parse(d.nextActionAt) > Date.parse(d.decidedAt)));
    assert.equal(h.implementer().attempt, 1);
  });

  it("past the zero-tool retry cap the mission holds in WAITING_FOR_LLM and is not BLOCKED", async () => {
    const controller = new AbortController();
    let heldStatus = "";
    const h = harness({
      agent: () => connectionError(0),
      // Healthy but non-authoritative: not enough to release a held task.
      probe: () => ({ healthy: true, authoritative: false }),
      resilience: { ...DEFAULT_GATEWAY_RESILIENCE, max_zero_tool_retries: 2 },
      onSleep: (_ms, sleeps) => {
        if (sleeps === 10) {
          heldStatus = h.store.listMissions()[0]!.status;
          controller.abort();
        }
      },
    });
    await h.start(controller.signal);
    assert.equal(heldStatus, "WAITING_FOR_LLM");
    // Original run plus `cap` relaunches, then the hold stops relaunching.
    assert.equal(h.agentCalls(), 3);
    assert.equal(h.implementer().attempt, 0);
    assert.ok(!h.statuses.includes("BLOCKED"));
  });

  it("an implementer that ran tools and then failed still consumes attempts and ends BLOCKED as before", async () => {
    const h = harness({
      agent: () => connectionError(3),
      resilience: { ...DEFAULT_GATEWAY_RESILIENCE, max_relaunches: 2 },
    });
    const result = await h.start();
    assert.equal(result.completed, false);
    assert.equal(h.agentCalls(), 3);
    assert.equal(h.implementer().status, "FAILED");
    assert.equal(h.implementer().attempt, 3);
    assert.equal(h.store.getMission(result.mission.mission_id)!.status, "BLOCKED");
  });
});

describe("zero-tool-call failures and the model the work runs on", () => {
  const A = { provider: "gw", id: "model-a" };
  const B = { provider: "gw", id: "model-b" };
  const failedRun = (toolCalls: number): WorkerRun => ({
    result: {
      status: "failed",
      summary: "Worker failed after 5 attempt(s): Connection error.",
      error: "transient:network",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    },
    usage: null,
    toolCalls,
  });
  const completedRun: WorkerRun = {
    result: {
      status: "completed",
      summary: "implemented",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    },
    usage: null,
  };
  const backendFor = (failures: (model: string, call: number) => WorkerRun, pin?: typeof A) => {
    const models: string[] = [];
    const worker: WorkerExecutor = {
      async run(req) {
        const model = req.modelOverride ? `${req.modelOverride.provider}/${req.modelOverride.id}` : "default";
        models.push(model);
        return failures(model, models.length - 1);
      },
    };
    const real = realBackends({
      worker,
      verifier: {} as never,
      artifacts: {} as never,
      git: null,
      cwd: process.cwd(),
      routeModel: createRouteModel({
        router: {
          route: async (_role, query) => {
            const excluded = new Set((query?.exclude ?? []).map((m) => `${m.provider}/${m.id}`));
            return [A, B].find((m) => !excluded.has(`${m.provider}/${m.id}`));
          },
        },
        unavailable: new UnavailableModels(),
        ...(pin ? { operatorPin: () => pin } : {}),
      }),
      ...(pin ? { currentOperatorPin: () => pin } : {}),
    });
    return { models, backend: { runAgent: real.agent.runAgent } };
  };

  it("with no pin, a connection error before any tool call re-dispatches on the next eligible model", async () => {
    const w = backendFor((model) => (model === "gw/model-b" ? completedRun : failedRun(0)));
    const h = harness({ agentBackend: w.backend });
    const result = await h.start();
    assert.deepEqual(w.models, ["gw/model-a", "gw/model-b"]);
    assert.equal(result.completed, true, JSON.stringify(result.verdict.reasons));
  });

  it("a failure after tool calls does not move to another model", async () => {
    const w = backendFor((model) => (model === "gw/model-b" ? completedRun : failedRun(2)));
    const h = harness({
      agentBackend: w.backend,
      resilience: { ...DEFAULT_GATEWAY_RESILIENCE, max_relaunches: 1 },
    });
    await h.start();
    assert.ok(!w.models.includes("gw/model-b"), w.models.join(","));
  });

  it("an operator-pinned model is waited on, not abandoned for an alternate", async () => {
    const w = backendFor((model, call) => (model === "gw/model-a" && call < 2 ? failedRun(0) : completedRun), A);
    const h = harness({ agentBackend: w.backend });
    const result = await h.start();
    assert.deepEqual(w.models, ["gw/model-a", "gw/model-a", "gw/model-a"]);
    assert.equal(result.completed, true, JSON.stringify(result.verdict.reasons));
  });
});
