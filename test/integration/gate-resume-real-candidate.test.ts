/**
 * Resuming a mission parked on a gate provider failure (issue #170), against a
 * real git repository and a Git-verified candidate: the gate alone re-runs when
 * the candidate verifies, and nothing re-runs when it does not.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { buildCandidateEvidenceIdentity } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { FailureClassifier } from "../../src/orchestration/recovery.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import type { FailureCategory } from "../../src/orchestration/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

interface Options {
  category: FailureCategory;
  failureReason: string;
  /** Record the candidate with a diff hash the repository cannot verify. */
  unverifiableCandidate?: boolean;
}

async function harness(options: Options) {
  const fixture = await makeFixtureRepo();
  const git = (await GitRepo.open(fixture.root))!;
  const baseSha = await git.headCommit();
  const worktree = await git.createWorktree(baseSha, "candidate-gate-resume");
  await writeFile(join(worktree.path, "src", "candidate.ts"), "export const candidate = true;\n");
  await git.commitAll(worktree.path, "candidate");
  const candidateSha = await git.headCommitIn(worktree.path);
  const diff = await git.captureDiff(baseSha, candidateSha);
  const diffHash = options.unverifiableCandidate
    ? `sha256:${"0".repeat(64)}`
    : `sha256:${createHash("sha256").update(diff).digest("hex")}`;
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    mission_id: "MSN-gate-resume",
    title: "resume gate",
    goal: "resume gate",
    user_request: `resume ${fixture.root}`,
    repository: fixture.root,
    base_ref: baseSha,
    risk_profile: "high",
    workflow_class: "engineering",
  });
  const missionId = mission.mission_id;
  const manifest = {
    manifestId: `WM-${missionId}`,
    missionId,
    generation: 1,
    authorizedRoots: [{ canonicalPath: fixture.root, source: "existing_manifest" as const, access: "write" as const }],
    repositories: [
      {
        repoId: "repo-gate-resume",
        canonicalRoot: fixture.root,
        baseRef: baseSha,
        baseSha,
        writableDomains: ["**"],
      },
    ],
    dependencyEdges: [],
    hash: `manifest-${missionId}`,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
  store.bindWorkspaceManifest(manifest);
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(missionId, status);
  }
  const runTask = (
    taskId: string,
    kind: "integration" | "validation",
    terminal: "SUCCEEDED" | "FAILED",
    reason?: string,
  ) => {
    store.createTask({
      task_id: taskId,
      mission_id: missionId,
      kind,
      role: kind === "integration" ? "integrator" : "validator",
      objective: `${kind} task`,
      repo_id: "repo-gate-resume",
    });
    store.transitionTask(taskId, "READY");
    const execution = store.createExecution({
      task_id: taskId,
      mission_id: missionId,
      backend: kind,
      repo_id: "repo-gate-resume",
      base_sha: baseSha,
    });
    store.transitionTask(taskId, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
    store.setExecutionStatus(execution.execution_id, "RUNNING");
    store.setExecutionStatus(execution.execution_id, terminal === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", {
      exit_status: terminal === "SUCCEEDED" ? "succeeded" : "failed",
    });
    store.transitionTask(taskId, terminal, "system", reason ? { failure_reason: reason } : undefined);
    return execution;
  };
  const integration = runTask("TSK-candidate", "integration", "SUCCEEDED");
  store.recordCandidate(
    missionId,
    buildCandidateEvidenceIdentity({
      workspaceManifestHash: manifest.hash,
      missionGeneration: 0,
      repoId: "repo-gate-resume",
      baseSha,
      candidateSha,
      diffHash,
      acceptanceIds: [],
      artifactHashes: [],
    }),
    "candidate",
    { taskId: "TSK-candidate", executionId: integration.execution_id },
  );
  const failedExecution = runTask("TSK-failed-gate", "validation", "FAILED", options.failureReason);
  store.classifyFailure(
    new FailureClassifier().classify({
      missionId,
      taskId: "TSK-failed-gate",
      executionId: failedExecution.execution_id,
      summary: options.failureReason,
      category: options.category,
      observedAt: "2026-09-27T00:00:01.000Z",
    }),
  );
  store.transitionMission(missionId, "BLOCKED");
  store.stopMission(missionId, {
    reason: "gate could not run",
    preservedWork: [],
    attemptedRecoveries: [],
    resumeCondition: "resume once the provider answers",
  });
  const registry = new RepositoryRegistry();
  await registry.register(manifest);
  const calls = { validation: 0, review: 0, agent: 0 };
  const orchestrator = new Orchestrator({
    store,
    repositoryRegistry: registry,
    backends: {
      agent: {
        runAgent: async () => {
          calls.agent++;
          return { executionId: "agent", exitStatus: "succeeded", summary: "x", artifactRefs: [], usage: {} };
        },
      },
      integration: {
        runIntegration: async () => ({
          executionId: "integration",
          exitStatus: "succeeded",
          summary: "integrated",
          artifactRefs: [],
          usage: {},
        }),
      },
      validation: {
        runValidation: async () => {
          calls.validation++;
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
              testSummary: { passed: 1 },
              noTargets: false,
              accessible: true,
              acceptanceResults: [],
            },
          };
        },
      },
      review: {
        runReview: async () => {
          calls.review++;
          return {
            executionId: "review",
            exitStatus: "succeeded",
            summary: "approved",
            artifactRefs: [],
            usage: {},
            findings: [],
            reviewEvidence: {
              reviewerSessionId: "review-gate-resume",
              model: "test",
              provider: "test",
              verdict: "approve",
              independenceMode: "independent",
              findings: [],
              outputValid: true,
              accessible: true,
              acceptanceResults: [],
            },
          };
        },
      },
    },
    planner: async () => [],
    now: () => Date.parse("2026-09-27T00:00:10.000Z"),
    sleep: async () => undefined,
  });
  return {
    store,
    missionId,
    orchestrator,
    calls,
    candidateSha,
    cleanup: async () => {
      await git.removeWorktree(worktree, { keepBranch: false }).catch(() => undefined);
      await fixture.cleanup();
    },
  };
}

const SIGNALS = (h: Awaited<ReturnType<typeof harness>>) => ({
  actions: h.store.listRecoveryDecisions(h.missionId).map((decision) => decision.action),
  categories: h.store.listFailureClassifications(h.missionId).map((entry) => entry.category),
  repairs: h.store.listTasks(h.missionId).filter((task) => task.kind === "agent").length,
});

describe("gate resume against a Git-verified candidate (issue #170)", () => {
  it("re-runs only the provider-failed gate on the verified candidate and completes", async () => {
    const h = await harness({ category: "PROVIDER_TRANSIENT", failureReason: "failed: Connection error." });
    try {
      const integrationsBefore = h.store.listTasks(h.missionId).filter((task) => task.kind === "integration").length;
      h.store.resumeMission(h.missionId, "provider answers");
      const resumed = await h.orchestrator.repairBlockedMission(h.missionId);

      const signals = SIGNALS(h);
      assert.equal(resumed.status, "COMPLETE", JSON.stringify(signals));
      assert.equal(h.calls.validation, 1);
      assert.equal(h.calls.agent, 0);
      assert.equal(signals.repairs, 0);
      assert.equal(signals.actions.includes("CREATE_REPAIR_TASKS"), false);
      assert.equal(
        h.store.listTasks(h.missionId).filter((task) => task.kind === "integration").length,
        integrationsBefore,
        "the candidate was not re-integrated",
      );
    } finally {
      await h.cleanup();
    }
  });

  it("re-derives a legacy REVIEW_FAILED row whose reason is a transport failure", async () => {
    const h = await harness({ category: "VALIDATION_FAILED", failureReason: "failed: Connection error." });
    try {
      h.store.resumeMission(h.missionId, "operator resume");
      const resumed = await h.orchestrator.repairBlockedMission(h.missionId);

      const signals = SIGNALS(h);
      assert.equal(resumed.status, "COMPLETE", JSON.stringify(signals));
      assert.equal(signals.actions.includes("CREATE_REPAIR_TASKS"), false);
      assert.equal(signals.repairs, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("keeps a legacy gate failure whose text merely mentions timeout/network/provider as a gate failure", async () => {
    const h = await harness({
      category: "VALIDATION_FAILED",
      failureReason: "failed: tests failed: network timeout in the provider adapter test",
    });
    try {
      h.store.resumeMission(h.missionId, "operator resume");
      await h.orchestrator.repairBlockedMission(h.missionId);

      const signals = SIGNALS(h);
      assert.equal(signals.categories.at(-1), "VALIDATION_FAILED");
      assert.equal(signals.actions.at(-1), "CREATE_REPAIR_TASKS");
      assert.equal(h.calls.validation, 0, "the failed validation is repaired, not blindly re-run");
    } finally {
      await h.cleanup();
    }
  });

  it("does not re-run gates when the candidate cannot be Git-verified", async () => {
    const h = await harness({
      category: "PROVIDER_TRANSIENT",
      failureReason: "failed: Connection error.",
      unverifiableCandidate: true,
    });
    try {
      h.store.resumeMission(h.missionId, "provider answers");
      const resumed = await h.orchestrator.repairBlockedMission(h.missionId);

      assert.equal(h.calls.validation, 0);
      assert.equal(h.calls.review, 0);
      assert.equal(resumed.status, "BLOCKED");
      assert.equal(SIGNALS(h).repairs, 0);
    } finally {
      await h.cleanup();
    }
  });
});
