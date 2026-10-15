/**
 * Orchestrator-level: the review runs beside a validation that reuses a stored
 * verification result, and waits when the reuse did not happen (issue #185).
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, VERIFY_CACHE_NOTICE } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

interface Timing {
  validationStart: number;
  validationEnd: number;
  reviewStart: number;
}

/** Scripted backends over real git and the real broker; `emitsReuse` says whether validation reuses. */
async function harness(opts: { willReuse: boolean; emitsReuse: boolean }) {
  const fixture = await makeFixtureRepo();
  const git = (await GitRepo.open(fixture.root))!;
  const baseSha = await git.headCommit();
  const timing: Partial<Timing> = {};
  let agent = 0;
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ worktree }) => {
        agent++;
        await writeFile(join(worktree!, "src", `change-${agent}.ts`), `export const change${agent} = true;\n`);
        await git.commitAll(worktree!, `change ${agent}`);
        return { executionId: "agent", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
      },
    },
    integration: {
      candidateScoped: true,
      runIntegration: async (input) => {
        for (const [sequence, handoff] of input.handoffs.entries()) {
          await git.mergeRefInWorktree(
            input.candidate!,
            handoff.ref ?? handoff.worktree.branch,
            input.authority,
            input.candidateLifecycle,
            sequence,
            {},
            input.integrationRun,
          );
        }
        return {
          executionId: "integration",
          exitStatus: "succeeded",
          summary: "integrated",
          artifactRefs: [],
          usage: {},
        };
      },
    },
    validation: {
      candidateScoped: true,
      willReuse: async () => opts.willReuse,
      runValidation: async ({ onActivity }) => {
        timing.validationStart = Date.now();
        if (opts.emitsReuse) {
          onActivity?.({
            kind: "execution",
            stage: "validation",
            phase: "started",
            summary: `${VERIFY_CACHE_NOTICE} validation reused verification run X`,
            meaningfulProgress: false,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
        timing.validationEnd = Date.now();
        return {
          executionId: "validation",
          exitStatus: "succeeded",
          summary: "valid",
          artifactRefs: [],
          usage: {},
          validationEvidence: {
            command: "test",
            profile: "test",
            exitCode: 0,
            testSummary: opts.emitsReuse ? { reused: true, originalRunId: "X" } : { passed: 1 },
            noTargets: false,
            accessible: true,
            acceptanceResults: [],
          },
        };
      },
    },
    review: {
      candidateScoped: true,
      runReview: async ({ acceptanceCriteria }) => {
        timing.reviewStart = Date.now();
        return {
          executionId: "review",
          exitStatus: "succeeded",
          summary: "reviewed",
          artifactRefs: [],
          usage: {},
          findings: [],
          reviewEvidence: {
            reviewerSessionId: "review-1",
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
        };
      },
    },
  };
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const orchestrator = new Orchestrator({
    store,
    repositoryRegistry: new RepositoryRegistry(),
    backends,
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "Add the change module",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: mission.acceptance_criteria.flatMap((criterion) =>
          criterion.acceptance_id ? [criterion.acceptance_id] : [],
        ),
        max_attempts: 1,
        failure_policy: "block" as const,
      },
    ],
    recovery: { missionCeiling: 20, strategyMaxAttempts: 5 },
  });
  const run = () =>
    orchestrator.orchestrate(`Add the change module in ${fixture.root}`, {
      repository: fixture.root,
      baseRef: baseSha,
      mutationRequested: true,
    });
  return { fixture, store, timing, run };
}

describe("review beside a reused validation (#185)", () => {
  it("starts the review while a reusing validation is still running, with no dependency on it", async () => {
    const h = await harness({ willReuse: true, emitsReuse: true });
    try {
      const result = await h.run();
      assert.equal(result.mission.status, "COMPLETE");
      assert.ok(h.timing.reviewStart! < h.timing.validationEnd!, "review started before validation finished");
      assert.ok(h.timing.reviewStart! >= h.timing.validationStart!);
      const review = h.store.listTasks(result.mission.mission_id).find((task) => task.kind === "review")!;
      assert.deepEqual(review.depends_on, []);
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("waits for validation when the peeked entry was gone and validation really ran (true -> false)", async () => {
    const h = await harness({ willReuse: true, emitsReuse: false });
    try {
      const result = await h.run();
      assert.equal(result.mission.status, "COMPLETE");
      assert.ok(h.timing.reviewStart! >= h.timing.validationEnd!, "review waited for the real validation");
      const review = h.store.listTasks(result.mission.mission_id).find((task) => task.kind === "review")!;
      assert.equal(review.depends_on.length, 1);
    } finally {
      await h.fixture.cleanup();
    }
  });
});
