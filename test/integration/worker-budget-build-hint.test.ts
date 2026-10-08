/**
 * A budget-exhausted worker explains itself, through the REAL EngineeringRuntime
 * wiring: runtime -> orchestrator -> broker (isolated worktree) -> realBackends
 * -> a fake worker that reports build activity and then runs out of time.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const LIMIT_REACHED =
  "configured task wall-clock limit (limits.max_task_wall_clock_ms) reached after a durable partial checkpoint";

const exec = promisify(execFile);

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

/** A worker that reports `builds` and then keeps "working" until the budget runs out. */
function buildingWorker(builds: Array<{ elapsedMs?: number }>): WorkerExecutor {
  return {
    async run(req) {
      if (req.role !== "implementer") return ok(req) as never;
      const tool = (phase: WorkerActivity["phase"], elapsedMs?: number): void =>
        req.onActivity?.({
          kind: "tool",
          phase,
          toolName: "bash",
          buildTool: "cargo",
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
          summary: "",
          meaningfulProgress: false,
        });
      for (const build of builds) {
        tool("started");
        if (build.elapsedMs !== undefined) tool("completed", build.elapsedMs);
      }
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return ok(req) as never;
    },
  };
}

describe("budget-exhausted worker that ran builds", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let agentDir = "";
  before(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-eng-agentdir-"));
  });
  after(async () => {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });

  async function run(worker: WorkerExecutor) {
    const fx = await makeFixtureRepo();
    cleanups.push(fx.cleanup);
    await writeFile(join(fx.root, "Cargo.toml"), '[workspace]\nmembers = []\nresolver = "2"\n');
    await exec("git", ["-C", fx.root, "add", "-A"]);
    await exec("git", ["-C", fx.root, "commit", "-q", "-m", "cargo"]);
    const runtime = await EngineeringRuntime.open({
      cwd: fx.root,
      agentDir,
      worker,
      verifier: new CommandVerifier(),
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
            deliverables: ["one", "two"],
            execution_budget_ms: 1_000,
            checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 200 },
            max_attempts: 1,
            failure_policy: "block",
          },
        ] as never,
    });
    const result = await runtime.orchestrator!.orchestrate("Add a feature", {
      repository: runtime.cwd,
      baseRef: await runtime.git!.headCommit(),
      mutationRequested: true,
    });
    return { result, store: runtime.missionStore! };
  }

  it("says probable cold build when builds took most of the execution", async () => {
    // 900 ms of build in a ~1 s execution, and one build still running.
    const { result, store } = await run(buildingWorker([{ elapsedMs: 450 }, { elapsedMs: 450 }, {}]));
    assert.equal(result.mission.status, "BLOCKED", result.failureReason ?? "");
    const reason = result.failureReason ?? "";
    assert.ok(reason.startsWith(`${LIMIT_REACHED}: `), reason);
    assert.match(reason, /probable cold build in an isolated worktree/);
    assert.match(reason, /in 3 build command\(s\) \(cargo x3\), 1 still running at the deadline, and made no commit/);
    const finding = store.listFindings(result.mission.mission_id).find((f) => f.category === "execution_budget");
    assert.ok(finding, "the explanation is a durable finding");
    assert.equal(finding.severity, "major", "never a blocking finding: the completion gate is unchanged");
    assert.equal(finding.summary, reason.replace(/^[^:]+: /, ""));
    // The classification summary (part of the recovery fingerprint) is unchanged.
    const classification = store
      .listFailureClassifications(result.mission.mission_id)
      .find((c) => c.category === "TASK_BUDGET_EXHAUSTED");
    assert.equal(classification?.summary, LIMIT_REACHED);
  });

  it("says the time went elsewhere when builds were short", async () => {
    const { result } = await run(buildingWorker([{ elapsedMs: 5 }, { elapsedMs: 5 }]));
    assert.equal(result.mission.status, "BLOCKED", result.failureReason ?? "");
    const reason = result.failureReason ?? "";
    assert.doesNotMatch(reason, /cold build/);
    assert.match(reason, /in 2 build command\(s\) \(cargo x2\), and made no commit/);
    assert.match(reason, /most of it went to other work/);
  });

  it("keeps the bare reason when the worker ran no builds", async () => {
    const { result, store } = await run(buildingWorker([]));
    assert.equal(result.mission.status, "BLOCKED", result.failureReason ?? "");
    assert.equal(result.failureReason, LIMIT_REACHED);
    assert.equal(
      store.listFindings(result.mission.mission_id).filter((f) => f.category === "execution_budget").length,
      0,
    );
  });
});
