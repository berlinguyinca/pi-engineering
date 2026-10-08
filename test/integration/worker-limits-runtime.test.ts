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
