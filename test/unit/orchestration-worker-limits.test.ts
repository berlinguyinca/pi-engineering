/**
 * Worker limits: no default execution budget, an opt-in hard cap, and a
 * progress-based stall check (policy `workers.execution_budget_ms` /
 * `workers.stall_timeout_ms`).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  DEFAULT_POLICY,
  type EngineeringPolicy,
  loadPolicy,
  validatePolicy,
  workerLimitsFromPolicy,
} from "../../src/lifecycle/policy.ts";
import {
  type BrokerBackends,
  DEFAULT_WORKER_STALL_TIMEOUT_MS,
  ExecutionBroker,
  WORKER_STALL_MARKER,
  formatStallDuration,
  resolveWorkerExecutionBudgetMs,
  workerStallSummary,
} from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { FailureClassifier, RecoveryPlanner } from "../../src/orchestration/recovery.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { WorkerActivity } from "../../src/workers/WorkerExecutor.ts";
import { sanitizeWorkerActivity } from "../../src/workers/activity.ts";

const MINUTE = 60_000;

function setup(kind: "agent" | "validation" = "agent") {
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "worker limits",
    goal: "worker limits",
    user_request: "worker limits",
    repository: ".",
    base_ref: "",
    risk_profile: "low",
    workflow_class: "engineering_review",
  });
  const task = store.createTask({
    mission_id: mission.mission_id,
    kind,
    role: kind === "agent" ? "implementer" : "validator",
    objective: "keep working",
  });
  store.transitionTask(task.task_id, "READY");
  // As the scheduler does: the task is RUNNING while its execution runs.
  store.transitionTask(task.task_id, "RUNNING");
  return { store, mission, task };
}

const succeeded = (summary = "done") => ({
  executionId: "worker",
  exitStatus: "succeeded",
  summary,
  artifactRefs: [],
  usage: {},
});

/** Resolves when the owner aborts: a worker that is alive but silent. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Clears the env cap for the test and keeps the event loop alive: the broker's
 * own timers are unref'd, so a test awaiting a worker that only waits for its
 * abort would otherwise end with "the event loop has already resolved".
 */
function withoutEnvBudget(): () => void {
  const previous = process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
  delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
  const keepAlive = setInterval(() => {}, 1_000);
  return () => {
    clearInterval(keepAlive);
    if (previous === undefined) delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
    else process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = previous;
  };
}

describe("worker execution budget: none by default", { timeout: 30_000 }, () => {
  let restoreEnv: () => void = () => {};
  beforeEach(() => {
    restoreEnv = withoutEnvBudget();
  });
  afterEach(() => {
    mock.timers.reset();
    restoreEnv();
  });

  it("does not stop a worker that keeps working for 45 minutes (the old default cut it at 30)", async () => {
    // Fake clock: setTimeout/setInterval/Date are driven by tick(); setImmediate
    // stays real so promise chains can drain between ticks.
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const { store, mission, task } = setup();
    let responses = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ onActivity }) => {
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
          // A slow model: one response every 5 minutes, nine of them.
          for (let i = 0; i < 9; i++) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5 * MINUTE));
            responses++;
            onActivity?.({ kind: "state", summary: "Model response received", meaningfulProgress: false });
          }
          return succeeded("worked 45 minutes");
        },
      },
    };
    // Default broker options: no defaultTimeoutMs, default 20-minute stall check.
    const broker = new ExecutionBroker({ store, backends, cancellationAckTimeoutMs: 1_000 });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: task.objective,
    });
    let settled: Awaited<ReturnType<typeof handle.result>> | undefined;
    let failure: unknown;
    void handle.result().then(
      (outcome) => {
        settled = outcome;
      },
      (error) => {
        failure = error;
      },
    );
    for (let minute = 0; minute < 50 && !settled && !failure; minute++) {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(MINUTE);
    }
    for (let i = 0; i < 20 && !settled && !failure; i++) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(failure, undefined);
    assert.equal(responses, 9, "the worker ran to the end");
    assert.equal(settled?.exitStatus, "succeeded", settled?.summary);
    assert.equal(store.getExecution(handle.executionId)?.status, "SUCCEEDED");
  });

  it("still enforces a configured budget (explicit per-task budget wins over 'none')", async () => {
    const { store, mission, task } = setup();
    const broker = new ExecutionBroker({
      store,
      cancellationAckTimeoutMs: 10,
      stallTimeoutMs: 0,
      backends: {
        agent: {
          runAgent: async ({ signal, onActivity }) => {
            // Busy, never silent: only the budget can stop it.
            const busy = setInterval(
              () => onActivity?.({ kind: "state", summary: "Model response received", meaningfulProgress: false }),
              5,
            );
            await untilAborted(signal);
            clearInterval(busy);
            return succeeded("too late");
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: task.objective,
      executionBudgetMs: 40,
    });
    const outcome = await handle.result();
    assert.equal(outcome.error, "timeout");
    assert.equal(outcome.summary, "Execution exceeded its deadline and cancellation grace");
    assert.equal(store.getExecution(handle.executionId)?.exit_status, "timeout");
    assert.equal(store.getTask(task.task_id)?.status, "FAILED");
  });

  it("enforces a broker-wide configured cap (policy workers.execution_budget_ms)", async () => {
    const { store, mission, task } = setup();
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 40,
      cancellationAckTimeoutMs: 10,
      stallTimeoutMs: 0,
      backends: {
        agent: {
          runAgent: async ({ signal }) => {
            await untilAborted(signal);
            return succeeded();
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
    assert.equal((await handle.result()).error, "timeout");
  });

  it("treats 0 as no budget, never as already expired, and rejects a negative one", async () => {
    const { store, mission, task } = setup();
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 0,
      backends: {
        agent: {
          runAgent: async () => {
            await realSleep(30);
            return succeeded();
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
      executionBudgetMs: 0,
      // A lead time that only makes sense against a deadline is fine without one.
      checkpointPolicy: { activity_milestone: 1, before_deadline_ms: 30_000 },
    });
    assert.equal((await handle.result()).exitStatus, "succeeded");

    const other = setup();
    const strict = new ExecutionBroker({ store: other.store, backends: {} });
    await assert.rejects(
      strict.execute({
        taskId: other.task.task_id,
        missionId: other.mission.mission_id,
        kind: "agent",
        objective: "x",
        executionBudgetMs: -1,
      }),
      /INVALID_TASK_BUDGET/,
    );
  });

  it("resolves the cap: policy first, then PI_ENGINEERING_WORKER_TIMEOUT_MS, else none", () => {
    assert.equal(resolveWorkerExecutionBudgetMs(undefined), 0);
    assert.equal(resolveWorkerExecutionBudgetMs(0), 0);
    assert.equal(resolveWorkerExecutionBudgetMs(45 * MINUTE), 45 * MINUTE);
    process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = String(10 * MINUTE);
    assert.equal(resolveWorkerExecutionBudgetMs(undefined), 10 * MINUTE, "env restores a cap");
    assert.equal(resolveWorkerExecutionBudgetMs(45 * MINUTE), 45 * MINUTE, "policy wins over env");
  });
});

describe("worker stall check", { timeout: 30_000 }, () => {
  let restoreEnv: () => void = () => {};
  beforeEach(() => {
    restoreEnv = withoutEnvBudget();
  });
  afterEach(() => restoreEnv());

  function stallBroker(store: MissionStore, backends: BrokerBackends, stallTimeoutMs = 80) {
    return new ExecutionBroker({ store, backends, stallTimeoutMs, cancellationAckTimeoutMs: 20 });
  }

  it("stops a silent worker, preserves it like a timeout, and says 'no activity for N'", async () => {
    const { store, mission, task } = setup();
    const broker = stallBroker(store, {
      agent: {
        runAgent: async ({ signal, onActivity }) => {
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
          onActivity?.({ kind: "state", summary: "Model response received", meaningfulProgress: false });
          await untilAborted(signal); // waits on a model that never answers
          return succeeded("never");
        },
      },
    });
    const started = Date.now();
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: task.objective,
    });
    const outcome = await handle.result();
    assert.ok(Date.now() - started >= 80, "not before the stall timeout");
    assert.equal(outcome.exitStatus, "failed");
    assert.equal(outcome.error, WORKER_STALL_MARKER);
    assert.match(outcome.summary, /^Worker stalled: no activity for 0\.1 seconds/);
    assert.doesNotMatch(outcome.summary, /budget|deadline|timeout|gateway|network/i);
    // FAILED, not CANCELED: a stall is not a user abort.
    assert.equal(store.getExecution(handle.executionId)?.status, "FAILED");
    assert.equal(store.getExecution(handle.executionId)?.exit_status, WORKER_STALL_MARKER);
    assert.equal(store.getTask(task.task_id)?.status, "FAILED");
  });

  it("does not stop a worker while a long tool call runs, and measures silence from its end", async () => {
    const { store, mission, task } = setup();
    let toolFinishedAt = 0;
    const tool = (phase: WorkerActivity["phase"]): WorkerActivity => ({
      kind: "tool",
      phase,
      toolName: "bash",
      buildTool: "cargo",
      summary: "",
      meaningfulProgress: false,
    });
    const broker = stallBroker(store, {
      agent: {
        runAgent: async ({ signal, onActivity }) => {
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
          // A "25-minute cargo build": 4x the stall timeout with no other event.
          onActivity?.(tool("started"));
          await realSleep(320);
          onActivity?.(tool("completed"));
          toolFinishedAt = Date.now();
          await untilAborted(signal); // then silence
          return succeeded("never");
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
    assert.ok(toolFinishedAt > 0, "the tool ran to completion: not stopped while it ran");
    assert.equal(outcome.error, WORKER_STALL_MARKER, "silence after the tool is a stall");
    assert.ok(Date.now() - toolFinishedAt >= 80, "silence is measured from the tool's end");
  });

  it("counts parallel tool calls: one finishing does not make the other silent", async () => {
    const { store, mission, task } = setup();
    const call = (phase: WorkerActivity["phase"]): WorkerActivity => ({
      kind: "tool",
      phase,
      toolName: "bash",
      summary: "",
      meaningfulProgress: false,
    });
    const broker = stallBroker(store, {
      agent: {
        runAgent: async ({ onActivity }) => {
          onActivity?.(call("started"));
          onActivity?.(call("started"));
          onActivity?.(call("completed"));
          await realSleep(300); // the second call is still running
          onActivity?.(call("completed"));
          return succeeded();
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    assert.equal((await handle.result()).exitStatus, "succeeded");
  });

  it("a fresh session resets calls in flight, so a lost tool end cannot switch the check off", async () => {
    const { store, mission, task } = setup();
    const broker = stallBroker(store, {
      agent: {
        runAgent: async ({ signal, onActivity }) => {
          onActivity?.({ kind: "tool", phase: "started", toolName: "bash", summary: "", meaningfulProgress: false });
          // The session died mid-call (no end event); a retry starts a new one.
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
          await untilAborted(signal);
          return succeeded("never");
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    assert.equal((await handle.result()).error, WORKER_STALL_MARKER);
  });

  it("does not stop a worker waiting for model capacity, nor one whose response is streaming", async () => {
    const { store, mission, task } = setup();
    const broker = stallBroker(store, {
      agent: {
        runAgent: async ({ onActivity }) => {
          onActivity?.({ kind: "state", summary: "Waiting for model capacity", meaningfulProgress: false });
          await realSleep(300); // admission slot / gateway hold
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
          for (let i = 0; i < 6; i++) {
            await realSleep(50); // under the stall timeout each time
            onActivity?.({ kind: "state", summary: "Model response streaming", meaningfulProgress: false });
          }
          return succeeded();
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    assert.equal((await handle.result()).exitStatus, "succeeded");
  });

  it("heartbeats are not activity: a worker that only heartbeats is stalled", async () => {
    const { store, mission, task } = setup();
    const broker = new ExecutionBroker({
      store,
      stallTimeoutMs: 80,
      activityHeartbeatMs: 10,
      cancellationAckTimeoutMs: 20,
      backends: {
        agent: {
          runAgent: async ({ signal }) => {
            await untilAborted(signal);
            return succeeded("never");
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
    assert.equal((await handle.result()).error, WORKER_STALL_MARKER);
  });

  it("does not stall-check command backends (validation reports nothing while tests run)", async () => {
    const { store, mission, task } = setup("validation");
    const broker = stallBroker(store, {
      validation: {
        runValidation: async () => {
          await realSleep(250);
          return succeeded("validation passed");
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "validation",
      objective: task.objective,
    });
    assert.equal((await handle.result()).exitStatus, "succeeded");
  });

  it("is off with stall_timeout_ms 0", async () => {
    const { store, mission, task } = setup();
    const broker = stallBroker(
      store,
      {
        agent: {
          runAgent: async () => {
            await realSleep(200);
            return succeeded();
          },
        },
      },
      0,
    );
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    assert.equal((await handle.result()).exitStatus, "succeeded");
  });

  it("classifies a stall as WORKER_STALLED (not budget, not provider) and recovers by fence-and-resume", () => {
    const summary = workerStallSummary(DEFAULT_WORKER_STALL_TIMEOUT_MS);
    assert.equal(summary, "Worker stalled: no activity for 20 minutes (no model response, no tool call running)");
    // The scheduler's terminal-failure text: "<marker>: backend reported failed: <summary>".
    const classification = new FailureClassifier().classify({
      missionId: "M",
      taskId: "T",
      executionId: "E",
      summary: `${WORKER_STALL_MARKER}: backend reported failed: ${summary}`,
    });
    assert.equal(classification.category, "WORKER_STALLED");
    const decision = new RecoveryPlanner().decide({ classification, history: [], now: Date.now() });
    assert.equal(decision.action, "FENCE_RECONCILE_AND_RESUME");
    assert.equal(formatStallDuration(MINUTE), "1 minute");
    assert.equal(formatStallDuration(90 * MINUTE), "90 minutes");
  });

  it("lets the stall-check liveness states cross the activity boundary verbatim", () => {
    for (const summary of ["Model response streaming", "Waiting for model capacity", "Model response received"]) {
      assert.equal(sanitizeWorkerActivity({ kind: "state", summary, meaningfulProgress: false })?.summary, summary);
    }
    assert.equal(
      sanitizeWorkerActivity({ kind: "state", summary: "anything else", meaningfulProgress: false })?.summary,
      "Worker session started",
    );
  });
});

describe("policy workers.*", () => {
  it("defaults to no execution budget and a 20-minute stall check", () => {
    assert.deepEqual(DEFAULT_POLICY.workers, { execution_budget_ms: 0, stall_timeout_ms: 20 * MINUTE });
    assert.deepEqual(workerLimitsFromPolicy(DEFAULT_POLICY), { executionBudgetMs: 0, stallTimeoutMs: 20 * MINUTE });
    assert.equal(validatePolicy(DEFAULT_POLICY).filter((issue) => issue.path.startsWith("workers.")).length, 0);
  });

  it("accepts 0 (off) or 1 minute..24 hours, and rejects everything else", () => {
    const issuesFor = (workers: Record<string, unknown>) =>
      validatePolicy({ ...structuredClone(DEFAULT_POLICY), workers } as unknown as EngineeringPolicy).filter((issue) =>
        issue.path.startsWith("workers."),
      );
    assert.deepEqual(issuesFor({ execution_budget_ms: 0, stall_timeout_ms: 0 }), []);
    assert.deepEqual(issuesFor({ execution_budget_ms: MINUTE, stall_timeout_ms: 24 * 60 * MINUTE }), []);
    for (const bad of [-1, 5_000, 1.5 * MINUTE + 0.5, 24 * 60 * MINUTE + 1, "30m", null]) {
      const issues = issuesFor({ execution_budget_ms: bad, stall_timeout_ms: bad });
      assert.equal(issues.length, 2, `rejects ${String(bad)}`);
      assert.ok(issues.every((issue) => issue.severity === "error"));
    }
  });

  it("falls back to the defaults for a missing or invalid value, never to an immediate deadline", () => {
    assert.deepEqual(workerLimitsFromPolicy(undefined), { executionBudgetMs: 0, stallTimeoutMs: 20 * MINUTE });
    assert.deepEqual(workerLimitsFromPolicy({ workers: { execution_budget_ms: -5, stall_timeout_ms: 10 } } as never), {
      executionBudgetMs: 0,
      stallTimeoutMs: 20 * MINUTE,
    });
  });

  it("loads the keys from the global and repository engineering.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-worker-limits-"));
    try {
      const agentDir = join(root, "agent");
      const repo = join(root, "repo");
      await mkdir(agentDir, { recursive: true });
      await mkdir(join(repo, ".pi"), { recursive: true });
      await writeFile(join(agentDir, "engineering.yaml"), "workers:\n  execution_budget_ms: 3600000\n");
      await writeFile(join(repo, ".pi", "engineering.yaml"), "workers:\n  stall_timeout_ms: 0\n");
      const { policy, issues } = await loadPolicy({ cwd: repo, agentDir, env: {} });
      assert.deepEqual(
        issues.filter((issue) => issue.severity === "error"),
        [],
      );
      assert.deepEqual(workerLimitsFromPolicy(policy), { executionBudgetMs: 60 * MINUTE, stallTimeoutMs: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
