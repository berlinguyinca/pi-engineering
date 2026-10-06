/**
 * Missions are not bound by fixed wall-clock windows (owner: "if it takes 8h,
 * then it takes 8h"). A worker runs as long as it shows activity; only a
 * worker that goes silent is treated as hung, and even then it is resumed
 * rather than failed. Waiting on the model gateway is never silence.
 *
 * The windows are shrunk through configuration to a few hundred ms so real
 * child processes can prove the behaviour in real time.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { AdmissionController } from "../../src/gateway/AdmissionController.ts";
import type { GitRepo } from "../../src/git/GitRepo.ts";
import {
  type BrokerBackends,
  DEFAULT_WORKER_INACTIVITY_MS,
  ExecutionBroker,
  INACTIVITY_MARKER,
  workerInactivityMs,
  workerTimeoutMs,
} from "../../src/orchestration/broker.ts";
import type { ExecutionOutcome } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { MissionScheduler } from "../../src/orchestration/scheduler.ts";
import { DEFAULT_WORKSET_POLICY } from "../../src/orchestration/workset.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { DEFAULT_GATEWAY_RESILIENCE } from "../../src/resilience/config.ts";
import type { WorkerActivity } from "../../src/workers/WorkerExecutor.ts";

/**
 * A real worker process: prints one line every `everyMs` for `forMs` (or stays
 * silent when `everyMs` is 0), then exits. Every printed line is forwarded as
 * worker activity, exactly like tool output from a live agent.
 */
function childWorker(opts: {
  everyMs: number;
  forMs: number;
  signal: AbortSignal;
  onActivity?: (event: WorkerActivity) => void;
}): Promise<ExecutionOutcome> {
  const script =
    opts.everyMs > 0
      ? `const t=setInterval(()=>console.log("tick"),${opts.everyMs});setTimeout(()=>{clearInterval(t);process.exit(0)},${opts.forMs});`
      : `setTimeout(()=>process.exit(0),${opts.forMs});`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const kill = (): void => {
      child.kill("SIGKILL");
    };
    opts.signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", () =>
      opts.onActivity?.({ kind: "tool", phase: "completed", toolName: "bash", summary: "", meaningfulProgress: false }),
    );
    child.on("exit", (code) => {
      opts.signal.removeEventListener("abort", kill);
      resolve({
        executionId: `pid-${child.pid}`,
        exitStatus: code === 0 ? "succeeded" : "failed",
        summary: code === 0 ? "worker finished" : "worker killed",
        artifactRefs: [],
        usage: {},
      });
    });
  });
}

function missionWithTask(store: MissionStore, taskFields: Partial<Parameters<MissionStore["createTask"]>[0]> = {}) {
  const mission = store.createMission({
    title: "long work",
    goal: "long work",
    user_request: "long work",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering_review",
  });
  store.transitionMission(mission.mission_id, "CLASSIFYING");
  store.transitionMission(mission.mission_id, "PLANNING");
  store.transitionMission(mission.mission_id, "READY");
  store.transitionMission(mission.mission_id, "EXECUTING");
  const task = store.createTask({
    mission_id: mission.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "long work",
    max_attempts: 1,
    ...taskFields,
  });
  return { mission, task };
}

describe("no fixed mission deadlines: defaults", () => {
  it("has no implicit execution or task wall-clock budget", () => {
    const prev = process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
    try {
      delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
      assert.equal(workerTimeoutMs(), undefined, "no execution has a maximum duration by default");
      assert.equal(DEFAULT_WORKSET_POLICY.maxTaskBudgetMs, undefined, "tasks are never sized by a clock");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = "60000";
      assert.equal(workerTimeoutMs(), 60_000, "an explicit operator limit still applies");
    } finally {
      if (prev === undefined) delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
      else process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = prev;
    }
  });

  it("detects hangs by a generous, configurable inactivity window", () => {
    const prev = process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS;
    try {
      delete process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS;
      assert.equal(workerInactivityMs(), DEFAULT_WORKER_INACTIVITY_MS);
      assert.ok(DEFAULT_WORKER_INACTIVITY_MS >= 60 * 60_000, "an hour of total silence, not a work budget");
      process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS = "120000";
      assert.equal(workerInactivityMs(), 120_000);
    } finally {
      if (prev === undefined) delete process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS;
      else process.env.PI_ENGINEERING_WORKER_INACTIVITY_MS = prev;
    }
  });
});

describe("no fixed mission deadlines: the broker", () => {
  it("lets a worker that keeps making progress run far past the inactivity window", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { mission, task } = missionWithTask(store);
    const broker = new ExecutionBroker({
      store,
      inactivityTimeoutMs: 400,
      inferenceWaiting: () => false,
      backends: {
        agent: { runAgent: ({ signal, onActivity }) => childWorker({ everyMs: 40, forMs: 2_000, signal, onActivity }) },
      },
    });
    const started = Date.now();
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    const outcome = await handle.result();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.ok(Date.now() - started >= 1_900, "ran five times longer than the window");
    assert.equal(store.getExecution(handle.executionId)?.status, "SUCCEEDED");
  });

  it("detects a silent (hung) worker by inactivity and kills its process", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { mission, task } = missionWithTask(store);
    const broker = new ExecutionBroker({
      store,
      inactivityTimeoutMs: 400,
      cancellationAckTimeoutMs: 200,
      inferenceWaiting: () => false,
      backends: {
        agent: { runAgent: ({ signal }) => childWorker({ everyMs: 0, forMs: 30_000, signal }) },
      },
    });
    const started = Date.now();
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    const outcome = await handle.result();
    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.error, INACTIVITY_MARKER);
    assert.match(outcome.summary ?? "", /no activity/);
    assert.ok(Date.now() - started < 5_000, "a hung worker is caught promptly, not after a work budget");
    assert.equal(store.getExecution(handle.executionId)?.exit_status, INACTIVITY_MARKER);
  });

  it("never treats waiting for inference capacity as a stall", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { mission, task } = missionWithTask(store);
    // A real admission controller holding this process behind a gateway
    // cooldown (a 429 queue_timeout) for far longer than the window.
    const admission = new AdmissionController({ maxConcurrency: 2, jitterMs: 0 });
    const broker = new ExecutionBroker({
      store,
      inactivityTimeoutMs: 300,
      inferenceWaiting: () => {
        const status = admission.status();
        return status.waiting > 0 || status.cooldownMs > 0;
      },
      backends: {
        agent: {
          runAgent: async ({ signal }) => {
            await admission.noteWaitAndSleep(
              { retryAfterMs: 1_500, source: "body", retryable: true, reason: "queue_timeout" },
              { signal },
            );
            return {
              executionId: "after-queue",
              exitStatus: signal.aborted ? "failed" : "succeeded",
              summary: signal.aborted ? "aborted while queued" : "served after the queue",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    const outcome = await handle.result();
    assert.equal(outcome.exitStatus, "succeeded", outcome.summary);
    assert.equal(outcome.error, undefined);
  });

  it("still enforces an explicitly configured wall-clock limit", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { mission, task } = missionWithTask(store);
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 200,
      cancellationAckTimeoutMs: 200,
      inferenceWaiting: () => false,
      backends: {
        agent: {
          runAgent: ({ signal, onActivity }) => childWorker({ everyMs: 20, forMs: 30_000, signal, onActivity }),
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    const outcome = await handle.result();
    assert.equal(outcome.error, "timeout", "opt-in limit fires even for an active worker");
    assert.match(outcome.summary ?? "", /configured wall-clock limit/);
  });
});

describe("no fixed mission deadlines: the scheduler", () => {
  it("resumes a hung worker instead of failing its task", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const { mission, task } = missionWithTask(store);
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: ({ signal, onActivity }) => {
          calls++;
          // First run hangs; the resumed run makes steady progress.
          return calls === 1
            ? childWorker({ everyMs: 0, forMs: 30_000, signal })
            : childWorker({ everyMs: 30, forMs: 1_200, signal, onActivity });
        },
      },
    };
    const broker = new ExecutionBroker({
      store,
      backends,
      inactivityTimeoutMs: 400,
      cancellationAckTimeoutMs: 200,
      inferenceWaiting: () => false,
    });
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(mission.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
    const executions = store.listExecutions(mission.mission_id);
    assert.deepEqual(
      executions.map((execution) => execution.exit_status),
      [INACTIVITY_MARKER, "succeeded"],
    );
  });
});

/** A real-clock mission whose implementer first hits a gateway outage. */
function outageMission(opts: { outageMs: number; leaseMs: number }) {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const startedAt = Date.now();
  const down = () => Date.now() - startedAt < opts.outageMs;
  let agentCalls = 0;
  const ok = { executionId: "e", exitStatus: "succeeded" as const, summary: "ok", artifactRefs: [], usage: {} };
  const backends: BrokerBackends = {
    agent: {
      runAgent: async () => {
        agentCalls++;
        return down()
          ? {
              ...ok,
              exitStatus: "failed" as const,
              summary: "capacity_unavailable",
              error: "transient:server_unavailable",
            }
          : ok;
      },
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
          reviewerSessionId: "review-no-deadline",
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
    ownership: new MissionOwnership(store, { ownerId: "no-deadline-controller", leaseMs: opts.leaseMs }),
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
    resilience: { ...DEFAULT_GATEWAY_RESILIENCE, probe_interval_ms: 100, max_backoff_ms: 100, jitter_ms: 0 },
    probe: { probe: async () => ({ healthy: !down(), authoritative: true }) },
  });
  return { orchestrator, store, agentCalls: () => agentCalls };
}

describe("no fixed mission deadlines: controller ownership", () => {
  it("keeps the mission lease alive while the mission waits for the gateway", async () => {
    // The outage outlasts the mission lease several times over; nothing holds
    // a dispatch authority while the scheduler waits on the recovery probe.
    const h = outageMission({ outageMs: 1_500, leaseMs: 300 });
    const result = await h.orchestrator.orchestrate("Add a health endpoint", {
      repository: ".",
      baseRef: "abc",
      mutationRequested: true,
    });
    const tasks = h.store.listTasks(result.mission.mission_id);
    assert.equal(
      result.completed,
      true,
      JSON.stringify({ reasons: result.verdict.reasons, tasks: tasks.map((t) => [t.status, t.failure_reason]) }),
    );
    assert.ok(h.agentCalls() >= 2, "the implementer ran again after the outage");
  });
});
