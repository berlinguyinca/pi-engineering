/**
 * Worker limits through the REAL EngineeringRuntime wiring: policy file ->
 * runtime -> orchestrator (planner normalization) -> broker -> realBackends ->
 * a fake worker.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

function ok(req: WorkerRequest) {
  return {
    result: {
      status: "completed" as const,
      summary: `worker ${req.role} done`,
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    },
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1, model: "fake" },
    toolCalls: 1,
    // An approving independent review that checked every acceptance criterion.
    structured:
      req.resultTool === "review_result"
        ? {
            verdict: "approve",
            findings: [],
            missingTests: [],
            specGaps: [],
            acceptanceResults: [...req.task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
              acceptanceId: match[1]!,
              status: "passed" as const,
              detail: "fake reviewer checked the criterion",
            })),
            summary: "approved",
          }
        : undefined,
  };
}

/** An implementer that starts, gets one model response, then goes silent until stopped. */
const silentWorker: WorkerExecutor = {
  async run(req) {
    if (req.role !== "implementer") return ok(req) as never;
    req.onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
    req.onActivity?.({ kind: "state", summary: "Model response received", meaningfulProgress: false });
    await new Promise<void>((resolve) => {
      if (req.signal?.aborted) resolve();
      req.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return ok(req) as never;
  },
};

function silentUntilAborted(req: WorkerRequest): Promise<void> {
  req.onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
  req.onActivity?.({ kind: "state", summary: "Model response received", meaningfulProgress: false });
  return new Promise<void>((resolve) => {
    if (req.signal?.aborted) resolve();
    req.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Silent for the first `silentRuns` runs of `role`, then a worker that does the job. */
function silentThenWorking(role: string, silentRuns: number): WorkerExecutor & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    async run(req) {
      runs.push(req.role);
      if (req.role === role && runs.filter((r) => r === role).length <= silentRuns) {
        await silentUntilAborted(req);
        return ok(req) as never;
      }
      // The fixture's add() is broken until an implementer fixes it.
      if (req.role === "implementer") {
        await writeFile(join(req.cwd, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
      }
      return ok(req) as never;
    },
  };
}

describe("worker limits through the runtime", { timeout: 60_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  });

  async function open(opts: { engineeringYaml?: string; stallTimeoutMs?: number; worker: WorkerExecutor }) {
    const fx = await makeFixtureRepo();
    cleanups.push(fx.cleanup);
    const agentDir = await mkdtemp(join(tmpdir(), "pi-eng-agentdir-"));
    cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
    if (opts.engineeringYaml) {
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "engineering.yaml"), opts.engineeringYaml);
    }
    const runtime = await EngineeringRuntime.open({
      cwd: fx.root,
      agentDir,
      worker: opts.worker,
      // Gives the independent review a model identity (no discovery here).
      model: { provider: "fake", id: "fake-reviewer" } as never,
      verifier: new CommandVerifier(),
      ...(opts.stallTimeoutMs !== undefined ? { workerLimits: { stallTimeoutMs: opts.stallTimeoutMs } } : {}),
      // The planner sets no execution_budget_ms: the runtime decides.
      orchestrationPlanner: async (mission) =>
        [
          {
            kind: "agent",
            role: "implementer",
            objective: "implement the change",
            mutates_repo: true,
            write_domains: ["**"],
            isolation: "worktree",
            depends_on: [],
            priority: 0,
            execution_requirements: {},
            acceptance_ids: mission.acceptance_criteria.flatMap((c) => (c.acceptance_id ? [c.acceptance_id] : [])),
            deliverables: ["implementation"],
            max_attempts: 1,
            failure_policy: "block",
          },
        ] as never,
    });
    cleanups.push(() => runtime.close());
    return runtime;
  }

  async function orchestrate(runtime: EngineeringRuntime) {
    // Keep the event loop alive: the broker's timers are unref'd by design.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      return await runtime.orchestrator!.orchestrate("Add a feature", {
        repository: runtime.cwd,
        baseRef: await runtime.git!.headCommit(),
        mutationRequested: true,
      });
    } finally {
      clearInterval(keepAlive);
    }
  }

  it("plans tasks with no execution budget by default, and stops a silent worker as WORKER_STALLED", async () => {
    const runtime = await open({ worker: silentWorker, stallTimeoutMs: 150 });
    const result = await orchestrate(runtime);
    const store = runtime.missionStore!;
    const missionId = result.mission.mission_id;
    const implementer = store.listTasks(missionId).find((task) => task.role === "implementer");
    assert.ok(implementer);
    assert.equal(implementer.execution_budget_ms, undefined, "no default budget is invented");
    const execution = store.getExecution(implementer.assigned_execution_id!);
    assert.equal(execution?.status, "FAILED");
    assert.equal(execution?.exit_status, "stalled");
    const categories = store.listFailureClassifications(missionId).map((c) => c.category);
    assert.ok(categories.includes("WORKER_STALLED"), categories.join(", "));
    assert.ok(!categories.includes("TASK_BUDGET_EXHAUSTED"), "a stall is not budget exhaustion");
    const stalled = store.listFailureClassifications(missionId).find((c) => c.category === "WORKER_STALLED");
    assert.match(stalled!.summary, /no activity for 0\.2 seconds/);
    // Stopped at the repair boundary (no review of an unfinished change), with
    // the stalled worker's branch preserved for recovery.
    assert.equal(result.mission.status, "BLOCKED");
    assert.match(result.failureReason ?? "", /^Worker stalled: no activity for/);
    assert.ok(
      runtime.orchestrator!.broker.preservedBranches(missionId).some((branch) => branch.includes(implementer.task_id)),
    );
  });

  it("recovers a stalled implementer: repair resumes it in a fresh worker", async () => {
    const worker = silentThenWorking("implementer", 1);
    const runtime = await open({ worker, stallTimeoutMs: 150 });
    const result = await orchestrate(runtime);
    const store = runtime.missionStore!;
    const missionId = result.mission.mission_id;
    assert.equal(result.mission.status, "BLOCKED", result.failureReason ?? "");
    const stalled = store.listTasks(missionId).find((task) => task.role === "implementer")!;
    assert.ok(
      store.listTaskCheckpoints(missionId, stalled.task_id).length > 0,
      "the stop wrote a cancellation checkpoint",
    );
    const keepAlive = setInterval(() => {}, 1_000);
    let repaired: Awaited<ReturnType<NonNullable<typeof runtime.orchestrator>["repairBlockedMission"]>>;
    try {
      repaired = await runtime.orchestrator!.repairBlockedMission(missionId);
    } finally {
      clearInterval(keepAlive);
    }
    const lineage = store.listTaskSupersessions(missionId);
    assert.equal(lineage.length, 1, "the stalled task is superseded");
    assert.equal(lineage[0]?.failedTaskId, stalled.task_id);
    const replacements = store
      .listTasks(missionId)
      .filter((task) => lineage[0]!.replacementTaskIds.includes(task.task_id));
    assert.ok(replacements.length > 0);
    assert.ok(
      replacements.every((task) => task.status === "SUCCEEDED"),
      JSON.stringify(replacements.map((task) => ({ id: task.task_id, status: task.status }))),
    );
    assert.ok(
      replacements.every((task) => task.execution_budget_ms === undefined),
      "a replacement inherits 'no budget'",
    );
    assert.notEqual(repaired.status, "BLOCKED", `repair outcome ${repaired.status}`);
    assert.equal(repaired.status, "COMPLETE");
    assert.deepEqual(worker.runs, ["implementer", "implementer", "reviewer"], "one fresh implementer, one review");
  });

  it("a stalled reviewer is stopped and the mission recovers through the existing review-repair round", async () => {
    // Observed behaviour, pinned: the review task fails with exit_status
    // "stalled", finalization classifies it REVIEW_FAILED (as it did a reviewer
    // that hit the old deadline), runs one repair implementer and a fresh
    // review, and completes. The repair implementer run is the known cost.
    const worker = silentThenWorking("reviewer", 1);
    const runtime = await open({ worker, stallTimeoutMs: 150 });
    const result = await orchestrate(runtime);
    const store = runtime.missionStore!;
    const missionId = result.mission.mission_id;
    const reviews = store.listExecutions(missionId).filter((execution) => execution.backend === "review");
    assert.deepEqual(
      reviews.map((execution) => execution.exit_status),
      ["stalled", "succeeded"],
    );
    assert.deepEqual(
      store.listFailureClassifications(missionId).map((c) => c.category),
      ["REVIEW_FAILED"],
    );
    assert.deepEqual(worker.runs, ["implementer", "reviewer", "implementer", "reviewer"]);
    assert.equal(result.mission.status, "COMPLETE", result.failureReason ?? "");
  });

  it("applies policy workers.execution_budget_ms from engineering.yaml as the planned tasks' hard cap", async () => {
    const runtime = await open({
      worker: { run: async (req) => ok(req) as never },
      engineeringYaml: "workers:\n  execution_budget_ms: 3600000\n",
    });
    const result = await orchestrate(runtime);
    const implementer = runtime
      .missionStore!.listTasks(result.mission.mission_id)
      .find((task) => task.role === "implementer");
    assert.equal(implementer?.execution_budget_ms, 3_600_000);
  });
});
