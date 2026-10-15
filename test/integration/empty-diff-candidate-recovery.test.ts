/**
 * Issue #173 / #129: an implementer that commits on its branch and dies before
 * worker_result must never be papered over by an empty-diff candidate, and a
 * mission that already holds an empty-diff candidate must recover from the
 * durable baseline in any process, against real git and the real broker.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import type { BrokerBackends } from "../../src/orchestration/broker.ts";
import { buildCandidateEvidenceIdentity, taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { describeRecoveryOutcome } from "../../src/orchestration/recovery.ts";
import { RepositoryRegistry } from "../../src/orchestration/repositoryRegistry.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const EMPTY_DIFF_HASH = `sha256:${createHash("sha256").update("").digest("hex")}`;

type AgentMode = "die-after-commit" | "commit" | "nothing";

interface Calls {
  agent: number;
  validation: number;
  review: number;
  agentSawDeadWork: boolean[];
  /** How many validation runs fail before they pass. */
  failValidations?: number;
}

function backendsFor(git: GitRepo, calls: Calls, modes: AgentMode[]): BrokerBackends {
  return {
    agent: {
      runAgent: async ({ worktree }) => {
        const mode = modes[Math.min(calls.agent, modes.length - 1)]!;
        calls.agent++;
        if (!worktree) throw new Error("worktree missing");
        calls.agentSawDeadWork.push(existsSync(join(worktree, "src", "dead-worker.ts")));
        if (mode === "die-after-commit") {
          const name = calls.agent === 1 ? "dead-worker.ts" : `dead-worker-${calls.agent}.ts`;
          await writeFile(join(worktree, "src", name), "export const deadWorker = true;\n");
          await git.commitAll(worktree, "work committed before the worker died");
          return {
            executionId: "agent-dead",
            exitStatus: "failed",
            summary: "Worker failed: no worker_result",
            artifactRefs: [],
            usage: {},
          };
        }
        if (mode === "commit") {
          await writeFile(join(worktree, "src", `real-diff-${calls.agent}.ts`), "export const real = true;\n");
          await git.commitAll(worktree, "real diff");
        }
        return { executionId: "agent-ok", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
      },
    },
    integration: {
      candidateScoped: true,
      runIntegration: async (input) => {
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
              executionId: "integration",
              exitStatus: "failed",
              summary: merged.reason ?? "merge failed",
              artifactRefs: [],
              usage: {},
            };
          }
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
      runValidation: async () => {
        calls.validation++;
        if (calls.validation <= (calls.failValidations ?? 0)) {
          return {
            executionId: "validation",
            exitStatus: "failed",
            summary: "tests failed",
            artifactRefs: [],
            usage: {},
          };
        }
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
      runReview: async ({ acceptanceCriteria }) => {
        calls.review++;
        return {
          executionId: "review",
          exitStatus: "succeeded",
          summary: "approved",
          artifactRefs: [],
          usage: {},
          findings: [],
          reviewEvidence: {
            reviewerSessionId: "review-empty-diff",
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
}

async function orchestratorFor(
  store: MissionStore,
  git: GitRepo,
  registry: RepositoryRegistry,
  calls: Calls,
  modes: AgentMode[],
) {
  return new Orchestrator({
    store,
    repositoryRegistry: registry,
    backends: backendsFor(git, calls, modes),
    planner: async (mission) => [
      {
        kind: "agent" as const,
        role: "implementer",
        objective: "Add the dead-worker module",
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
}

async function flowHarness(modes: AgentMode[], failValidations = 0) {
  const fixture = await makeFixtureRepo();
  const git = (await GitRepo.open(fixture.root))!;
  const baseSha = await git.headCommit();
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const registry = new RepositoryRegistry();
  const calls: Calls = { agent: 0, validation: 0, review: 0, agentSawDeadWork: [], failValidations };
  const orchestrator = await orchestratorFor(store, git, registry, calls, modes);
  return { fixture, git, baseSha, backend, store, registry, calls, orchestrator };
}

describe("never publish an empty-diff candidate over preserved worker work (#173)", () => {
  it("re-adopts the branch of an implementer that committed then died, and completes", async () => {
    const h = await flowHarness(["die-after-commit", "nothing"]);
    try {
      const result = await h.orchestrator.orchestrate(`Add the dead-worker module in ${h.fixture.root}`, {
        repository: h.fixture.root,
        baseRef: h.baseSha,
        mutationRequested: true,
      });
      const missionId = result.mission.mission_id;
      const candidates = h.store.listCandidates(missionId);
      assert.ok(
        candidates.every((candidate) => candidate.identity.diffHash !== EMPTY_DIFF_HASH),
        `an empty-diff candidate was published: ${JSON.stringify(candidates.map((c) => c.identity.diffHash))}`,
      );
      const findings = h.store.listFindings(missionId);
      assert.ok(
        findings.some((finding) => /pi-eng-orch-TSK-/.test(finding.summary) && /preserved/i.test(finding.summary)),
        JSON.stringify(findings.map((finding) => finding.summary)),
      );
      assert.ok(
        h.store.listFailureClassifications(missionId).some((entry) => entry.category === "IMPLEMENTATION_DEFECT"),
      );
      assert.equal(h.calls.agent, 2, "a second worker ran");
      assert.deepEqual(
        h.calls.agentSawDeadWork,
        [false, true],
        "the second worker starts from the dead worker's branch",
      );
      assert.equal(
        result.mission.status,
        "COMPLETE",
        JSON.stringify({ verdict: result.verdict, findings: findings.map((f) => f.summary) }),
      );
    } finally {
      await h.fixture.cleanup();
    }
  });

  /**
   * #129's durable state: a SUCCEEDED integration published a candidate with
   * candidateSha == baseSha and the empty diff hash; validation then failed.
   */
  async function emptyCandidateMission(
    failure: { kind: "validation"; category: "VALIDATION_FAILED" } | { kind: "orphan" } = {
      kind: "validation",
      category: "VALIDATION_FAILED",
    },
  ) {
    const h = await flowHarness(["commit"]);
    const store = h.store;
    const mission = store.createMission({
      mission_id: "MSN-empty-diff",
      title: "empty diff",
      goal: "empty diff",
      user_request: `empty diff ${h.fixture.root}`,
      repository: h.fixture.root,
      base_ref: h.baseSha,
      risk_profile: "high",
      workflow_class: "engineering",
    });
    const missionId = mission.mission_id;
    const manifest = {
      manifestId: `WM-${missionId}`,
      missionId,
      generation: 1,
      authorizedRoots: [
        { canonicalPath: h.fixture.root, source: "existing_manifest" as const, access: "write" as const },
      ],
      repositories: [
        {
          repoId: "repo-empty",
          canonicalRoot: h.fixture.root,
          baseRef: h.baseSha,
          baseSha: h.baseSha,
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
    const settle = (taskId: string, kind: "agent" | "integration" | "validation", terminal: "SUCCEEDED" | "FAILED") => {
      store.createTask({
        task_id: taskId,
        mission_id: missionId,
        kind,
        role: kind === "agent" ? "implementer" : kind === "integration" ? "integrator" : "validator",
        objective: `${kind} ${taskId}`,
        repo_id: "repo-empty",
        mutates_repo: kind === "agent",
        isolation: kind === "agent" ? "worktree" : "none",
        write_domains: kind === "agent" ? ["src/**"] : [],
        deliverables: [`deliver ${taskId}`],
      });
      store.transitionTask(taskId, "READY");
      const execution = store.createExecution({
        task_id: taskId,
        mission_id: missionId,
        backend: kind === "agent" ? "agent" : kind,
        repo_id: "repo-empty",
        base_sha: h.baseSha,
      });
      store.transitionTask(taskId, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
      store.setExecutionStatus(execution.execution_id, "RUNNING");
      store.setExecutionStatus(execution.execution_id, terminal, {
        exit_status: terminal === "SUCCEEDED" ? "succeeded" : "failed",
      });
      store.transitionTask(
        taskId,
        terminal,
        "system",
        terminal === "FAILED" ? { failure_reason: "failed" } : undefined,
      );
      return execution;
    };
    const integration = settle("TSK-integration", "integration", "SUCCEEDED");
    store.recordCandidate(
      missionId,
      buildCandidateEvidenceIdentity({
        workspaceManifestHash: manifest.hash,
        missionGeneration: 0,
        repoId: "repo-empty",
        baseSha: h.baseSha,
        candidateSha: h.baseSha,
        diffHash: EMPTY_DIFF_HASH,
        acceptanceIds: [],
        artifactHashes: [],
      }),
      "empty candidate",
      { taskId: "TSK-integration", executionId: integration.execution_id },
    );
    const failedTaskId = failure.kind === "validation" ? "TSK-validation" : "TSK-implementer";
    const failed = settle(failedTaskId, failure.kind === "validation" ? "validation" : "agent", "FAILED");
    store.classifyFailure({
      classificationId: "FC-empty",
      missionId,
      taskId: failure.kind === "validation" ? failedTaskId : null,
      executionId: failure.kind === "validation" ? failed.execution_id : null,
      category: failure.kind === "validation" ? failure.category : "ORPHANED_EXECUTION",
      evidenceRefs: [],
      fingerprint: `sha256:${"a".repeat(64)}`,
      summary: failure.kind === "validation" ? "validation failed" : "orphaned execution",
      classifiedAt: "2026-09-27T00:00:01.000Z",
    });
    store.transitionMission(missionId, "BLOCKED");
    store.stopMission(missionId, {
      reason: "blocked on an empty candidate",
      preservedWork: [],
      attemptedRecoveries: [],
      resumeCondition: "resume",
    });
    store.resumeMission(missionId, "operator resume");
    await store.flush();
    const freshOrchestrator = async (modes: AgentMode[]) => {
      const freshStore = MissionStore.open(h.backend);
      const registry = new RepositoryRegistry();
      await registry.register(manifest);
      const calls: Calls = { agent: 0, validation: 0, review: 0, agentSawDeadWork: [] };
      return {
        store: freshStore,
        calls,
        orchestrator: await orchestratorFor(freshStore, h.git, registry, calls, modes),
      };
    };
    return { h, missionId, manifest, freshOrchestrator };
  }

  it("recovers from the durable empty-diff baseline and completes once a worker produces a real diff", async () => {
    const { h, missionId, manifest, freshOrchestrator } = await emptyCandidateMission();
    try {
      await h.registry.register(manifest);
      const resumed = await h.orchestrator.repairBlockedMission(missionId);
      assert.deepEqual(
        h.store.listFindings(missionId).filter((f) => f.category === "recovery_candidate_baseline"),
        [],
        "no baseline refusal",
      );
      assert.equal(resumed.status, "COMPLETE", JSON.stringify(h.store.listMissionStops(missionId).at(-1)));
      assert.notEqual(h.store.getCandidate(missionId)?.identity.diffHash, EMPTY_DIFF_HASH);
      void freshOrchestrator;
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("recovers the same way from a FRESH store and orchestrator", async () => {
    const { missionId, h, freshOrchestrator } = await emptyCandidateMission();
    try {
      const fresh = await freshOrchestrator(["commit"]);
      const resumed = await fresh.orchestrator.repairBlockedMission(missionId);
      assert.deepEqual(
        fresh.store.listFindings(missionId).filter((f) => f.category === "recovery_candidate_baseline"),
        [],
      );
      assert.equal(resumed.status, "COMPLETE", JSON.stringify(fresh.store.listMissionStops(missionId).at(-1)));
      assert.equal(fresh.calls.agent, 1);
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("answers verifiedCandidateContent identically after rehydration in a fresh process", async () => {
    const h = await flowHarness(["commit"], 99);
    try {
      const result = await h.orchestrator.orchestrate(`Add a real diff in ${h.fixture.root}`, {
        repository: h.fixture.root,
        baseRef: h.baseSha,
        mutationRequested: true,
      });
      const missionId = result.mission.mission_id;
      assert.equal(result.mission.status, "BLOCKED");
      const original = await h.orchestrator.broker.verifiedCandidateContent(missionId);
      assert.ok(original?.hasChanges, "the originating process verifies the candidate");

      await h.store.flush();
      const freshStore = MissionStore.open(h.backend);
      const registry = new RepositoryRegistry();
      await registry.register(freshStore.getWorkspaceManifest(missionId)!);
      const fresh = await orchestratorFor(
        freshStore,
        h.git,
        registry,
        { agent: 0, validation: 0, review: 0, agentSawDeadWork: [] },
        ["commit"],
      );
      await fresh.broker.rehydrateMission(missionId);
      assert.deepEqual(await fresh.broker.verifiedCandidateContent(missionId), original);
      assert.equal(fresh.broker.pendingIntegrations(missionId), h.orchestrator.broker.pendingIntegrations(missionId));
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("falls back to the failed leaf task when a fence classification names no task", async () => {
    const { h, missionId, freshOrchestrator } = await emptyCandidateMission({ kind: "orphan" });
    try {
      const fresh = await freshOrchestrator(["commit"]);
      const resumed = await fresh.orchestrator.repairBlockedMission(missionId);
      const decision = fresh.store.listRecoveryDecisions(missionId).at(-1)!;
      assert.equal(decision.action, "FENCE_RECONCILE_AND_RESUME");
      assert.deepEqual(
        fresh.store.listTaskSupersessions(missionId).map((lineage) => lineage.failedTaskId),
        ["TSK-implementer"],
      );
      assert.equal(fresh.calls.agent, 1, "the replacement worker ran");
      assert.equal(resumed.status, "COMPLETE", JSON.stringify(fresh.store.listMissionStops(missionId).at(-1)));
      assert.equal(decision.status, "succeeded");
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("re-runs the gates directly when a fence classification finds no failed task left", async () => {
    const { h, missionId, freshOrchestrator } = await emptyCandidateMission({ kind: "orphan" });
    try {
      const fresh = await freshOrchestrator(["commit"]);
      // The failed leaf is already superseded by an earlier recovery.
      fresh.store.createTask({
        task_id: "TSK-earlier-replacement",
        mission_id: missionId,
        kind: "agent",
        role: "implementer",
        objective: "agent TSK-implementer",
        repo_id: "repo-empty",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
        deliverables: ["deliver TSK-implementer"],
      });
      fresh.store.supersedeTask({
        supersessionId: "SUP-earlier",
        missionId,
        failedTaskId: "TSK-implementer",
        replacementTaskIds: ["TSK-earlier-replacement"],
        repoId: "repo-empty",
        acceptanceIds: [],
        coverageFingerprint: taskCoverageFingerprint(fresh.store.getTask("TSK-implementer")!),
        reason: "earlier recovery",
        createdAt: "2026-09-27T00:00:02.000Z",
      });
      fresh.store.transitionTask("TSK-earlier-replacement", "READY");
      fresh.store.transitionTask("TSK-earlier-replacement", "CANCELED");
      await fresh.orchestrator.repairBlockedMission(missionId);
      const decision = fresh.store.listRecoveryDecisions(missionId).at(-1)!;
      assert.equal(decision.action, "FENCE_RECONCILE_AND_RESUME");
      assert.equal(fresh.calls.agent, 0, "no worker ran: only the gates re-ran");
      assert.notEqual(decision.status, "planned");
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("states what the recovery ran and the current gate verdict", async () => {
    const { h, missionId, freshOrchestrator } = await emptyCandidateMission();
    try {
      const fresh = await freshOrchestrator(["nothing"]);
      const resumed = await fresh.orchestrator.repairBlockedMission(missionId);
      const decision = fresh.store.listRecoveryDecisions(missionId).at(-1)!;
      const text = describeRecoveryOutcome(decision, fresh.orchestrator.gate.evaluate(resumed));
      assert.match(text, /^CREATE_REPAIR_TASKS failed; gate blocked: /);
      assert.doesNotMatch(text, /resume|provider answers/);
      assert.equal(
        describeRecoveryOutcome(undefined, { can_complete: true, reasons: [] }),
        "no recovery action was started; gate can complete",
      );
    } finally {
      await h.fixture.cleanup();
    }
  });

  it("names the preserved branch from durable state in a fresh process", async () => {
    const h = await flowHarness(["die-after-commit"], 0);
    try {
      const result = await h.orchestrator.orchestrate(`Add the dead-worker module in ${h.fixture.root}`, {
        repository: h.fixture.root,
        baseRef: h.baseSha,
        mutationRequested: true,
      });
      const missionId = result.mission.mission_id;
      await h.store.flush();
      const freshStore = MissionStore.open(h.backend);
      const registry = new RepositoryRegistry();
      await registry.register(freshStore.getWorkspaceManifest(missionId)!);
      const fresh = await orchestratorFor(
        freshStore,
        h.git,
        registry,
        { agent: 0, validation: 0, review: 0, agentSawDeadWork: [] },
        ["commit"],
      );
      assert.equal(fresh.broker.pendingIntegrations(missionId), 0);
      await fresh.broker.rehydrateMission(missionId);
      assert.ok(fresh.broker.pendingIntegrations(missionId) > 0, "preserved worker branches are pending again");
      const { stranded } = await fresh.broker.strandedWorkerWork(missionId);
      assert.ok(stranded.some((entry) => entry.branch.startsWith("pi-eng-orch-TSK-")));
    } finally {
      await h.fixture.cleanup();
    }
  });
});
