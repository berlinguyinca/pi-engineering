/**
 * A worker's deliberate `partial` report is a resumable checkpoint end to end:
 * the broker keeps its commits, the checkpoint shows the done deliverable, and
 * recovery re-plans only the remainder, without burning a retry attempt.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

for (const scenario of [
  { name: "one of two deliverables done", done: ["one"], remaining: ["two"] },
  { name: "zero deliverables done", done: [] as string[], remaining: ["one", "two"] },
]) {
  test(`a partial worker report (${scenario.name}) is a resumable checkpoint`, async () => {
    await partialScenario(scenario.done, scenario.remaining);
  });
}

async function partialScenario(done: string[], remaining: string[]): Promise<void> {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const objectives: string[] = [];
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ worktree, objective, deliverables }) => {
          objectives.push(`${objective}|${(deliverables ?? []).join(",")}`);
          await mkdir(join(worktree!, "src"), { recursive: true });
          await writeFile(join(worktree!, "src", `${(deliverables ?? ["x"])[0]}.js`), "export const a = 1;\n");
          await git.commitAll(worktree!, "one deliverable");
          const first = objectives.length === 1 && (deliverables ?? []).length === 2;
          return first
            ? {
                executionId: "e",
                exitStatus: "failed",
                summary: "ran out of time",
                error: "ran out of time",
                partial: { done },
                artifactRefs: [],
                usage: {},
              }
            : { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
        },
      },
      integration: {
        runIntegration: async ({ handoffs }: { handoffs: IntegrationHandoff[] }) => {
          for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
          return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
        },
      },
    };
    const orchestrator = new Orchestrator({
      store,
      backends,
      git,
      planner: async (mission) => [
        {
          kind: "agent" as const,
          role: "implementer",
          objective: "build both",
          mutates_repo: true,
          write_domains: ["src/**"],
          isolation: "worktree" as const,
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          acceptance_ids: mission.acceptance_criteria.flatMap((c) => (c.acceptance_id ? [c.acceptance_id] : [])),
          deliverables: ["one", "two"],
          max_attempts: 3,
          failure_policy: "retry" as const,
        },
      ],
    });
    const result = await orchestrator.orchestrate("build both", {
      repository: fx.root,
      baseRef: await git.headCommit(),
      mutationRequested: true,
    });
    const missionId = result.mission.mission_id;
    const original = store.listTasks(missionId).find((t) => t.kind === "agent")!;
    const execution = store.listExecutions(missionId).find((e) => e.task_id === original.task_id)!;
    assert.equal(execution.exit_status, "timeout");
    const checkpoint = store.getTaskCheckpoint(execution.checkpoint_id!);
    assert.deepEqual(checkpoint?.completedDeliverables, done);
    assert.deepEqual(checkpoint?.remainingDeliverables, remaining);
    assert.equal(
      result.failureReason,
      `worker reported partial progress: done [${done.join(", ")}], remaining [${remaining.join(", ")}]`,
    );
    assert.doesNotMatch(result.failureReason ?? "", /wall-clock/);
    assert.ok(await git.resolveCommit(`pi-eng-orch-${original.task_id}`), "committed work is preserved on its branch");
    assert.equal(objectives.length, 1, "no retry attempt was spent on the partial report");

    await orchestrator.repairBlockedMission(missionId);
    const replacements = store.listTasks(missionId).filter((t) => t.task_id !== original.task_id && t.kind === "agent");
    assert.deepEqual(
      replacements.map((t) => t.deliverables?.slice().sort()).sort(),
      remaining.map((d) => [d]),
    );
  } finally {
    await fx.cleanup();
  }
}
