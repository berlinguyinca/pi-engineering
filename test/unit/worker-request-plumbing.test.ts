/** baseRef and wallClock reach the WorkerRequest: broker -> realBackends -> executor request. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const recordingWorker = (seen: WorkerRequest[]): WorkerExecutor => ({
  async run(req) {
    seen.push(req);
    return {
      result: {
        status: "completed",
        summary: "ok",
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: {},
      },
      usage: null,
      toolCalls: 0,
    };
  },
});

test("realBackends copies baseRef and wallClock onto the worker request", async () => {
  const seen: WorkerRequest[] = [];
  const backends = realBackends({
    worker: recordingWorker(seen),
    verifier: {} as never,
    artifacts: {} as never,
    git: null,
    cwd: "/repo",
  });
  await backends.agent.runAgent({
    objective: "o",
    role: "implementer",
    baseRef: "abc123",
    wallClock: { startedAt: 5, budgetMs: 1000 },
    signal: new AbortController().signal,
  });
  assert.equal(seen[0]?.baseRef, "abc123");
  assert.deepEqual(seen[0]?.wallClock, { startedAt: 5, budgetMs: 1000 });
});

test("the broker hands a worker its actual fork base, and the execution budget, not the mission base", async () => {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const missionBase = await git.headCommit();
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "seed"], {
      cwd: fx.root,
    });
    const seededTip = await git.headCommit();
    assert.notEqual(seededTip, missionBase);
    const mission = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: missionBase,
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const seen: Array<{ baseRef?: string; wallClock?: { startedAt: number; budgetMs: number } }> = [];
    const broker = new ExecutionBroker({
      store,
      git,
      baseRef: missionBase,
      backends: {
        agent: {
          runAgent: async (input) => {
            seen.push({ baseRef: input.baseRef, wallClock: input.wallClock });
            return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    for (const candidateBaseSha of [undefined, seededTip]) {
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: `t-${candidateBaseSha ?? "plain"}`,
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      await (
        await broker.execute({
          taskId: task.task_id,
          missionId: mission.mission_id,
          kind: "agent",
          role: "implementer",
          objective: task.objective,
          mutatesRepo: true,
          isolation: "worktree",
          executionBudgetMs: candidateBaseSha ? 60_000 : undefined,
          candidateBaseSha,
        })
      ).result();
    }
    assert.equal(seen[0]?.baseRef, missionBase);
    assert.equal(seen[0]?.wallClock, undefined, "no budget, no wallClock");
    assert.equal(seen[1]?.baseRef, seededTip, "a repair worker's base is the tip it forked from");
    assert.equal(seen[1]?.wallClock?.budgetMs, 60_000);
  } finally {
    await fx.cleanup();
  }
});
