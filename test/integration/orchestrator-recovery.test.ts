/**
 * A worker that commits, then hits its wall-clock budget, end to end through
 * the real Orchestrator, broker and git: the recovered commit is merged, the
 * next review is told to check that task's objective is fully met, and only
 * then does the task's FAILED status stop blocking completion — with an audit
 * trail.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const OBJECTIVE = "Add the console panel (all five steps)";

async function run() {
  const fx = await makeFixtureRepo();
  const git = (await GitRepo.open(fx.root))!;
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const reviewObjectives: string[] = [];
  const backends: BrokerBackends = {
    agent: {
      // Commits real work, then the wall clock runs out.
      runAgent: async ({ worktree }) => {
        await mkdir(join(worktree!, "src"), { recursive: true });
        await writeFile(join(worktree!, "src", "panel.js"), "export const panel = 1;\n");
        await git.commitAll(worktree!, "panel: steps 1-2");
        return {
          executionId: "e",
          exitStatus: "failed",
          summary: "Worker timed out.",
          error: "timeout",
          artifactRefs: [],
          usage: {},
        };
      },
    },
    integration: {
      runIntegration: async ({ handoffs }: { handoffs: IntegrationHandoff[] }) => {
        for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
        return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
      },
    },
    validation: {
      runValidation: async () => ({
        executionId: "v",
        exitStatus: "succeeded",
        summary: "ok",
        artifactRefs: [],
        usage: {},
      }),
    },
    review: {
      runReview: async ({ objective }) => {
        reviewObjectives.push(objective);
        return { executionId: "r", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {}, findings: [] };
      },
    },
  };
  const orchestrator = new Orchestrator({
    store,
    backends,
    git,
    planner: async () => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: OBJECTIVE,
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        max_attempts: 1,
        failure_policy: "retry" as const,
      },
    ],
  });
  const result = await orchestrator.orchestrate("Add the console panel", {
    repository: fx.root,
    baseRef: await git.headCommit(),
    mutationRequested: true,
  });
  return { fx, store, result, reviewObjectives };
}

describe("orchestrator: completing over work recovered from a timed-out worker", () => {
  it("tells the review to verify the recovered task's objective, and records the supersede", async () => {
    const r = await run();
    try {
      const missionId = r.result.mission.mission_id;
      const implementer = r.store.listTasks(missionId).find((t) => t.kind === "agent")!;
      assert.equal(implementer.status, "FAILED");

      // The review was explicitly asked to check completeness of THIS task.
      const noted = r.reviewObjectives.filter((o) => o.includes(implementer.task_id));
      assert.equal(noted.length, 1, JSON.stringify(r.reviewObjectives));
      assert.match(noted[0]!, /fully met/);
      assert.ok(noted[0]!.includes(OBJECTIVE), "the review sees the task's own objective");
      const review = r.store.listExecutions(missionId).find((e) => e.backend === "review")!;
      assert.deepEqual(review.reviewed_recovered, [implementer.task_id]);

      assert.equal(r.result.completed, true, JSON.stringify(r.result.verdict.reasons));
      assert.deepEqual(r.result.verdict.superseded_by_recovery, [implementer.task_id]);
      // Auditable: completion over a FAILED task leaves a finding naming it.
      assert.ok(
        r.store
          .listFindings(missionId)
          .some((f) => f.task_id === implementer.task_id && f.severity === "minor" && /superseded/i.test(f.summary)),
        JSON.stringify(r.store.listFindings(missionId).map((f) => f.summary)),
      );
    } finally {
      await r.fx.cleanup();
    }
  });
});
