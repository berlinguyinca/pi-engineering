/**
 * Issue #360: a BLOCKED mission whose repair gate refuses to create repair
 * tasks because NO candidate is recorded must not dead-loop. Two required
 * behaviors:
 *
 *   (a) no recorded candidate + a preserved worker branch holding a committed,
 *       Git-verifiable commit ahead of base  ->  the gate reconstructs the
 *       candidate (Git-verified), records it, re-runs validation/review, and
 *       completes.
 *
 *   (b) no recorded candidate + NO preserved work  ->  the gate fails cleanly
 *       and FINITELY (no repeated CREATE_REPAIR_TASKS refusal loop) with an
 *       operator-facing explanation.
 *
 * STATUS(#360): SKIPPED — this is the acceptance spec for the fix. The
 * Git-verified reconstruction primitive (`MissionStore.recordReconstructedCandidate`)
 * is implemented and unit-tested. What remains is the orchestrator wiring in the
 * gate-refusal branch: (1) select a Git-verifiable preserved checkpoint, (2) seed
 * the broker's candidate-TARGET worktree with that content (validation with
 * candidateScoped backends throws CANDIDATE_UNAVAILABLE otherwise), and (3) record
 * the reconstructed candidate and re-run the gate. See the handoff in
 * docs/specs/.../HANDOFF-gate-no-candidate.md.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const EMPTY_DIFF_HASH = `sha256:${createHash("sha256").update("").digest("hex")}`;

interface Calls {
  validation: number;
  review: number;
}

function backendsFor(calls: Calls): BrokerBackends {
  return {
    agent: {
      runAgent: async () => {
        throw new Error("agent must not run in these scenarios");
      },
    },
    integration: {
      candidateScoped: true,
      runIntegration: async () => ({
        executionId: "integration",
        exitStatus: "succeeded",
        summary: "integrated",
        artifactRefs: [],
        usage: {},
      }),
    },
    validation: {
      candidateScoped: true,
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
      candidateScoped: true,
      runReview: async ({ acceptanceCriteria }) => ({
        executionId: "review",
        exitStatus: "succeeded",
        summary: "approved",
        artifactRefs: [],
        usage: {},
        findings: [],
        reviewEvidence: {
          reviewerSessionId: "review-no-candidate",
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
      }),
    },
  };
}

async function harnessFor(reconstructable: boolean) {
  const fixture = await makeFixtureRepo();
  const git = (await GitRepo.open(fixture.root))!;
  const baseSha = await git.headCommit();

  // Preserved worker work: a branch one real commit ahead of base that makes
  // the fixture test pass (implements add.js).
  let preservedSha: string | null = null;
  let preservedBranch: string | null = null;
  if (reconstructable) {
    preservedBranch = "preserved-worker-branch";
    const wt = await git.createWorktree(baseSha, preservedBranch);
    await writeFile(join(wt.path, "src", "add.js"), "export function add(a, b) {\n  return a + b;\n}\n");
    await git.commitAll(wt.path, "preserved work: implement add");
    preservedSha = await git.headCommitIn(wt.path);
  }

  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const registry = new RepositoryRegistry();
  const calls: Calls = { validation: 0, review: 0 };
  const orchestrator = new Orchestrator({
    store,
    repositoryRegistry: registry,
    backends: backendsFor(calls),
    planner: async () => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "implement add",
        mutates_repo: true,
        write_domains: ["src/**"],
        isolation: "worktree" as const,
        depends_on: [],
        priority: 0,
        execution_requirements: {},
        acceptance_ids: [],
        max_attempts: 1,
        failure_policy: "block" as const,
      },
    ],
    recovery: { missionCeiling: 20, strategyMaxAttempts: 5 },
  });

  // Build the BLOCKED, no-candidate mission state.
  const mission = store.createMission({
    mission_id: "MSN-no-cand",
    title: "no candidate",
    goal: "no candidate",
    user_request: `no candidate ${fixture.root}`,
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
        repoId: "repo-nc",
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
  // A failed implementer task + execution (died before publishing a candidate).
  const task = store.createTask({
    task_id: "TSK-impl",
    mission_id: missionId,
    kind: "agent",
    role: "implementer",
    objective: "implement add",
    repo_id: "repo-nc",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
    deliverables: ["implement add"],
  });
  store.transitionTask("TSK-impl", "READY");
  const execution = store.createExecution({
    task_id: "TSK-impl",
    mission_id: missionId,
    backend: "agent",
    repo_id: "repo-nc",
    base_sha: baseSha,
  });
  store.transitionTask("TSK-impl", "RUNNING", "system", { assigned_execution_id: execution.execution_id });
  store.setExecutionStatus(execution.execution_id, "RUNNING");
  store.setExecutionStatus(execution.execution_id, "FAILED", { exit_status: "failed" });
  store.transitionTask("TSK-impl", "FAILED", "system", { failure_reason: "agent.loop_prevented" });
  // The failed implementer was already superseded by an earlier recovery
  // (as after leG4ua's repeated auto-recoveries), so there is no recoverable
  // pre-candidate implementer left -> the gate-refusal branch is reachable.
  store.createTask({
    task_id: "TSK-repl",
    mission_id: missionId,
    kind: "agent",
    role: "implementer",
    objective: "replacement",
    repo_id: "repo-nc",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
    deliverables: ["deliver"],
  });
  store.transitionTask("TSK-repl", "READY");
  store.transitionTask("TSK-repl", "CANCELED");
  store.supersedeTask({
    supersessionId: "SUP-earlier",
    missionId,
    failedTaskId: "TSK-impl",
    replacementTaskIds: ["TSK-repl"],
    repoId: "repo-nc",
    acceptanceIds: [],
    coverageFingerprint: taskCoverageFingerprint(store.getTask("TSK-impl")!),
    reason: "earlier recovery",
    createdAt: "2026-09-27T00:00:01.500Z",
  });

  // Durable preserved work: a checkpoint naming the preserved commit/branch.
  if (reconstructable && preservedSha && preservedBranch) {
    store.checkpointTask({
      checkpointId: "TCP-preserved",
      executionId: execution.execution_id,
      missionId,
      taskId: task.task_id,
      repoId: "repo-nc",
      baseSha,
      candidateSha: preservedSha,
      branch: preservedBranch,
      worktree: null,
      committedChanges: [preservedSha],
      preservedUncommittedChanges: [],
      completedDeliverables: ["implement add"],
      remainingDeliverables: [],
      acceptanceIds: [],
      validationEvidenceRefs: [],
      artifactRefs: [],
      artifactHashes: [],
      workerId: null,
      sessionId: null,
      model: null,
      sequence: 1,
      missionGeneration: 0,
      candidateGeneration: 0,
      fencingToken: 0,
      createdAt: "2026-09-27T00:00:01.000Z",
    });
  }

  // Mission-level failure classification (no taskId) -> the refusal branch.
  store.classifyFailure({
    classificationId: "FC-nocand",
    missionId,
    taskId: null,
    executionId: null,
    category: "IMPLEMENTATION_DEFECT",
    evidenceRefs: [],
    fingerprint: `sha256:${"b".repeat(64)}`,
    summary: "implementer stalled before publishing a candidate",
    classifiedAt: "2026-09-27T00:00:02.000Z",
  });
  store.transitionMission(missionId, "BLOCKED");
  store.stopMission(missionId, {
    reason: "implementer died before publishing a candidate",
    preservedWork: reconstructable ? [preservedSha!, preservedBranch!] : [],
    attemptedRecoveries: [],
    resumeCondition: "resume",
  });
  store.resumeMission(missionId, "operator resume");
  await store.flush();
  await registry.register(manifest);

  return { fixture, git, baseSha, preservedSha, preservedBranch, store, registry, calls, orchestrator, missionId };
}

describe.skip("recovery gate with no recorded candidate (#360) — acceptance spec, pending orchestrator wiring", () => {
  it("(a) reconstructs a Git-verified candidate from preserved work, re-runs the gate, and completes", async () => {
    const h = await harnessFor(true);
    try {
      const resumed = await h.orchestrator.repairBlockedMission(h.missionId);
      const candidate = h.store.getCandidate(h.missionId);
      assert.ok(candidate, "a candidate was reconstructed");
      assert.ok(candidate!.identity.diffHash !== EMPTY_DIFF_HASH, "the reconstructed candidate has a real diff");
      assert.equal(candidate!.identity.candidateSha, h.preservedSha ?? undefined, "candidate is the preserved commit");
      assert.ok(candidate!.reconstructedFrom, "candidate is marked as reconstructed");
      assert.equal(candidate!.reconstructedFrom!.checkpointId, "TCP-preserved");
      // Git-verifiable: the sha resolves and is ahead of base.
      const ahead = await h.git.revListCount(`${h.baseSha}..${candidate!.identity.candidateSha}`);
      assert.ok(ahead !== null && ahead > 0, "candidate is Git-verified ahead of base");
      // The gate re-ran against the reconstructed candidate.
      assert.ok(h.calls.validation > 0, "validation re-ran");
      assert.ok(h.calls.review > 0, "review re-ran");
      // No baseline refusal.
      assert.deepEqual(
        h.store.listFindings(h.missionId).filter((f) => f.category === "recovery_candidate_baseline"),
        [],
        "no baseline refusal finding",
      );
      assert.equal(resumed.status, "COMPLETE", JSON.stringify({ stop: h.store.listMissionStops(h.missionId).at(-1) }));
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("(b) with no preserved work, fails cleanly and FINITELY (no refusal loop)", async () => {
    const h = await harnessFor(false);
    try {
      const recoveriesBefore = h.store.listRecoveryDecisions(h.missionId).length;
      const resumed = await h.orchestrator.repairBlockedMission(h.missionId);
      const stop = h.store.listMissionStops(h.missionId).at(-1);
      // Operator-facing explanation naming the missing candidate.
      assert.match(stop?.reason ?? "", /no candidate|candidate/i);
      assert.ok(
        h.store
          .listFindings(h.missionId)
          .some((f) => f.category === "recovery_candidate_baseline" && /Git-verified|reconstruct/i.test(f.summary)),
        "an operator-facing baseline finding was recorded",
      );
      // Finite: a second repair pass does not re-enter the refusal loop.
      const resumedAgain = await h.orchestrator.repairBlockedMission(h.missionId);
      const recoveriesAfter = h.store.listRecoveryDecisions(h.missionId).length;
      assert.equal(recoveriesAfter, recoveriesBefore, "no further recovery decisions are created on re-entry (finite)");
      assert.equal(h.calls.validation, 0, "the gate is not re-run with no candidate");
      assert.equal(resumed.status, "BLOCKED");
      assert.equal(resumedAgain.status, "BLOCKED");
    } finally {
      await h.fixture.cleanup();
    }
  });
});
