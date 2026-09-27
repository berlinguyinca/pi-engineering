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
import { buildCandidateEvidenceIdentity, taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership, type OwnershipIdentity } from "../../src/orchestration/ownership.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import { WorkspaceManifestResolver, createWorkspaceManifest } from "../../src/orchestration/workspaceManifest.ts";
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
    store.setExecutionStatus(candidateExecution.execution_id, "SUCCEEDED", { exit_status: "succeeded" });
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
      { taskId: candidateTask.task_id, executionId: candidateExecution.execution_id },
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
  });
  store.transitionTask(failed.task_id, "RUNNING", "system", {
    assigned_execution_id: orphanedExecution.execution_id,
  });
  store.setExecutionStatus(orphanedExecution.execution_id, "RUNNING");
  store.transitionTask(failed.task_id, "FAILED", "system", { failure_reason: "task execution budget exhausted" });
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
  const ownership = options.failOwnershipRelease
    ? new HarnessOwnership(store, { ownerId: "blocked-repair-controller" })
    : undefined;
  const orchestrator = new Orchestrator({
    store,
    backends: {
      agent: {
        runAgent: async () => ({
          executionId: "replacement",
          exitStatus: "succeeded",
          summary: "remaining deliverable complete",
          artifactRefs: [],
          usage: {},
        }),
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
    recovery: { missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 },
    now: () => Date.parse("2026-09-27T00:00:10.000Z"),
    ownership,
  });
  return { backend, store, missionId: mission.mission_id, failed, orphanedExecution, orchestrator };
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
        replacements.map((task) => ({ id: task.task_id, status: task.status, reason: task.failure_reason })),
      ),
    );
    assert.ok(replacements.every((task) => task.depends_on.includes("TSK-prerequisite")));
    assert.ok(
      replacements.every(
        (task) =>
          task.execution_requirements.recoveryFromCheckpoint === "CHK-original" &&
          task.execution_requirements.recoveryCandidateSha === "candidate-sha" &&
          task.execution_requirements.recoveryBranch === "pi-eng-orch-TSK-original" &&
          task.execution_requirements.recoveryWorktree === "/tmp/preserved-repair" &&
          JSON.stringify(task.execution_requirements.recoveryCommittedChanges) === JSON.stringify(["one"]) &&
          JSON.stringify(task.execution_requirements.recoveryUncommittedChanges) === JSON.stringify([]) &&
          JSON.stringify(task.execution_requirements.recoveryCompletedDeliverables) === JSON.stringify(["one"]),
      ),
      "replacement execution must receive the exact verified checkpoint snapshot",
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
    h.store.transitionMission(h.missionId, "REPAIRING", { recoveryDecisionId: recoveryId });
    await h.store.flush();

    const repaired = await h.orchestrator.repairBlockedMission(h.missionId);

    assert.equal(repaired.status, "COMPLETE");
    assert.equal(h.store.listTaskSupersessions(h.missionId).length, 1);
    assert.equal(h.store.listTasks(h.missionId).filter((task) => task.objective.startsWith("Recover ")).length, 2);
    assert.equal(h.store.getRecoveryDecision(recoveryId)?.status, "succeeded");
  });

  for (const crashPoint of ["replacement flush", "REPAIRING transition", "replacement dispatch"] as const) {
    it(`resumes the recovery-owned lineage after a crash at ${crashPoint}`, async () => {
      const h = blockedRepairHarness();
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
      const replacements = ["two", "three"].map((deliverable, index) =>
        h.store.createTask({
          task_id: `${recoveryId}-TSK-${h.failed.task_id}-${index + 1}`,
          mission_id: h.missionId,
          kind: "agent",
          role: "implementer",
          objective: `Recover ${h.failed.objective}: complete remaining deliverable ${deliverable}`,
          depends_on: ["TSK-prerequisite"],
          deliverables: [deliverable],
          repo_id: "repo-repair",
          max_attempts: 1,
          execution_requirements: {
            recoveryFromCheckpoint: "CHK-original",
            recoveryCandidateSha: "candidate-sha",
            recoveryBranch: "pi-eng-orch-TSK-original",
            recoveryWorktree: "/tmp/preserved-repair",
            recoveryCommittedChanges: ["one"],
            recoveryUncommittedChanges: [],
            recoveryCompletedDeliverables: ["one"],
            recoveryArtifactRefs: [],
            recoveryArtifactHashes: [],
          },
        }),
      );
      h.store.supersedeTask({
        supersessionId: `${recoveryId}-SUP-${h.failed.task_id}`,
        missionId: h.missionId,
        failedTaskId: h.failed.task_id,
        replacementTaskIds: replacements.map((task) => task.task_id),
        repoId: "repo-repair",
        acceptanceIds: [],
        coverageFingerprint: taskCoverageFingerprint(h.failed),
        reason: "resume remaining work from checkpoint CHK-original",
        createdAt: "2026-09-27T00:00:10.000Z",
      });
      if (crashPoint !== "replacement flush") {
        h.store.transitionMission(h.missionId, "REPAIRING", { recoveryDecisionId: recoveryId });
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
    const h = blockedRepairHarness({ category: "VALIDATION_FAILED", failedKind: "validation" });

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
    assert.equal(recovery.status, "failed");
    assert.equal(recovery.startingCandidateIdentityHash, null);
    assert.equal(repaired.status, "BLOCKED");
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
    store.transitionTask(failed.task_id, "FAILED", "system", { failure_reason: "workspace scope mismatch" });
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
        return { ...staged, probe: async (repoId: string) => this.failedProbe(repoId) };
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
      recovery: { missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 },
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
    const h = blockedRepairHarness({ category: "REQUIREMENT_AMBIGUITY", failOwnershipRelease: true });

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
