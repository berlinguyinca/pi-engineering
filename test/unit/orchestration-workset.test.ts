import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type { WorkspaceManifest } from "../../src/orchestration/types.ts";
import {
  WorksetValidationError,
  decompositionInput,
  splitWorksetDeliverables,
  validateWorkset,
} from "../../src/orchestration/workset.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

const manifest: WorkspaceManifest = {
  manifestId: "WM-test",
  missionId: "MSN-test",
  generation: 4,
  authorizedRoots: [
    { canonicalPath: "/workspace/api", source: "explicit_user_path", access: "write" },
    { canonicalPath: "/workspace/web", source: "explicit_user_path", access: "write" },
  ],
  repositories: [
    {
      repoId: "repo-api",
      canonicalRoot: "/workspace/api",
      baseRef: "main",
      baseSha: "base-api",
      writableDomains: ["src/**", "test/**"],
    },
    {
      repoId: "repo-web",
      canonicalRoot: "/workspace/web",
      baseRef: "main",
      baseSha: "base-web",
      writableDomains: ["app/**"],
    },
  ],
  dependencyEdges: [],
  hash: "manifest-hash",
  createdAt: "2026-09-26T10:00:00.000Z",
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "task-api",
    kind: "agent" as const,
    role: "implementer",
    objective: "implement the API change",
    depends_on: [],
    mutates_repo: true,
    write_domains: ["src/**"],
    repo_id: "repo-api",
    acceptance_ids: ["AC-1"],
    deliverables: ["implementation", "tests"],
    execution_budget_ms: 60_000,
    checkpoint_policy: { activity_milestone: 2, before_deadline_ms: 5_000 },
    required_output_artifacts: ["diff", "test-results"],
    ...overrides,
  };
}

function expectCode(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof WorksetValidationError && error.code === code);
}

describe("repository-scoped workset validation", () => {
  it("rejects a task bound to an unknown repository", () => {
    expectCode("UNKNOWN_REPOSITORY", () =>
      validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ repo_id: "repo-missing" })] }),
    );
  });

  it("rejects a write domain outside the bound repository authorization", () => {
    expectCode("WRITE_DOMAIN_OUTSIDE_REPOSITORY", () =>
      validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ write_domains: ["infra/**"] })] }),
    );
  });

  it("rejects absolute and traversal write domains before prefix comparison", () => {
    for (const writeDomain of ["/src/**", "C:\\src\\**", "src/../../outside/**", "src/../test/**"]) {
      expectCode("INVALID_WRITE_DOMAIN", () =>
        validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ write_domains: [writeDomain] })] }),
      );
    }
  });

  it("rejects material acceptance criteria that no task covers", () => {
    expectCode("UNCOVERED_ACCEPTANCE", () =>
      validateWorkset({ manifest, acceptanceIds: ["AC-1", "AC-2"], tasks: [task()] }),
    );
  });

  it("rejects cyclic task dependencies before dispatch", () => {
    expectCode("CYCLIC_DEPENDENCY", () =>
      validateWorkset({
        manifest,
        acceptanceIds: ["AC-1"],
        tasks: [
          task({ task_id: "task-a", depends_on: ["task-b"] }),
          task({ task_id: "task-b", depends_on: ["task-a"] }),
        ],
      }),
    );
  });

  it("requires decomposition for a broad task in a multi-repository workset", () => {
    expectCode("DECOMPOSITION_REQUIRED", () =>
      validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ write_domains: ["**"] })] }),
    );
  });

  it("rejects a task execution budget above policy", () => {
    expectCode("TASK_BUDGET_EXCEEDED", () =>
      validateWorkset({
        manifest,
        acceptanceIds: ["AC-1"],
        tasks: [task({ execution_budget_ms: 120_001 })],
        policy: { maxTaskBudgetMs: 120_000 },
      }),
    );
  });

  it("accepts a task without any execution budget: no clock sizes the work by default", () => {
    const unlimited = task({ execution_budget_ms: undefined });
    const validated = validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [{ ...unlimited }] });
    assert.equal(validated[0]?.execution_budget_ms, undefined);
    // A huge explicit budget is fine too: the policy has no implicit ceiling.
    validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ execution_budget_ms: 8 * 3_600_000 })] });
  });

  it("rejects non-positive/non-finite budgets and non-positive or out-of-budget checkpoint cadence", () => {
    for (const execution_budget_ms of [0, -1, Number.POSITIVE_INFINITY]) {
      expectCode("INVALID_TASK_BUDGET", () =>
        validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ execution_budget_ms })] }),
      );
    }
    for (const checkpoint_policy of [
      { activity_milestone: 0, before_deadline_ms: 1 },
      { activity_milestone: 1.5, before_deadline_ms: 1 },
      { activity_milestone: 1, before_deadline_ms: -1 },
      { activity_milestone: 1, before_deadline_ms: 0 },
      { activity_milestone: 1, before_deadline_ms: 60_000 },
    ]) {
      expectCode("INVALID_CHECKPOINT_POLICY", () =>
        validateWorkset({ manifest, acceptanceIds: ["AC-1"], tasks: [task({ checkpoint_policy })] }),
      );
    }
  });

  it("canonicalizes Windows separators before persisting the validated workset", () => {
    const [validated] = validateWorkset({
      manifest,
      acceptanceIds: ["AC-1"],
      tasks: [task({ write_domains: ["src\\api\\**"] })],
    });

    assert.deepEqual(validated?.write_domains, ["src/api/**"]);
  });

  it("rejects duplicate original task IDs before dependency planning", () => {
    expectCode("DUPLICATE_TASK_ID", () =>
      validateWorkset({
        manifest,
        acceptanceIds: ["AC-1"],
        tasks: [task({ task_id: "duplicate" }), task({ task_id: "duplicate", acceptance_ids: [] })],
      }),
    );
  });

  it("allows only read-only aggregation across repositories in Slice 1", () => {
    expectCode("CROSS_REPOSITORY_MUTATION_UNSUPPORTED", () =>
      validateWorkset({
        manifest,
        acceptanceIds: ["AC-1"],
        tasks: [task({ kind: "aggregation", repo_id: undefined, mutates_repo: true, write_domains: ["**"] })],
      }),
    );

    assert.doesNotThrow(() =>
      validateWorkset({
        manifest,
        acceptanceIds: ["AC-1"],
        tasks: [
          task({
            kind: "aggregation",
            repo_id: undefined,
            mutates_repo: false,
            write_domains: [],
            acceptance_ids: ["AC-1"],
          }),
        ],
      }),
    );
  });

  it("rejects a mutating workset that would publish across repositories in Slice 1", () => {
    expectCode("CROSS_REPOSITORY_MUTATION_UNSUPPORTED", () =>
      validateWorkset({
        manifest,
        acceptanceIds: ["AC-1"],
        tasks: [
          task({ task_id: "api", acceptance_ids: ["AC-1"] }),
          task({
            task_id: "web",
            repo_id: "repo-web",
            write_domains: ["app/**"],
            acceptance_ids: [],
          }),
        ],
      }),
    );
  });

  it("produces stable repository/deliverable splitting input", () => {
    assert.deepEqual(
      decompositionInput([task({ task_id: "z", deliverables: ["tests", "implementation", "docs"] })], manifest, {
        maxDeliverablesPerTask: 2,
      }),
      {
        required: true,
        maxDeliverablesPerTask: 2,
        repositoryIds: ["repo-api", "repo-web"],
        tasks: [{ taskId: "z", repoId: "repo-api", deliverables: ["docs", "implementation", "tests"] }],
      },
    );
  });

  it("splits with collision-proof IDs and rewrites dependencies through an exact final-child map", () => {
    const split = splitWorksetDeliverables(
      [
        task({ task_id: "build", deliverables: ["one", "two", "three"] }),
        task({ task_id: "build::part:1", acceptance_ids: [], deliverables: ["reserved"] }),
        task({ task_id: "verify", acceptance_ids: [], deliverables: ["verify"], depends_on: ["build"] }),
      ],
      2,
    );

    assert.deepEqual(
      split.tasks.map((candidate) => candidate.task_id),
      ["build::part:1:1", "build::part:2", "build::part:1", "verify"],
    );
    assert.equal(split.finalTaskIdByOriginal.get("build"), "build::part:2");
    assert.deepEqual(split.tasks.find((candidate) => candidate.task_id === "verify")?.depends_on, ["build::part:2"]);
    assert.deepEqual(split.tasks.find((candidate) => candidate.task_id === "build::part:2")?.depends_on, [
      "build::part:1:1",
    ]);
  });
});

describe("CheckpointManager", () => {
  it("preserves committed and dirty work separately and reconciles remaining deliverables after restart", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      mission_id: "MSN-checkpoint",
      title: "checkpoint",
      goal: "checkpoint",
      user_request: "checkpoint",
      repository: "/workspace/api",
      base_ref: "base-api",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.bindWorkspaceManifest({ ...manifest, missionId: mission.mission_id });
    const planned = store.createTask({
      task_id: "task-checkpoint",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement and test",
      repo_id: "repo-api",
      acceptance_ids: ["AC-1"],
      deliverables: ["implementation", "tests"],
      execution_budget_ms: 60_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      mission_generation: 7,
      fencing_token: 11,
    });
    const manager = new CheckpointManager({
      store,
      now: () => new Date("2026-09-26T10:01:00.000Z"),
      snapshot: async () => ({
        candidateSha: "candidate-api",
        branch: "mission/task-checkpoint",
        worktree: "/workspace/.worktrees/task-checkpoint",
        committedChanges: ["src/api.ts"],
        preservedUncommittedChanges: ["test/api.test.ts"],
      }),
    });
    const execution = store.createExecution({
      task_id: planned.task_id,
      mission_id: mission.mission_id,
      backend: "agent",
      checkpoint_id: "TCP-restart",
      repo_id: "repo-api",
      base_sha: "base-api",
      candidate_generation: planned.candidate_generation,
      mission_generation: planned.mission_generation,
      fencing_token: planned.fencing_token,
    });
    store.setExecutionStatus(execution.execution_id, "RUNNING", {});

    const checkpoint = await manager.persist({
      taskId: planned.task_id,
      executionId: execution.execution_id,
      completedDeliverables: ["implementation"],
    });
    assert.deepEqual(checkpoint.committedChanges, ["src/api.ts"]);
    assert.deepEqual(checkpoint.preservedUncommittedChanges, ["test/api.test.ts"]);
    assert.equal(checkpoint.missionGeneration, 7);
    assert.equal(checkpoint.candidateGeneration, planned.candidate_generation);
    assert.equal(checkpoint.fencingToken, 11);
    assert.deepEqual(checkpoint.remainingDeliverables, ["tests"]);

    await store.flush();
    const reopened = MissionStore.open(backend);
    const reconciled = new CheckpointManager({ store: reopened }).reconcile(planned.task_id);
    assert.ok(reconciled);
    assert.deepEqual(reconciled.completedDeliverables, ["implementation"]);
    assert.deepEqual(reconciled.remainingDeliverables, ["tests"]);
    assert.equal(reopened.getMission(mission.mission_id)?.acceptance_criteria.length, 0);
  });
});
