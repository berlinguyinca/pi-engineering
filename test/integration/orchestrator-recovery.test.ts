/**
 * A worker that commits, then hits its wall-clock budget, end to end through
 * the real Orchestrator, broker and git: the recovered commit is merged, the
 * next review is told to check that task's objective is fully met, and only
 * then does the task's FAILED status stop blocking completion — with an audit
 * trail.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends, IntegrationHandoff } from "../../src/orchestration/broker.ts";
import { buildCandidateEvidenceIdentity, taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership, type OwnershipIdentity } from "../../src/orchestration/ownership.ts";
import { replacementRecoveryFingerprint } from "../../src/orchestration/recovery.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import type { MissionLease } from "../../src/orchestration/types.ts";
import { WorkspaceManifestResolver, createWorkspaceManifest } from "../../src/orchestration/workspaceManifest.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const OBJECTIVE = "Add the console panel (all five steps)";
const exec = promisify(execFile);

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
      runIntegration: async ({
        handoffs,
      }: {
        handoffs: IntegrationHandoff[];
      }) => {
        for (const h of handoffs) await git.mergeBranch(h.ref ?? h.worktree.branch);
        return {
          executionId: "i",
          exitStatus: "succeeded",
          summary: "merged",
          artifactRefs: [],
          usage: {},
        };
      },
    },
    validation: {
      runValidation: async () => ({
        executionId: "v",
        exitStatus: "succeeded",
        summary: "ok",
        artifactRefs: [],
        usage: {},
        validationEvidence: {
          command: "npm test",
          profile: "test",
          exitCode: 0,
          testSummary: { passed: 1 },
          noTargets: false,
          accessible: true,
          acceptanceResults: [],
        },
      }),
    },
    review: {
      runReview: async ({ objective, acceptanceCriteria }) => {
        reviewObjectives.push(objective);
        return {
          executionId: "r",
          exitStatus: "succeeded",
          summary: "ok",
          artifactRefs: [],
          usage: {},
          findings: [],
          reviewEvidence: {
            reviewerSessionId: "review-recovery",
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
              detail: "recovered objective checked",
            })),
          },
        };
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
        objective: OBJECTIVE,
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

function blockedRepairHarness(
  options: {
    withCandidate?: boolean;
    category?:
      | "TASK_BUDGET_EXHAUSTED"
      | "REQUIREMENT_AMBIGUITY"
      | "PERSISTENCE_FAILURE"
      | "VALIDATION_FAILED"
      | "REVIEW_FAILED";
    failedKind?: "agent" | "validation" | "review";
    failOwnershipRelease?: boolean;
    withOwnership?: boolean;
    ownership?: MissionOwnership;
  } = {},
) {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    mission_id: "MSN-blocked-repair",
    title: "repair",
    goal: "finish three bounded deliverables",
    user_request: "finish three bounded deliverables",
    repository: process.cwd(),
    base_ref: "base-sha",
    risk_profile: "medium",
    workflow_class: "engineering",
  });
  store.bindWorkspaceManifest({
    manifestId: "WM-repair",
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: [{ canonicalPath: process.cwd(), source: "launch_cwd", access: "write" }],
    repositories: [
      {
        repoId: "repo-repair",
        canonicalRoot: process.cwd(),
        baseRef: "base-sha",
        baseSha: "base-sha",
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-repair",
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(mission.mission_id, status);
  }
  if (options.withCandidate) {
    const candidateTask = store.createTask({
      task_id: "TSK-candidate",
      mission_id: mission.mission_id,
      kind: "integration",
      role: "integrator",
      objective: "record candidate before repair",
      repo_id: "repo-repair",
      acceptance_ids: [],
      deliverables: ["candidate"],
    });
    store.transitionTask(candidateTask.task_id, "READY");
    const candidateExecution = store.createExecution({
      task_id: candidateTask.task_id,
      mission_id: mission.mission_id,
      backend: "integration",
      repo_id: "repo-repair",
      base_sha: "base-sha",
    });
    store.transitionTask(candidateTask.task_id, "RUNNING", "system", {
      assigned_execution_id: candidateExecution.execution_id,
    });
    store.setExecutionStatus(candidateExecution.execution_id, "RUNNING");
    store.setExecutionStatus(candidateExecution.execution_id, "SUCCEEDED", {
      exit_status: "succeeded",
    });
    store.transitionTask(candidateTask.task_id, "SUCCEEDED");
    store.recordCandidate(
      mission.mission_id,
      buildCandidateEvidenceIdentity({
        workspaceManifestHash: "manifest-repair",
        missionGeneration: 0,
        repoId: "repo-repair",
        baseSha: "base-sha",
        candidateSha: "candidate-sha",
        diffHash: "diff-hash",
        acceptanceIds: [],
        artifactHashes: [],
      }),
      "pre-repair candidate",
      {
        taskId: candidateTask.task_id,
        executionId: candidateExecution.execution_id,
      },
    );
  }
  const prerequisite = store.createTask({
    task_id: "TSK-prerequisite",
    mission_id: mission.mission_id,
    kind: "process",
    role: "builder",
    objective: "prepare bounded repair inputs",
    repo_id: "repo-repair",
  });
  store.transitionTask(prerequisite.task_id, "READY");
  store.transitionTask(prerequisite.task_id, "SUCCEEDED");
  const failed = store.createTask({
    task_id: "TSK-original",
    mission_id: mission.mission_id,
    kind: options.failedKind ?? "agent",
    role: "implementer",
    objective: "finish one, two, and three",
    repo_id: "repo-repair",
    acceptance_ids: [],
    deliverables: ["one", "two", "three"],
    depends_on: [prerequisite.task_id],
    mutates_repo: false,
    max_attempts: 1,
  });
  store.transitionTask(failed.task_id, "READY");
  const orphanedExecution = store.createExecution({
    task_id: failed.task_id,
    mission_id: mission.mission_id,
    backend: options.failedKind ?? "agent",
    repo_id: "repo-repair",
    base_sha: "base-sha",
    checkpoint_id: "CHK-original",
    mission_generation: 0,
    candidate_generation: 0,
    fencing_token: 0,
  });
  store.transitionTask(failed.task_id, "RUNNING", "system", {
    assigned_execution_id: orphanedExecution.execution_id,
  });
  store.setExecutionStatus(orphanedExecution.execution_id, "RUNNING");
  store.transitionTask(failed.task_id, "FAILED", "system", {
    failure_reason: "task execution budget exhausted",
  });
  store.checkpointTask({
    checkpointId: "CHK-original",
    executionId: orphanedExecution.execution_id,
    missionId: mission.mission_id,
    taskId: failed.task_id,
    repoId: "repo-repair",
    baseSha: "base-sha",
    candidateSha: "candidate-sha",
    branch: "pi-eng-orch-TSK-original",
    worktree: "/tmp/preserved-repair",
    committedChanges: ["one"],
    preservedUncommittedChanges: [],
    completedDeliverables: ["one"],
    remainingDeliverables: ["two", "three"],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: [],
    artifactHashes: [],
    workerId: "worker",
    sessionId: "session",
    model: "local/local",
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  store.classifyFailure({
    classificationId: "FC-budget",
    missionId: mission.mission_id,
    taskId: failed.task_id,
    executionId: orphanedExecution.execution_id,
    category: options.category ?? "TASK_BUDGET_EXHAUSTED",
    evidenceRefs: ["CHK-original"],
    fingerprint: "sha256:budget-fingerprint",
    summary: "task execution budget exhausted",
    classifiedAt: "2026-09-27T00:00:00.000Z",
  });
  store.transitionMission(mission.mission_id, "BLOCKED");
  class HarnessOwnership extends MissionOwnership {
    override async release(identity: OwnershipIdentity): Promise<void> {
      if (options.failOwnershipRelease && !("repoId" in identity)) throw new Error("injected mission release failure");
      await super.release(identity);
    }
  }
  const ownership =
    options.ownership ??
    (options.failOwnershipRelease
      ? new HarnessOwnership(store, { ownerId: "blocked-repair-controller" })
      : options.withOwnership
        ? new MissionOwnership(store, { ownerId: "blocked-repair-controller" })
        : undefined);
  const observedRecoveries: Array<unknown> = [];
  const lifecycleInventoryGit = {
    loadCandidateLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
    loadIntegrationRunInventory: async () => ({ records: [], diagnostics: [] }),
    loadPromotionLifecycleInventory: async () => ({ records: [], diagnostics: [] }),
    loadPendingBranchCleanupInventory: async () => ({ records: [], diagnostics: [] }),
  } as never;
  const orchestrator = new Orchestrator({
    store,
    git: lifecycleInventoryGit,
    backends: {
      agent: {
        runAgent: async (input) => {
          observedRecoveries.push(input.recovery);
          return {
            executionId: "replacement",
            exitStatus: "succeeded",
            summary: "remaining deliverable complete",
            artifactRefs: [],
            usage: {},
          };
        },
      },
      validation: {
        runValidation: async () => ({
          executionId: "replacement-validation",
          exitStatus: "succeeded",
          summary: "validation rerun succeeded",
          artifactRefs: [],
          usage: {},
        }),
      },
      review: {
        runReview: async () => ({
          executionId: "replacement-review",
          exitStatus: "succeeded",
          summary: "review rerun succeeded",
          artifactRefs: [],
          usage: {},
        }),
      },
    },
    planner: async () => [],
    recovery: {
      missionCeiling: 4,
      strategyMaxAttempts: 2,
      decisionTtlMs: 60_000,
    },
    now: () => Date.parse("2026-09-27T00:00:10.000Z"),
    ownership,
  });
  if (options.withCandidate) {
    orchestrator.broker.verifiedCandidateContent = async () => ({
      candidateSha: "candidate-sha",
      diffHash: "diff-hash",
      hasChanges: true,
    });
  }
  return {
    backend,
    store,
    missionId: mission.mission_id,
    failed,
    orphanedExecution,
    orchestrator,
    observedRecoveries,
  };
}

async function realGateRepairHarness(emptyRepair: boolean, race?: "integration" | "promotion" | "captureDiff") {
  const fixture = await makeFixtureRepo();
  const git = (await GitRepo.open(fixture.root))!;
  const baseSha = await git.headCommit();
  const baselineWorktree = await git.createWorktree(baseSha, `candidate-baseline-${emptyRepair ? "empty" : "real"}`);
  await writeFile(join(baselineWorktree.path, "src", "candidate-baseline.ts"), "export const baseline = true;\n");
  await git.commitAll(baselineWorktree.path, "candidate baseline");
  const candidateSha = await git.headCommitIn(baselineWorktree.path);
  const baselineDiff = await git.captureDiff(baseSha, candidateSha);
  const baselineDiffHash = `sha256:${createHash("sha256").update(baselineDiff).digest("hex")}`;
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    mission_id: emptyRepair ? "MSN-empty-repair" : "MSN-real-repair",
    title: "repair failed gate",
    goal: "repair failed gate",
    user_request: `repair ${fixture.root}`,
    repository: fixture.root,
    base_ref: baseSha,
    risk_profile: "high",
    workflow_class: "engineering",
  });
  const manifest = {
    manifestId: `WM-${mission.mission_id}`,
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: [
      {
        canonicalPath: fixture.root,
        source: "existing_manifest" as const,
        access: "write" as const,
      },
    ],
    repositories: [
      {
        repoId: "repo-real-repair",
        canonicalRoot: fixture.root,
        baseRef: baseSha,
        baseSha,
        writableDomains: ["**"],
      },
    ],
    dependencyEdges: [],
    hash: `manifest-${mission.mission_id}`,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
  store.bindWorkspaceManifest(manifest);
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(mission.mission_id, status);
  }
  const candidateTask = store.createTask({
    task_id: "TSK-current-candidate",
    mission_id: mission.mission_id,
    kind: "integration",
    role: "integrator",
    objective: "current candidate",
    repo_id: "repo-real-repair",
  });
  store.transitionTask(candidateTask.task_id, "READY");
  const candidateExecution = store.createExecution({
    task_id: candidateTask.task_id,
    mission_id: mission.mission_id,
    backend: "integration",
    repo_id: "repo-real-repair",
    base_sha: baseSha,
  });
  store.transitionTask(candidateTask.task_id, "RUNNING", "system", {
    assigned_execution_id: candidateExecution.execution_id,
  });
  store.setExecutionStatus(candidateExecution.execution_id, "RUNNING");
  store.setExecutionStatus(candidateExecution.execution_id, "SUCCEEDED", {
    exit_status: "succeeded",
  });
  store.transitionTask(candidateTask.task_id, "SUCCEEDED");
  store.recordCandidate(
    mission.mission_id,
    buildCandidateEvidenceIdentity({
      workspaceManifestHash: manifest.hash,
      missionGeneration: 0,
      repoId: "repo-real-repair",
      baseSha,
      candidateSha,
      diffHash: baselineDiffHash,
      acceptanceIds: [],
      artifactHashes: [],
    }),
    "verified candidate before repair",
    {
      taskId: candidateTask.task_id,
      executionId: candidateExecution.execution_id,
    },
  );
  const failed = store.createTask({
    task_id: "TSK-failed-gate",
    mission_id: mission.mission_id,
    kind: "validation",
    role: "validator",
    objective: "validation failed on current candidate",
    repo_id: "repo-real-repair",
    deliverables: ["repair validation defect"],
  });
  store.transitionTask(failed.task_id, "READY");
  const failedExecution = store.createExecution({
    task_id: failed.task_id,
    mission_id: mission.mission_id,
    backend: "validation",
    repo_id: "repo-real-repair",
    base_sha: baseSha,
  });
  store.transitionTask(failed.task_id, "RUNNING", "system", {
    assigned_execution_id: failedExecution.execution_id,
  });
  store.setExecutionStatus(failedExecution.execution_id, "RUNNING");
  store.setExecutionStatus(failedExecution.execution_id, "FAILED", {
    exit_status: "failed",
  });
  store.transitionTask(failed.task_id, "FAILED", "system", {
    failure_reason: "validation failed",
  });
  store.classifyFailure({
    classificationId: "FC-real-gate",
    missionId: mission.mission_id,
    taskId: failed.task_id,
    executionId: failedExecution.execution_id,
    category: "VALIDATION_FAILED",
    evidenceRefs: [],
    fingerprint: `sha256:${(emptyRepair ? "e" : "f").repeat(64)}`,
    summary: "validation failed",
    classifiedAt: "2026-09-27T00:00:01.000Z",
  });
  store.transitionMission(mission.mission_id, "BLOCKED");
  const registry = new RepositoryRegistry();
  await registry.register(manifest);
  const ownership = race ? new MissionOwnership(store, { ownerId: `race-${race}` }) : undefined;
  const promotionGit = registry.get("repo-real-repair").git;
  const originalPromotion = promotionGit.promoteCandidate.bind(promotionGit);
  const originalCaptureDiff = promotionGit.captureDiff.bind(promotionGit);
  if (race === "promotion") {
    promotionGit.promoteCandidate = async (...args) => {
      store.resumeMission(mission.mission_id, "explicit resumption during promotion");
      return originalPromotion(...args);
    };
  }
  if (race === "captureDiff") {
    let resumed = false;
    promotionGit.captureDiff = async (...args) => {
      const diff = await originalCaptureDiff(...args);
      if (!resumed) {
        resumed = true;
        store.resumeMission(mission.mission_id, "explicit resumption during captureDiff");
      }
      return diff;
    };
  }
  const orchestrator = new Orchestrator({
    store,
    repositoryRegistry: registry,
    backends: {
      agent: {
        runAgent: async ({ worktree }) => {
          if (!worktree) throw new Error("repair worktree missing");
          if (emptyRepair) {
            await exec("git", ["-C", worktree, "commit", "--allow-empty", "-m", "empty repair"]);
          } else {
            await writeFile(join(worktree, "src", "actual-repair.ts"), "export const repaired = true;\n");
            await git.commitAll(worktree, "actual repair");
          }
          return {
            executionId: "repair-agent",
            exitStatus: "succeeded",
            summary: "repair worker settled",
            artifactRefs: [],
            usage: {},
          };
        },
      },
      integration: {
        candidateScoped: true,
        runIntegration: async (input) => {
          if (race === "integration") {
            store.resumeMission(mission.mission_id, "explicit resumption during integration");
          }
          for (const [sequence, handoff] of input.handoffs.entries()) {
            const merged = await git.mergeRefInWorktree(
              input.candidate!,
              handoff.ref ?? handoff.worktree.branch,
              input.authority,
              input.candidateLifecycle,
              sequence,
              {},
              input.integrationRun,
            );
            if (!merged.merged) {
              return {
                executionId: "repair-integration",
                exitStatus: "failed",
                summary: merged.reason ?? "merge failed",
                artifactRefs: [],
                usage: {},
              };
            }
          }
          return {
            executionId: "repair-integration",
            exitStatus: "succeeded",
            summary: "repair integrated",
            artifactRefs: [],
            usage: {},
          };
        },
      },
      validation: {
        candidateScoped: true,
        runValidation: async () => ({
          executionId: "repair-validation",
          exitStatus: "succeeded",
          summary: "repair validates",
          artifactRefs: [],
          usage: {},
          validationEvidence: {
            command: "test",
            profile: "repair",
            exitCode: 0,
            testSummary: { passed: 1 },
            noTargets: false,
            accessible: true,
            acceptanceResults: [],
          },
        }),
      },
      review: {
        candidateScoped: true,
        runReview: async () => ({
          executionId: "repair-review",
          exitStatus: "succeeded",
          summary: "repair approved",
          artifactRefs: [],
          usage: {},
          findings: [],
          reviewEvidence: {
            reviewerSessionId: "repair-review",
            model: "test",
            provider: "test",
            verdict: "approve",
            independenceMode: "independent",
            findings: [],
            outputValid: true,
            accessible: true,
            acceptanceResults: [],
          },
        }),
      },
    },
    planner: async () => [],
    recovery: {
      missionCeiling: 4,
      strategyMaxAttempts: 2,
      decisionTtlMs: 60_000,
    },
    now: () => Date.parse("2026-09-27T00:00:10.000Z"),
    ownership,
  });
  return {
    fixture,
    backend,
    store,
    missionId: mission.mission_id,
    orchestrator,
    git,
    baseSha,
    baselineDiffHash,
    candidateSha,
    cleanup: async () => {
      promotionGit.promoteCandidate = originalPromotion;
      promotionGit.captureDiff = originalCaptureDiff;
      await git.removeWorktree(baselineWorktree, { keepBranch: false }).catch(() => undefined);
      await fixture.cleanup();
    },
  };
}

describe("orchestrator: durable blocked-mission repair", () => {
  it("writes the repair before BLOCKED -> REPAIRING, splits checkpoint remainder, and records supersession", async () => {
    const h = blockedRepairHarness();
    const repaired = await h.orchestrator.repairBlockedMission(h.missionId);

    const replacements = h.store
      .listTasks(h.missionId)
      .filter((task) => task.task_id !== h.failed.task_id && task.kind === "agent");
    assert.deepEqual(replacements.map((task) => task.deliverables?.[0]).sort(), ["three", "two"]);
    assert.ok(
      replacements.every((task) => task.status === "SUCCEEDED"),
      JSON.stringify(
        replacements.map((task) => ({
          id: task.task_id,
          status: task.status,
          reason: task.failure_reason,
        })),
      ),
    );
    assert.ok(replacements.every((task) => task.depends_on.includes("TSK-prerequisite")));
    assert.ok(replacements.every((task) => task.recovery_authority?.checkpointId === "CHK-original"));
    assert.ok(
      replacements.every((task) => !Object.keys(task.execution_requirements).some((key) => key.startsWith("recovery"))),
    );
    assert.ok(
      h.observedRecoveries.every(
        (value) =>
          !!value &&
          (value as { checkpointId?: string }).checkpointId === "CHK-original" &&
          (value as { candidateSha?: string }).candidateSha === "candidate-sha" &&
          (value as { sourceBranch?: string }).sourceBranch === "pi-eng-orch-TSK-original",
      ),
      "production dispatch receives the exact store-verified checkpoint snapshot",
    );
    const lineage = h.store.listTaskSupersessions(h.missionId);
    assert.equal(lineage.length, 1);
    assert.equal(lineage[0]?.failedTaskId, h.failed.task_id);
    assert.deepEqual(lineage[0]?.replacementTaskIds.sort(), replacements.map((task) => task.task_id).sort());
    assert.equal(lineage[0]?.coverageFingerprint, taskCoverageFingerprint(h.failed));
    const events = h.backend.all().filter((event) => event.run_id === h.missionId);
    const planned = events.findIndex((event) => event.type === "recovery.planned");
    const orphaned = events.findIndex((event) => event.type === "execution.orphaned");
    const reconciled = events.findIndex((event) => event.type === "execution.reconciled");
    const started = events.findIndex((event) => event.type === "recovery.started");
    const createdReplacement = events.findIndex(
      (event) =>
        event.type === "task.created" &&
        (event.payload.task as { objective?: string } | undefined)?.objective?.startsWith("Recover ") === true,
    );
    assert.ok(
      orphaned >= 0 &&
        reconciled > orphaned &&
        planned > reconciled &&
        createdReplacement > planned &&
        started > createdReplacement,
      "write-ahead order must be durable",
    );
    assert.equal(h.store.getExecution(h.orphanedExecution.execution_id)?.status, "CANCELED");
    assert.equal(
      repaired.status,
      "COMPLETE",
      `successful replacement work must re-run gates through completion: ${JSON.stringify({ failure: repaired.failure_reason, verdict: h.orchestrator.gate.evaluate(repaired) })}`,
    );
    assert.equal(h.store.listRecoveryDecisions(h.missionId).at(-1)?.status, "succeeded");

    const second = await h.orchestrator.repairBlockedMission(h.missionId);
    assert.equal(second.status, repaired.status);
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 1, "repair replay must be idempotent");
  });

  it("invalidates current candidate evidence before replacement dispatch", async () => {
    const h = blockedRepairHarness({ withCandidate: true });
    await h.orchestrator.repairBlockedMission(h.missionId);

    const invalidations = h.store.listEvidenceInvalidations(h.missionId);
    assert.equal(invalidations.length, 1);
    assert.match(invalidations[0]?.reason ?? "", /blocked mission repair/i);
  });

  it("resumes an atomically-started repair after restart without duplicating replacement lineage", async () => {
    const h = blockedRepairHarness();
    const recoveryId = "RCV-crash-replay";
    h.store.planRecovery({
      recoveryId,
      missionId: h.missionId,
      classificationId: "FC-budget",
      action: "REPAIR_BLOCKED_MISSION",
      expectedMaterialChange: "resume checkpointed repair",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-27T00:01:00.000Z",
      nextActionAt: "2026-09-27T00:00:10.000Z",
      status: "planned",
      decidedAt: "2026-09-27T00:00:10.000Z",
      failureFingerprint: "sha256:budget-fingerprint",
    });
    h.store.transitionMission(h.missionId, "REPAIRING", {
      recoveryDecisionId: recoveryId,
    });
    await h.store.flush();

    const repaired = await h.orchestrator.repairBlockedMission(h.missionId);

    assert.equal(repaired.status, "COMPLETE");
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 1);
    assert.equal(h.store.listTasks(h.missionId).filter((task) => task.objective.startsWith("Recover ")).length, 2);
    assert.equal(h.store.getRecoveryDecision(recoveryId)?.status, "succeeded");
  });

  for (const crashPoint of ["replacement flush", "REPAIRING transition", "replacement dispatch"] as const) {
    it(`resumes the recovery-owned lineage after a crash at ${crashPoint}`, async () => {
      const h = blockedRepairHarness({ withOwnership: true });
      const recoveryId = `RCV-phase-${crashPoint.replaceAll(" ", "-")}`;
      h.store.planRecovery({
        recoveryId,
        missionId: h.missionId,
        classificationId: "FC-budget",
        action: "CHECKPOINT_SPLIT_AND_REPLACE",
        expectedMaterialChange: "resume checkpointed repair",
        attempt: 1,
        maxAttempts: 2,
        deadline: "2026-09-27T00:01:00.000Z",
        nextActionAt: "2026-09-27T00:00:10.000Z",
        status: "planned",
        decidedAt: "2026-09-27T00:00:10.000Z",
        failureFingerprint: "sha256:budget-fingerprint",
      });
      const supersessionId = `${recoveryId}-SUP-${h.failed.task_id}`;
      const replacementTaskIds = [1, 2].map((index) => `${recoveryId}-TSK-${h.failed.task_id}-${index}`);
      const lineageFingerprintSpec = {
        supersessionId,
        failedTaskId: h.failed.task_id,
        replacementTaskIds,
        repoId: "repo-repair",
        acceptanceIds: [] as string[],
        coverageFingerprint: taskCoverageFingerprint(h.failed),
      };
      const expectedReplacementFingerprints: Record<string, string> = {};
      const replacements = ["two", "three"].map((deliverable, index) => {
        const taskId = replacementTaskIds[index]!;
        const replacement = {
          task_id: taskId,
          mission_id: h.missionId,
          kind: "agent" as const,
          role: "implementer",
          objective: `Recover ${h.failed.objective}: complete remaining deliverable ${deliverable}`,
          depends_on: ["TSK-prerequisite"],
          priority: 0,
          mutates_repo: false,
          write_domains: [],
          isolation: "none" as const,
          execution_requirements: {},
          max_attempts: 1,
          failure_policy: "block" as const,
          repo_id: "repo-repair",
          acceptance_ids: [],
          deliverables: [deliverable],
          execution_budget_ms: undefined,
          checkpoint_policy: undefined,
          required_output_artifacts: [],
          candidate_generation: index + 1,
        };
        const fingerprint = replacementRecoveryFingerprint({
          decision: h.store.getRecoveryDecision(recoveryId)!,
          lineage: lineageFingerprintSpec,
          replacement,
          manifest: h.store.getWorkspaceManifest(h.missionId)!,
          checkpoint: h.store.getTaskCheckpoint("CHK-original")!,
        });
        expectedReplacementFingerprints[taskId] = fingerprint;
        return h.store.createTask({
          ...replacement,
          replacement_spec_fingerprint: fingerprint,
          recovery_authority: {
            recoveryDecisionId: recoveryId,
            expectedReplacementFingerprint: fingerprint,
            originalTaskId: h.failed.task_id,
            originalExecutionId: h.orphanedExecution.execution_id,
            checkpointId: "CHK-original",
            supersessionId,
            resumptionGeneration: 0,
          },
        });
      });
      h.store.supersedeTask({
        supersessionId,
        missionId: h.missionId,
        failedTaskId: h.failed.task_id,
        replacementTaskIds: replacements.map((task) => task.task_id),
        repoId: "repo-repair",
        acceptanceIds: [],
        coverageFingerprint: taskCoverageFingerprint(h.failed),
        reason: "resume remaining work from checkpoint CHK-original",
        createdAt: "2026-09-27T00:00:10.000Z",
        recoveryDecisionId: recoveryId,
        expectedReplacementFingerprints,
      });
      if (crashPoint !== "replacement flush") {
        h.store.transitionMission(h.missionId, "REPAIRING", {
          recoveryDecisionId: recoveryId,
        });
      }
      if (crashPoint === "replacement dispatch") {
        h.store.transitionTask(replacements[0]!.task_id, "READY");
        const execution = h.store.createExecution({
          task_id: replacements[0]!.task_id,
          mission_id: h.missionId,
          backend: "agent",
          repo_id: "repo-repair",
          base_sha: "base-sha",
        });
        h.store.transitionTask(replacements[0]!.task_id, "RUNNING", "system", {
          assigned_execution_id: execution.execution_id,
        });
        h.store.setExecutionStatus(execution.execution_id, "RUNNING");
      }
      await h.store.flush();

      const repaired = await h.orchestrator.repairBlockedMission(h.missionId);

      assert.equal(repaired.status, "COMPLETE");
      assert.equal(h.store.listTaskSupersessions(h.missionId).length, 1);
      assert.equal(h.store.listTasks(h.missionId).filter((task) => task.objective.startsWith("Recover ")).length, 2);
      assert.ok(replacements.every((task) => h.store.getTask(task.task_id)?.status === "SUCCEEDED"));
      assert.equal(h.store.getRecoveryDecision(recoveryId)?.status, "succeeded");
    });
  }

  it("single-flights concurrent repair calls for one blocked episode", async () => {
    const h = blockedRepairHarness();

    const [first, second] = await Promise.all([
      h.orchestrator.repairBlockedMission(h.missionId),
      h.orchestrator.repairBlockedMission(h.missionId),
    ]);

    assert.equal(first.status, "COMPLETE");
    assert.equal(second.status, "COMPLETE");
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 1);
    assert.equal(h.store.listTasks(h.missionId).filter((task) => task.objective.startsWith("Recover ")).length, 2);
  });

  it("does not share or publish a stale in-flight repair after resumption generation changes", async () => {
    const h = blockedRepairHarness();
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const original = h.orchestrator.broker.durableRepositoryDiagnostics.bind(h.orchestrator.broker);
    let calls = 0;
    h.orchestrator.broker.durableRepositoryDiagnostics = async (missionId) => {
      calls++;
      if (calls === 1) {
        markStarted();
        await gate;
      }
      return original(missionId);
    };
    const stale = h.orchestrator.repairBlockedMission(h.missionId);
    await firstStarted;
    h.store.resumeMission(h.missionId, "operator resumed while old preflight was pending");
    const current = h.orchestrator.repairBlockedMission(h.missionId);
    releaseFirst();

    await assert.rejects(stale, /STALE_RECOVERY_GENERATION/);
    assert.equal(
      (await current).status,
      "COMPLETE",
      JSON.stringify({
        decisions: h.store.listRecoveryDecisions(h.missionId),
        tasks: h.store.listTasks(h.missionId),
        findings: h.store.listFindings(h.missionId),
      }),
    );
    assert.equal(h.store.listRecoveryDecisions(h.missionId).length, 1);
    assert.equal(h.store.listRecoveryDecisions(h.missionId)[0]?.resumptionGeneration, 1);
  });

  it("releases only the generation-local lease when overlapping repair flights settle", async () => {
    class OverlapOwnership extends MissionOwnership {
      readonly released: MissionLease[] = [];
      private next = 0;

      override async acquire(missionId: string): Promise<MissionLease> {
        const generation = ++this.next;
        return {
          missionId,
          generation,
          ownerId: `owner-${generation}`,
          acquiredAt: `2026-09-27T00:00:0${generation}.000Z`,
          renewBy: `2026-09-27T00:01:0${generation}.000Z`,
          fencingToken: generation,
        };
      }

      override async release(identity: OwnershipIdentity): Promise<void> {
        if (!("repoId" in identity)) this.released.push(identity);
      }
    }
    const ownership = new OverlapOwnership(MissionStore.open(JsonlEventStore.inMemory()), {
      ownerId: "overlap",
    });
    const h = blockedRepairHarness({
      category: "REQUIREMENT_AMBIGUITY",
      ownership,
    });
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const diagnostics = h.orchestrator.broker.durableRepositoryDiagnostics.bind(h.orchestrator.broker);
    let calls = 0;
    h.orchestrator.broker.durableRepositoryDiagnostics = async (missionId) => {
      if (++calls === 1) {
        firstStarted();
        await gate;
      }
      return diagnostics(missionId);
    };
    const stale = h.orchestrator.repairBlockedMission(h.missionId);
    await started;
    h.store.resumeMission(h.missionId, "new generation");
    const current = h.orchestrator.repairBlockedMission(h.missionId);
    releaseFirst();

    await assert.rejects(stale, /STALE_RECOVERY_GENERATION/);
    await current;
    assert.deepEqual(ownership.released.map((lease) => lease.generation).sort(), [1, 2]);
  });

  it("checks resumption generation after preserved-work collection before stopping", async () => {
    const h = blockedRepairHarness({ category: "PERSISTENCE_FAILURE" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.orchestrator.broker.durableRepositoryStateRefs = async () => {
      started();
      await gate;
      return ["durable-ref"];
    };
    const stale = h.orchestrator.repairBlockedMission(h.missionId);
    await entered;
    h.store.resumeMission(h.missionId, "resume during preserved work");
    release();

    await assert.rejects(stale, /STALE_RECOVERY_GENERATION/);
    assert.equal(h.store.listMissionStops(h.missionId).length, 0);
  });

  it("checks resumption generation after scheduler settlement before recovery settlement", async () => {
    const h = blockedRepairHarness();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.orchestrator.scheduler.runMission = async () => {
      started();
      await gate;
    };
    const stale = h.orchestrator.repairBlockedMission(h.missionId);
    await entered;
    h.store.resumeMission(h.missionId, "resume during scheduler");
    release();

    await assert.rejects(stale, /STALE_RECOVERY_GENERATION/);
    assert.equal(h.store.listRecoveryDecisions(h.missionId).at(-1)?.status, "started");
  });

  it("rejects deterministic replacement ids whose durable recovery fingerprint is not exact", async () => {
    const h = blockedRepairHarness();
    const recoveryId = "RCV-forged-replay";
    h.store.planRecovery({
      recoveryId,
      missionId: h.missionId,
      classificationId: "FC-budget",
      action: "CHECKPOINT_SPLIT_AND_REPLACE",
      expectedMaterialChange: "resume checkpointed repair",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-27T00:01:00.000Z",
      nextActionAt: "2026-09-27T00:00:10.000Z",
      status: "planned",
      decidedAt: "2026-09-27T00:00:10.000Z",
    });
    const taskId = `${recoveryId}-TSK-${h.failed.task_id}-1`;
    const supersessionId = `${recoveryId}-SUP-${h.failed.task_id}`;
    h.store.createTask({
      task_id: taskId,
      mission_id: h.missionId,
      kind: "agent",
      role: "implementer",
      objective: "forged replay",
      repo_id: "repo-repair",
      replacement_spec_fingerprint: "sha256:forged",
      recovery_authority: {
        recoveryDecisionId: recoveryId,
        expectedReplacementFingerprint: "sha256:forged",
        originalTaskId: h.failed.task_id,
        originalExecutionId: h.orphanedExecution.execution_id,
        checkpointId: "CHK-original",
        supersessionId,
        resumptionGeneration: 0,
      },
    });
    h.store.supersedeTask({
      supersessionId,
      missionId: h.missionId,
      failedTaskId: h.failed.task_id,
      replacementTaskIds: [taskId],
      repoId: "repo-repair",
      acceptanceIds: [],
      coverageFingerprint: taskCoverageFingerprint(h.failed),
      reason: "forged deterministic replay",
      createdAt: "2026-09-27T00:00:10.000Z",
      recoveryDecisionId: recoveryId,
      expectedReplacementFingerprints: { [taskId]: "sha256:forged" },
    });

    const repaired = await h.orchestrator.repairBlockedMission(h.missionId);
    assert.equal(repaired.status, "BLOCKED");
    assert.ok(
      h.store
        .listFailureClassifications(h.missionId)
        .some((classification) => /fingerprint/i.test(classification.summary)),
    );
    assert.equal(h.store.listExecutions(h.missionId, taskId).length, 0);
  });

  it("waits for requirement clarification without creating generic replacement work", async () => {
    const h = blockedRepairHarness({ category: "REQUIREMENT_AMBIGUITY" });

    const waiting = await h.orchestrator.repairBlockedMission(h.missionId);

    assert.equal(waiting.status, "WAITING_FOR_USER");
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 0);
    assert.equal(
      h.store.listTasks(h.missionId).some((task) => task.objective.startsWith("Recover ")),
      false,
    );
    assert.equal(h.store.listRecoveryDecisions(h.missionId).at(-1)?.action, "WAIT_FOR_REQUIREMENT");
  });

  it("pauses for persistence recovery without dispatching replacement work", async () => {
    const h = blockedRepairHarness({ category: "PERSISTENCE_FAILURE" });

    const paused = await h.orchestrator.repairBlockedMission(h.missionId);

    assert.equal(paused.status, "BLOCKED");
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 0);
    assert.equal(
      h.store.listTasks(h.missionId).some((task) => task.objective.startsWith("Recover ")),
      false,
    );
    assert.equal(h.store.listRecoveryDecisions(h.missionId).at(-1)?.action, "PAUSE_FOR_PERSISTENCE");
    assert.match(h.store.listMissionStops(h.missionId).at(-1)?.resumeCondition ?? "", /durable write/i);
  });

  it("creates bounded mutating repair work for CREATE_REPAIR_TASKS and requires new candidate evidence", async () => {
    const h = blockedRepairHarness({
      withCandidate: true,
      category: "VALIDATION_FAILED",
      failedKind: "validation",
    });

    const repaired = await h.orchestrator.repairBlockedMission(h.missionId);

    const recovery = h.store.listRecoveryDecisions(h.missionId).at(-1)!;
    const lineage = h.store
      .listTaskSupersessions(h.missionId)
      .find((entry) => entry.supersessionId.startsWith(`${recovery.recoveryId}-SUP-`))!;
    const replacements = lineage.replacementTaskIds.map((taskId) => h.store.getTask(taskId)!);
    assert.ok(replacements.length > 0);
    assert.ok(
      replacements.every(
        (task) =>
          task.kind === "agent" &&
          task.role === "implementer" &&
          task.mutates_repo &&
          task.isolation === "worktree" &&
          task.max_attempts === 1,
      ),
    );
    assert.equal(
      replacements.some((task) => task.kind === "validation"),
      false,
      "a same-kind gate rerun is not repair material",
    );
    assert.ok(
      replacements.every((task) => task.recovery_authority === undefined),
      "gate repair must start from the independently verified candidate, not import a worker checkpoint",
    );
    assert.ok(h.observedRecoveries.every((recovery) => recovery === undefined));
    assert.equal(recovery.status, "failed");
    assert.ok(recovery.startingCandidateIdentityHash);
    assert.deepEqual(recovery.startingCandidateContent, {
      candidateSha: "candidate-sha",
      diffHash: "diff-hash",
    });
    assert.equal(repaired.status, "BLOCKED");
  });

  it("refuses gate repair when the current candidate cannot be independently verified", async () => {
    const h = blockedRepairHarness({
      category: "REVIEW_FAILED",
      failedKind: "review",
    });

    const repaired = await h.orchestrator.repairBlockedMission(h.missionId);

    assert.equal(repaired.status, "BLOCKED");
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 0);
    assert.ok(h.store.listFindings(h.missionId).some((finding) => finding.category === "recovery_candidate_baseline"));
    assert.deepEqual(h.observedRecoveries, []);
  });

  it("stops a started gate repair that has no verified candidate instead of re-raising it every tick", async () => {
    // Field shape (MSN-25K8j6): finalization's gate-repair loop planned and
    // started CREATE_REPAIR_TASKS while the mission was BLOCKED, with no
    // candidate record because the failing integration never published one.
    // Every supervisor tick re-selected that `started` decision, added an
    // identical blocking finding and returned without a durable stop.
    const h = blockedRepairHarness({ category: "REVIEW_FAILED", failedKind: "review" });
    const started = h.store.planRecovery({
      recoveryId: "RCV-gate-without-candidate",
      missionId: h.missionId,
      classificationId: "FC-budget",
      action: "CREATE_REPAIR_TASKS",
      expectedMaterialChange: "create bounded replacement tasks that materially change the candidate",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-27T00:30:00.000Z",
      nextActionAt: "2026-09-27T00:00:00.000Z",
      status: "planned",
      decidedAt: "2026-09-27T00:00:00.000Z",
      startingCandidateIdentityHash: null,
    });
    h.store.transitionRecovery(started.recoveryId, "started");
    assert.equal(h.store.getCandidate(h.missionId), undefined);

    for (let tick = 0; tick < 3; tick++) await h.orchestrator.repairBlockedMission(h.missionId);

    const baseline = h.store
      .listFindings(h.missionId)
      .filter((finding) => finding.category === "recovery_candidate_baseline");
    assert.equal(baseline.length, 1, "an identical blocking finding is recorded once");
    const stop = h.store.listMissionStops(h.missionId).at(-1);
    assert.ok(stop, "a recovery that cannot proceed records a durable stop");
    assert.match(stop.resumeCondition, /candidate/i);
    assert.ok(stop.attemptedRecoveries.includes(started.recoveryId));
    const decision = h.store.getRecoveryDecision(started.recoveryId)!;
    assert.ok(!["planned", "started"].includes(decision.status), `decision left ${decision.status}`);
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 0, "no repair work without a verified baseline");
    assert.deepEqual(h.observedRecoveries, []);
    assert.equal(h.store.getMission(h.missionId)!.status, "BLOCKED");
  });

  it("integrates genuine repair content before materiality is evaluated", async () => {
    const h = await realGateRepairHarness(false);
    try {
      const repaired = await h.orchestrator.repairBlockedMission(h.missionId);
      const recovery = h.store.listRecoveryDecisions(h.missionId).at(-1)!;
      const integrations = h.store
        .listTasks(h.missionId)
        .filter((task) => task.task_id === `${recovery.recoveryId}-integration`);

      assert.equal(integrations.length, 1);
      assert.equal(integrations[0]?.status, "SUCCEEDED");
      assert.notEqual(h.store.getCandidate(h.missionId)?.identity.diffHash, h.baselineDiffHash);
      assert.equal(
        recovery.status,
        "succeeded",
        JSON.stringify({
          mission: repaired,
          tasks: h.store.listTasks(h.missionId).map((task) => ({
            id: task.task_id,
            kind: task.kind,
            status: task.status,
            failure: task.failure_reason,
          })),
          findings: h.store.listFindings(h.missionId).map((finding) => finding.summary),
          verdict: h.orchestrator.gate.evaluate(repaired),
        }),
      );
      assert.equal(repaired.status, "COMPLETE");
    } finally {
      await h.cleanup();
    }
  });

  it("rejects a SHA-only empty repair commit whose content diff is unchanged", async () => {
    const h = await realGateRepairHarness(true);
    try {
      const repaired = await h.orchestrator.repairBlockedMission(h.missionId);
      const recovery = h.store.listRecoveryDecisions(h.missionId).at(-1)!;

      assert.equal(
        h.store.getTask(`${recovery.recoveryId}-integration`)?.status,
        "SUCCEEDED",
        "empty commit must reach the post-integration content check",
      );
      assert.equal(h.store.getCandidate(h.missionId)?.identity.diffHash, h.baselineDiffHash);
      assert.notEqual(h.store.getCandidate(h.missionId)?.identity.candidateSha, h.candidateSha);
      assert.equal(recovery.status, "failed");
      assert.equal(repaired.status, "BLOCKED");
    } finally {
      await h.cleanup();
    }
  });

  for (const phase of ["integration", "promotion", "captureDiff"] as const) {
    it(`prevents a stale real-backend repair from mutating the incumbent during ${phase}`, async () => {
      const h = await realGateRepairHarness(false, phase);
      try {
        await assert.rejects(h.orchestrator.repairBlockedMission(h.missionId), /STALE_RECOVERY_GENERATION/);
        assert.equal(h.store.listMissionResumptions(h.missionId).at(-1)?.generation, 1);
        assert.equal(await h.git.headCommit(), h.baseSha);
        assert.notEqual(h.store.getMission(h.missionId)?.status, "COMPLETE");
        assert.equal(
          h.backend.all().some((event) => event.run_id === h.missionId && event.type === "mission.completed"),
          false,
          "stale finalization must emit no completion event",
        );
      } finally {
        await h.cleanup();
      }
    });
  }

  it("does not accept candidate metadata invalidation as Git material change", async () => {
    const h = blockedRepairHarness({
      withCandidate: true,
      category: "VALIDATION_FAILED",
      failedKind: "validation",
    });
    await h.orchestrator.repairBlockedMission(h.missionId);
    const recovery = h.store.listRecoveryDecisions(h.missionId).at(-1)!;
    assert.deepEqual(recovery.startingCandidateContent, {
      candidateSha: "candidate-sha",
      diffHash: "diff-hash",
    });
    assert.equal(recovery.status, "failed");
    assert.ok(h.store.listEvidenceInvalidations(h.missionId).length > 0);
  });

  it("keeps the old workspace manifest authoritative when staged role probes fail", async () => {
    const fixture = await makeFixtureRepo();
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const resolver = new WorkspaceManifestResolver();
    const resolved = await resolver.resolveRepository(fixture.root);
    const mission = store.createMission({
      mission_id: "MSN-manifest-rebuild",
      title: "manifest rebuild",
      goal: "preserve authoritative workspace",
      user_request: `repair ${fixture.root}`,
      repository: fixture.root,
      base_ref: resolved.repositories[0]!.baseSha,
      risk_profile: "high",
      workflow_class: "engineering",
    });
    const original = createWorkspaceManifest(resolved, mission.mission_id, 1);
    store.bindWorkspaceManifest(original);
    for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
      store.transitionMission(mission.mission_id, status);
    }
    const failed = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "work blocked by workspace mismatch",
      repo_id: resolved.primaryRepoId,
      max_attempts: 1,
    });
    store.transitionTask(failed.task_id, "READY");
    store.transitionTask(failed.task_id, "RUNNING");
    store.transitionTask(failed.task_id, "FAILED", "system", {
      failure_reason: "workspace scope mismatch",
    });
    store.classifyFailure({
      classificationId: "FC-manifest-rebuild",
      missionId: mission.mission_id,
      taskId: failed.task_id,
      executionId: null,
      category: "WORKSPACE_SCOPE_MISMATCH",
      evidenceRefs: [],
      fingerprint: "sha256:manifest-rebuild",
      summary: "workspace scope mismatch",
      classifiedAt: "2026-09-27T00:00:00.000Z",
    });
    store.transitionMission(mission.mission_id, "BLOCKED");
    class FailingProbeRegistry extends RepositoryRegistry {
      private failedProbe(repoId: string) {
        return [
          {
            role: "implementer" as const,
            repoId,
            root: fixture.root,
            ok: false,
            reason: "injected staged probe failure",
          },
        ];
      }
      override async probe(repoId: string) {
        return this.failedProbe(repoId);
      }
      override async stage(manifest: Parameters<RepositoryRegistry["stage"]>[0]) {
        const staged = await super.stage(manifest);
        return {
          ...staged,
          probe: async (repoId: string) => this.failedProbe(repoId),
        };
      }
    }
    const registry = new FailingProbeRegistry();
    await registry.register(original);
    const orchestrator = new Orchestrator({
      store,
      backends: {},
      planner: async () => [],
      workspaceResolver: resolver,
      repositoryRegistry: registry,
      launchCwd: fixture.root,
      recovery: {
        missionCeiling: 4,
        strategyMaxAttempts: 2,
        decisionTtlMs: 60_000,
      },
      now: () => Date.parse("2026-09-27T00:00:10.000Z"),
    });
    try {
      await orchestrator.repairBlockedMission(mission.mission_id);
      await store.flush();
      const reopened = MissionStore.open(backend);

      assert.equal(reopened.getWorkspaceManifest(mission.mission_id)?.generation, 1);
      assert.equal(reopened.getWorkspaceManifest(mission.mission_id)?.hash, original.hash);
      assert.equal(reopened.listRecoveryDecisions(mission.mission_id).at(-1)?.status, "failed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("starts a new generation-bound recovery after explicit resumption", async () => {
    const h = blockedRepairHarness({ category: "PERSISTENCE_FAILURE" });
    await h.orchestrator.repairBlockedMission(h.missionId);
    const first = h.store.listRecoveryDecisions(h.missionId).at(-1)!;
    assert.equal(first.status, "started");
    assert.equal(first.resumptionGeneration, 0);

    h.store.resumeMission(h.missionId, "durable storage restored");
    await h.orchestrator.repairBlockedMission(h.missionId);

    const decisions = h.store.listRecoveryDecisions(h.missionId);
    assert.equal(decisions.length, 2);
    assert.equal(h.store.getRecoveryDecision(first.recoveryId)?.status, "failed");
    assert.equal(decisions[1]?.resumptionGeneration, 1);
    assert.equal(decisions[1]?.attempt, 2, "explicit resumption does not reset the cumulative fingerprint budget");
    assert.equal(decisions[1]?.deadline, "2026-09-27T00:01:10.000Z");
  });

  it("durably records mission ownership release failure after preserving the repair outcome", async () => {
    const h = blockedRepairHarness({
      category: "REQUIREMENT_AMBIGUITY",
      failOwnershipRelease: true,
    });

    const waiting = await h.orchestrator.repairBlockedMission(h.missionId);

    assert.equal(waiting.status, "WAITING_FOR_USER");
    assert.ok(
      h.store
        .listFindings(h.missionId)
        .some(
          (finding) => finding.category === "ownership_release" && /mission ownership release/i.test(finding.summary),
        ),
    );
    assert.deepEqual(h.store.persistenceDiagnostics(), []);
  });

  it("stops with exact durable details after the identical strategy budget is exhausted", async () => {
    const h = blockedRepairHarness();
    for (const attempt of [1, 2]) {
      h.store.planRecovery({
        recoveryId: `RCV-prior-${attempt}`,
        missionId: h.missionId,
        classificationId: "FC-budget",
        action: "CHECKPOINT_SPLIT_AND_REPLACE",
        expectedMaterialChange: "split remaining work",
        attempt,
        maxAttempts: 2,
        deadline: "2026-09-27T00:01:00.000Z",
        nextActionAt: "2026-09-27T00:00:00.000Z",
        status: "planned",
        decidedAt: "2026-09-27T00:00:00.000Z",
        failureFingerprint: "sha256:budget-fingerprint",
      });
      h.store.transitionRecovery(`RCV-prior-${attempt}`, "failed");
    }

    const stopped = await h.orchestrator.repairBlockedMission(h.missionId);
    assert.equal(stopped.status, "BLOCKED");
    const detail = h.store.listMissionStops(h.missionId).at(-1)!;
    assert.equal(detail.generation, 1);
    assert.equal(detail.resumptionGeneration, 0);
    assert.equal(detail.blockedEpisodeId, stopped.blocked_episode_id);
    assert.equal(detail.recoveryDeadline, "2026-09-27T00:01:00.000Z");
    assert.match(detail.reason, /identical failure fingerprint exhausted/i);
    assert.deepEqual(detail.preservedWork, [
      "/tmp/preserved-repair",
      "pi-eng-orch-TSK-original",
      "candidate-sha",
      "one",
    ]);
    assert.deepEqual(detail.attemptedRecoveries, ["RCV-prior-1", "RCV-prior-2"]);
    assert.match(detail.resumeCondition, /new material evidence|increase the approved recovery budget/i);

    await h.orchestrator.repairBlockedMission(h.missionId);
    assert.equal(h.store.listMissionStops(h.missionId).length, 1, "exhausted repair replay must be idempotent");
  });
});
