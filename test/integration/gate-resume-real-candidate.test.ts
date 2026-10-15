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
import { buildCandidateEvidenceIdentity, taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
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
  /** Which gate failed; defaults to validation. */
  gate?: "validation" | "review";
  /** Validation already SUCCEEDED with Git-verified evidence for the candidate before the stop. */
  validatedBeforeStop?: boolean;
  /** A previous process owned the mission (lease generation 1) and stamped its work with that generation. */
  priorOwner?: boolean;
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
  if (options.validatedBeforeStop) {
    store.updateMission(missionId, { required_gates: ["validation", "independent_review"] });
  }
  const priorOwnership = options.priorOwner ? new MissionOwnership(store, { ownerId: "prior-process" }) : undefined;
  const priorLease = await priorOwnership?.acquire(missionId);
  const gen = priorLease?.generation ?? 0;
  const runTask = (
    taskId: string,
    kind: "integration" | "validation" | "review",
    terminal: "SUCCEEDED" | "FAILED",
    reason?: string,
  ) => {
    store.createTask({
      task_id: taskId,
      mission_id: missionId,
      kind,
      role: kind === "integration" ? "integrator" : kind === "review" ? "reviewer" : "validator",
      objective: `${kind} task`,
      repo_id: "repo-gate-resume",
      mission_generation: gen,
    });
    store.transitionTask(taskId, "READY");
    const execution = store.createExecution({
      task_id: taskId,
      mission_id: missionId,
      backend: kind,
      repo_id: "repo-gate-resume",
      base_sha: baseSha,
      mission_generation: gen,
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
      missionGeneration: gen,
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
  if (options.validatedBeforeStop) {
    const validation = runTask("TSK-validated", "validation", "SUCCEEDED");
    const candidate = store.getCandidate(missionId)!;
    store.recordValidationEvidence({
      evidenceId: "EV-validated",
      missionId,
      taskId: "TSK-validated",
      executionId: validation.execution_id,
      identity: candidate.identity,
      identityHash: candidate.identityHash,
      command: "test",
      profile: "test",
      exitCode: 0,
      testSummary: { passed: 1 },
      noTargets: false,
      accessible: true,
      acceptanceResults: [],
      recordedAt: new Date().toISOString(),
    });
  }
  const failedExecution = runTask("TSK-failed-gate", options.gate ?? "validation", "FAILED", options.failureReason);
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
  if (priorLease) await priorOwnership!.release(priorLease);
  const registry = new RepositoryRegistry();
  await registry.register(manifest);
  const calls = { validation: 0, review: 0, agent: 0 };
  /** A fresh orchestrator over the same store: the in-memory ownership maps start empty, as in a new process. */
  const buildOrchestrator = (ownership?: MissionOwnership) =>
    new Orchestrator({
      store,
      repositoryRegistry: registry,
      ownership,
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
  const orchestrator = buildOrchestrator();
  return {
    store,
    missionId,
    orchestrator,
    buildOrchestrator,
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

  it("re-runs the failed gate under the lease a fresh process acquired on resume", async () => {
    const h = await harness({ category: "PROVIDER_TRANSIENT", failureReason: "failed: Connection error." });
    try {
      const freshProcess = h.buildOrchestrator(new MissionOwnership(h.store, { ownerId: "fresh-process-controller" }));
      h.store.resumeMission(h.missionId, "operator resumed from a new session");
      const resumed = await freshProcess.repairBlockedMission(h.missionId);

      const signals = SIGNALS(h);
      assert.equal(resumed.status, "COMPLETE", JSON.stringify(signals));
      assert.equal(h.calls.validation, 1);
      assert.equal(h.calls.agent, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("re-runs a failed review gate under the lease a fresh process acquired, then releases the lease", async () => {
    const h = await harness({
      category: "PROVIDER_TRANSIENT",
      failureReason: "failed: Connection error.",
      gate: "review",
    });
    try {
      const freshProcess = h.buildOrchestrator(new MissionOwnership(h.store, { ownerId: "review-controller" }));
      h.store.resumeMission(h.missionId, "operator resumed from a new session");
      const resumed = await freshProcess.repairBlockedMission(h.missionId);

      assert.equal(resumed.status, "COMPLETE", JSON.stringify(SIGNALS(h)));
      assert.equal(h.calls.review, 1);
      assert.equal(h.calls.agent, 0);
      const next = new MissionOwnership(h.store, { ownerId: "next-controller" });
      await assert.doesNotReject(() => next.acquire(h.missionId));
    } finally {
      await h.cleanup();
    }
  });

  it("re-runs the validation a new generation invalidated, then the review, and completes", async () => {
    const h = await harness({
      category: "PROVIDER_TRANSIENT",
      failureReason: "failed: Connection error.",
      gate: "review",
      validatedBeforeStop: true,
      priorOwner: true,
    });
    try {
      const freshProcess = h.buildOrchestrator(new MissionOwnership(h.store, { ownerId: "fresh-validated" }));
      h.store.resumeMission(h.missionId, "operator resumed from a new session");
      const resumed = await freshProcess.repairBlockedMission(h.missionId);

      const stop = h.store.listMissionStops(h.missionId).at(-1);
      assert.equal(resumed.status, "COMPLETE", JSON.stringify({ ...SIGNALS(h), stop }));
      assert.equal(h.calls.review, 1);
      assert.equal(h.calls.validation, 1, "validation evidence invalidated by the new generation re-runs exactly once");
      assert.equal(h.calls.agent, 0);
    } finally {
      await h.cleanup();
    }
  });

  it("plans a single PROBE_AND_BACKOFF decision per resumption", async () => {
    const h = await harness({
      category: "PROVIDER_TRANSIENT",
      failureReason: "failed: Connection error.",
      gate: "review",
      validatedBeforeStop: true,
      priorOwner: true,
    });
    try {
      const freshProcess = h.buildOrchestrator(new MissionOwnership(h.store, { ownerId: "fresh-single-probe" }));
      h.store.resumeMission(h.missionId, "operator resumed from a new session");
      await freshProcess.repairBlockedMission(h.missionId);
      const generation = h.store.listMissionResumptions(h.missionId).at(-1)!.generation;
      const probes = h.store
        .listRecoveryDecisions(h.missionId)
        .filter((d) => d.action === "PROBE_AND_BACKOFF" && (d.resumptionGeneration ?? 0) === generation);
      assert.equal(probes.length, 1, JSON.stringify(probes.map((d) => [d.recoveryId, d.status])));
    } finally {
      await h.cleanup();
    }
  });

  describe("fallback to the current resumption lease", () => {
    type FlightHolder = { recoveryOwnershipByFlight: Map<string, unknown> };
    const withFlightLease = async (h: Awaited<ReturnType<typeof harness>>, ownerId: string, now?: () => number) => {
      h.store.resumeMission(h.missionId, "operator resume");
      const ownership = new MissionOwnership(h.store, { ownerId, leaseMs: 1_000, now });
      const orchestrator = h.buildOrchestrator(ownership);
      const generation = h.store.listMissionResumptions(h.missionId).at(-1)!.generation;
      const lease = await ownership.acquire(h.missionId, { resumptionGeneration: generation });
      (orchestrator as unknown as FlightHolder).recoveryOwnershipByFlight.set(`${h.missionId}:${generation}`, lease);
      return { orchestrator, generation };
    };
    const plainTask = (h: Awaited<ReturnType<typeof harness>>, id: string, fingerprint?: string) => {
      h.store.createTask({
        task_id: id,
        mission_id: h.missionId,
        kind: "validation",
        role: "validator",
        objective: "plain gate task",
        replacement_spec_fingerprint: fingerprint,
        repo_id: "repo-gate-resume",
      });
      return h.store.getTask(id)!;
    };

    it("gives a task with no recovery lineage the current resumption lease", async () => {
      const h = await harness({ category: "PROVIDER_TRANSIENT", failureReason: "failed: Connection error." });
      try {
        const { orchestrator } = await withFlightLease(h, "current-owner");
        const authority = await orchestrator.acquireTaskAuthority(plainTask(h, "TSK-plain"));
        assert.doesNotThrow(() => authority.assertAuthoritative());
        await authority.close();
      } finally {
        await h.cleanup();
      }
    });

    it("refuses a task whose lineage generation lost its lease instead of lending it the newer one", async () => {
      const h = await harness({ category: "PROVIDER_TRANSIENT", failureReason: "failed: Connection error." });
      try {
        const classification = h.store.listFailureClassifications(h.missionId).at(-1)!;
        const failed = h.store.getTask("TSK-failed-gate")!;
        const replacement = plainTask(h, "TSK-lineaged", "fp-lineaged");
        const decision = h.store.planRecovery({
          recoveryId: "RCV-old-generation",
          missionId: h.missionId,
          classificationId: classification.classificationId,
          action: "PROBE_AND_BACKOFF",
          expectedMaterialChange: "probe",
        } as unknown as Parameters<typeof h.store.planRecovery>[0]);
        h.store.supersedeTask({
          supersessionId: "SUP-old-generation",
          missionId: h.missionId,
          failedTaskId: failed.task_id,
          replacementTaskIds: [replacement.task_id],
          repoId: "repo-gate-resume",
          acceptanceIds: [],
          coverageFingerprint: taskCoverageFingerprint(failed),
          reason: "old generation lineage",
          createdAt: "2026-09-27T00:00:02.000Z",
          recoveryDecisionId: decision.recoveryId,
          expectedReplacementFingerprints: { [replacement.task_id]: "fp-lineaged" },
        });
        const { orchestrator } = await withFlightLease(h, "newer-owner");
        await assert.rejects(() => orchestrator.acquireTaskAuthority(replacement), /has no active ownership/);
      } finally {
        await h.cleanup();
      }
    });

    it("does not let a fenced owner obtain authority through the fallback", async () => {
      const h = await harness({ category: "PROVIDER_TRANSIENT", failureReason: "failed: Connection error." });
      try {
        let clock = Date.parse("2026-09-27T00:00:10.000Z");
        const now = () => clock;
        const { orchestrator, generation } = await withFlightLease(h, "fenced-owner", now);
        clock += 60_000;
        const usurper = new MissionOwnership(h.store, { ownerId: "usurper", leaseMs: 1_000, now });
        await usurper.acquire(h.missionId, { resumptionGeneration: generation });
        await assert.rejects(() => orchestrator.acquireTaskAuthority(plainTask(h, "TSK-fenced")));
      } finally {
        await h.cleanup();
      }
    });
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
