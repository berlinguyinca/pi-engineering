import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { EngineeringRuntime, GitRepo } from "../../src/index.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { MissionSupervisor } from "../../src/orchestration/supervisor.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { VerificationProvider } from "../../src/verify/Verifier.ts";
import type { WorkerExecutor } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

function reviewAcceptance(task: string) {
  return [...task.matchAll(/Acceptance criterion ([^:]+):/g)].map((match) => ({
    acceptanceId: match[1]!,
    status: "passed" as const,
    detail: "fresh same-model session checked the current candidate",
  }));
}

function workerFor(implement: (cwd: string) => Promise<void>, reviewWarnings: string[] = []): WorkerExecutor {
  return {
    async run(request) {
      if (request.role === "implementer") await implement(request.cwd!);
      if (request.role === "reviewer") {
        reviewWarnings.push("same-model review used a fresh session with reduced independence");
      }
      return {
        result: {
          status: "completed",
          summary: `${request.role} completed`,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 1,
          turns: 1,
          model: "local/local",
        },
        toolCalls: 0,
        structured:
          request.resultTool === "review_result"
            ? {
                verdict: "approve",
                findings: [],
                missingTests: [],
                specGaps: [],
                acceptanceResults: reviewAcceptance(request.task),
                summary: "approved in a fresh same-model session",
              }
            : undefined,
      };
    },
  };
}

async function greenFixture() {
  const fixture = await makeFixtureRepo();
  await writeFile(join(fixture.root, "src", "add.js"), "export function add(a, b) { return a + b; }\n");
  await exec("git", ["-C", fixture.root, "add", "-A"]);
  await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "green baseline"]);
  return fixture;
}

function createMission(store: MissionStore, missionId: string, repository = "/tmp/repo") {
  return store.createMission({
    mission_id: missionId,
    title: "mission reliability proof",
    goal: "finish bounded work",
    user_request: "finish bounded work",
    repository,
    base_ref: "base-sha",
    risk_profile: "high",
    workflow_class: "engineering_review",
  });
}

function transitionToExecuting(store: MissionStore, missionId: string): void {
  for (const status of ["CLASSIFYING", "PLANNING", "READY", "EXECUTING"] as const) {
    store.transitionMission(missionId, status);
  }
}

function blockedCheckpointHarness(roots: [string, string]) {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = createMission(store, "MSN-qSLaeM", roots[0]);
  store.bindWorkspaceManifest({
    manifestId: "WM-qSLaeM",
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: roots.map((canonicalPath) => ({
      canonicalPath,
      source: "explicit_user_path" as const,
      access: "write" as const,
    })),
    // Slice 1 authorizes multiple roots but executes one repository per task.
    // Cross-repository dependency/promotion coordination remains Slice 2.
    repositories: [
      {
        repoId: "repo-1",
        canonicalRoot: roots[0],
        baseRef: "main",
        baseSha: "base-sha",
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-qSLaeM",
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  transitionToExecuting(store, mission.mission_id);
  const task = store.createTask({
    task_id: "TSK-qSLaeM-original",
    mission_id: mission.mission_id,
    repo_id: "repo-1",
    kind: "agent",
    role: "implementer",
    objective: "finish one, two, and three",
    deliverables: ["one", "two", "three"],
    mutates_repo: false,
    max_attempts: 1,
  });
  store.transitionTask(task.task_id, "READY");
  const execution = store.createExecution({
    task_id: task.task_id,
    mission_id: mission.mission_id,
    backend: "agent",
    repo_id: "repo-1",
    base_sha: "base-sha",
    checkpoint_id: "CHK-qSLaeM",
    mission_generation: 0,
    candidate_generation: 0,
    fencing_token: 0,
  });
  store.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
  store.setExecutionStatus(execution.execution_id, "RUNNING");
  store.transitionTask(task.task_id, "FAILED", "system", { failure_reason: "task execution budget exhausted" });
  store.checkpointTask({
    checkpointId: "CHK-qSLaeM",
    executionId: execution.execution_id,
    missionId: mission.mission_id,
    taskId: task.task_id,
    repoId: "repo-1",
    baseSha: "base-sha",
    candidateSha: "checkpoint-sha",
    branch: "pi-eng-orch-TSK-qSLaeM-original",
    worktree: "/tmp/preserved-qSLaeM",
    committedChanges: ["one"],
    preservedUncommittedChanges: [],
    completedDeliverables: ["one"],
    remainingDeliverables: ["two", "three"],
    acceptanceIds: [],
    validationEvidenceRefs: [],
    artifactRefs: [],
    artifactHashes: [],
    workerId: "worker-old",
    sessionId: "session-old",
    model: "local/local",
    sequence: 1,
    missionGeneration: 0,
    candidateGeneration: 0,
    fencingToken: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
  });
  store.classifyFailure({
    classificationId: "FC-qSLaeM-budget",
    missionId: mission.mission_id,
    taskId: task.task_id,
    executionId: execution.execution_id,
    category: "TASK_BUDGET_EXHAUSTED",
    evidenceRefs: ["CHK-qSLaeM"],
    fingerprint: "sha256:qSLaeM-budget",
    summary: "task execution budget exhausted after checkpoint",
    classifiedAt: "2026-09-27T00:00:01.000Z",
  });
  store.transitionMission(mission.mission_id, "BLOCKED");
  const reviewSessions: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    backends: {
      agent: {
        runAgent: async () => ({
          executionId: "replacement",
          exitStatus: "succeeded",
          summary: "remaining deliverable completed",
          artifactRefs: [],
          usage: {},
        }),
      },
      validation: {
        runValidation: async () => ({
          executionId: "validation",
          exitStatus: "succeeded",
          summary: "current candidate validated",
          artifactRefs: [],
          usage: {},
        }),
      },
      review: {
        runReview: async () => {
          reviewSessions.push("fresh-session:same-model-reduced:local/local");
          return {
            executionId: "review",
            exitStatus: "succeeded",
            summary: "approved with reduced-independence warning",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    },
    planner: async () => [],
    recovery: { missionCeiling: 4, strategyMaxAttempts: 2, decisionTtlMs: 60_000 },
    now: () => Date.parse("2026-09-27T00:00:10.000Z"),
  });
  return { backend, store, mission, task, execution, orchestrator, reviewSessions };
}

describe("mission reliability foundation — synthetic MSN-qSLaeM", () => {
  it("repairs only checkpoint remainder, rejects the old late result, and reaches a durable outcome", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    try {
      const h = blockedCheckpointHarness([first.root, second.root]);
      const manifest = h.store.getWorkspaceManifest(h.mission.mission_id)!;
      assert.deepEqual(
        manifest.authorizedRoots.map((root) => root.canonicalPath),
        [first.root, second.root],
      );

      const repaired = await h.orchestrator.repairBlockedMission(h.mission.mission_id);
      await h.store.recordLateExecution(h.execution.execution_id, "fenced after timeout", {
        kind: "backend_result",
        exitStatus: "succeeded",
        summary: "old worker claimed all three deliverables",
        error: null,
        artifactRefs: ["artifact://late-result"],
        findings: [],
        handoffs: [],
        recovery: [],
        gate: null,
      });
      const replacements = h.store
        .listTasks(h.mission.mission_id)
        .filter((candidate) => candidate.objective.startsWith("Recover "));

      assert.deepEqual(replacements.map((task) => task.deliverables?.[0]).sort(), ["three", "two"]);
      assert.equal(h.store.getExecution(h.execution.execution_id)?.exit_status, "orphaned_execution_reconciled");
      assert.ok(
        h.backend
          .all()
          .some(
            (event) =>
              event.type === "execution.late_result_rejected" && event.payload.reason === "fenced after timeout",
          ),
      );
      assert.ok(["COMPLETE", "BLOCKED"].includes(repaired.status), `unexpected repaired status: ${repaired.status}`);
      if (repaired.status === "BLOCKED") {
        const stop = h.store.listMissionStops(h.mission.mission_id).at(-1);
        assert.ok(stop?.reason);
        assert.ok(stop?.resumeCondition);
        assert.ok(stop?.preservedWork.length);
      }
      assert.ok(
        h.store.listTaskSupersessions(h.mission.mission_id).some((lineage) => lineage.failedTaskId === h.task.task_id),
      );
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("keeps the incumbent unchanged when integration conflicts", async () => {
    const fixture = await greenFixture();
    let runtime: EngineeringRuntime | undefined;
    try {
      const git = (await GitRepo.open(fixture.root))!;
      const base = await git.headCommit();
      await writeFile(
        join(fixture.root, "src", "add.js"),
        "export function add(a, b) { return a + b; // incumbent\n}\n",
      );
      await exec("git", ["-C", fixture.root, "add", "-A"]);
      await exec("git", ["-C", fixture.root, "commit", "-q", "-m", "incumbent divergence"]);
      const incumbent = await git.headCommit();
      runtime = await EngineeringRuntime.open({
        cwd: fixture.root,
        worker: workerFor(async (cwd) => {
          await writeFile(join(cwd, "src", "add.js"), "export function add(a, b) { return a + b; // worker\n}\n");
        }),
      });

      const result = await runtime.orchestrator!.orchestrate("Annotate add", {
        repository: fixture.root,
        baseRef: base,
        mutationRequested: true,
      });

      assert.equal(result.completed, false);
      assert.equal(await git.headCommit(), incumbent);
      assert.match(await readFile(join(fixture.root, "src", "add.js"), "utf8"), /incumbent/);
    } finally {
      await runtime?.close();
      await fixture.cleanup();
    }
  });

  it("records a fresh same-model review with the reduced-independence warning", async () => {
    const fixture = await greenFixture();
    let runtime: EngineeringRuntime | undefined;
    try {
      runtime = await EngineeringRuntime.open({
        cwd: fixture.root,
        model: {
          provider: "local",
          id: "local",
          api: "openai-completions",
          contextWindow: 256_000,
          maxTokens: 32_768,
        } as never,
        worker: workerFor(async (cwd) => {
          await writeFile(join(cwd, "src", "reviewed.js"), "export const reviewed = true;\n");
        }),
      });
      const baseRef = await runtime.git!.headCommit();

      const result = await runtime.orchestrator!.orchestrate("Add reviewed module", {
        repository: fixture.root,
        baseRef,
        mutationRequested: true,
      });
      const evidence = runtime.missionStore!.listReviewEvidence(result.mission.mission_id).at(-1);

      assert.equal(result.completed, true, result.failureReason ?? "");
      assert.equal(evidence?.independenceMode, "same_model_reduced");
      assert.equal(evidence?.model, "local");
      assert.equal(evidence?.provider, "local");
      assert.ok(evidence?.reviewerSessionId);
    } finally {
      await runtime?.close();
      await fixture.cleanup();
    }
  });

  it("keeps the incumbent unchanged when current-candidate validation is red", async () => {
    const fixture = await greenFixture();
    let runtime: EngineeringRuntime | undefined;
    try {
      const git = (await GitRepo.open(fixture.root))!;
      const incumbent = await git.headCommit();
      const redVerifier: VerificationProvider = {
        async detect() {
          return { name: "red", stages: [] };
        },
        async run() {
          return {
            passed: false,
            noTargets: false,
            stages: [],
            failedStage: "test",
            evidence: [],
          };
        },
      };
      runtime = await EngineeringRuntime.open({
        cwd: fixture.root,
        verifier: redVerifier,
        worker: workerFor(async (cwd) => {
          await writeFile(join(cwd, "src", "candidate-only.js"), "export const candidateOnly = true;\n");
        }),
      });

      const result = await runtime.orchestrator!.orchestrate("Add candidate-only module", {
        repository: fixture.root,
        baseRef: incumbent,
        mutationRequested: true,
      });

      assert.equal(result.completed, false);
      assert.equal(await git.headCommit(), incumbent);
      await assert.rejects(() => readFile(join(fixture.root, "src", "candidate-only.js"), "utf8"), /ENOENT/);
    } finally {
      await runtime?.close();
      await fixture.cleanup();
    }
  });

  it("replays checkpoint, failure fingerprint, and recovery budget after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-eng-mission-restart-"));
    const eventFile = join(directory, "orchestration.jsonl");
    try {
      const first = await JsonlEventStore.open(eventFile);
      const initial = MissionStore.open(first);
      const mission = createMission(initial, "MSN-restart");
      transitionToExecuting(initial, mission.mission_id);
      const task = initial.createTask({
        task_id: "TSK-restart",
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "resume after restart",
        repo_id: "repo-restart",
        deliverables: ["kept", "remaining"],
      });
      initial.transitionTask(task.task_id, "READY");
      const execution = initial.createExecution({
        task_id: task.task_id,
        mission_id: mission.mission_id,
        backend: "agent",
        repo_id: "repo-restart",
        base_sha: "base-sha",
      });
      initial.transitionTask(task.task_id, "RUNNING", "system", { assigned_execution_id: execution.execution_id });
      initial.setExecutionStatus(execution.execution_id, "RUNNING");
      initial.checkpointTask({
        checkpointId: "CHK-restart",
        executionId: execution.execution_id,
        missionId: mission.mission_id,
        taskId: task.task_id,
        repoId: "repo-restart",
        baseSha: "base-sha",
        candidateSha: "checkpoint-sha",
        branch: "pi-eng-orch-TSK-restart",
        worktree: "/tmp/preserved-restart",
        committedChanges: ["kept"],
        preservedUncommittedChanges: [],
        completedDeliverables: ["kept"],
        remainingDeliverables: ["remaining"],
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
      initial.classifyFailure({
        classificationId: "FC-restart",
        missionId: mission.mission_id,
        taskId: null,
        executionId: null,
        category: "PROVIDER_TRANSIENT",
        evidenceRefs: [],
        fingerprint: "sha256:restart-fingerprint",
        summary: "provider unavailable",
        classifiedAt: "2026-09-27T00:00:00.000Z",
      });
      initial.planRecovery({
        recoveryId: "RCV-restart-1",
        missionId: mission.mission_id,
        classificationId: "FC-restart",
        action: "PROBE_AND_BACKOFF",
        expectedMaterialChange: "healthy local provider probe",
        attempt: 1,
        maxAttempts: 2,
        deadline: "2026-09-27T00:01:00.000Z",
        nextActionAt: "2026-09-27T00:00:10.000Z",
        status: "planned",
        decidedAt: "2026-09-27T00:00:00.000Z",
        failureFingerprint: "sha256:restart-fingerprint",
      });
      await initial.flush();
      first.close();

      const second = await JsonlEventStore.open(eventFile);
      const replayed = MissionStore.open(second);
      assert.equal(
        replayed.listFailureClassifications(mission.mission_id).at(-1)?.fingerprint,
        "sha256:restart-fingerprint",
      );
      assert.equal(replayed.listRecoveryDecisions(mission.mission_id).at(-1)?.attempt, 1);
      assert.deepEqual(replayed.listTaskCheckpoints(mission.mission_id).at(-1)?.remainingDeliverables, ["remaining"]);
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops with preserved work and an exact resume condition when a fingerprint is exhausted", async () => {
    const first = await greenFixture();
    const second = await greenFixture();
    try {
      const h = blockedCheckpointHarness([first.root, second.root]);
      for (const attempt of [1, 2]) {
        h.store.planRecovery({
          recoveryId: `RCV-qSLaeM-${attempt}`,
          missionId: h.mission.mission_id,
          classificationId: "FC-qSLaeM-budget",
          action: "CHECKPOINT_SPLIT_AND_REPLACE",
          expectedMaterialChange: "split remaining checkpoint work",
          attempt,
          maxAttempts: 2,
          deadline: "2026-09-27T00:01:00.000Z",
          nextActionAt: "2026-09-27T00:00:10.000Z",
          status: "planned",
          decidedAt: "2026-09-27T00:00:00.000Z",
          failureFingerprint: "sha256:qSLaeM-budget",
        });
        h.store.transitionRecovery(`RCV-qSLaeM-${attempt}`, "failed");
      }

      const stopped = await h.orchestrator.repairBlockedMission(h.mission.mission_id);
      const stop = h.store.listMissionStops(h.mission.mission_id).at(-1)!;
      assert.equal(stopped.status, "BLOCKED");
      assert.match(stop.reason, /identical failure fingerprint exhausted/i);
      assert.ok(stop.preservedWork.includes("/tmp/preserved-qSLaeM"));
      assert.deepEqual(stop.attemptedRecoveries, ["RCV-qSLaeM-1", "RCV-qSLaeM-2"]);
      assert.match(stop.resumeCondition, /new material evidence|increase the approved recovery budget/i);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("classifies a nonterminal zero-worker mission as ORPHANED with a scheduled recovery", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = createMission(store, "MSN-zero-worker");
    transitionToExecuting(store, mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "runnable work",
      repo_id: "repo-orphan",
    });
    store.transitionTask(task.task_id, "READY");
    const observability = new MissionObservability({ backend, store });
    observability.missionCreated(mission.mission_id, mission.title);
    const supervisor = new MissionSupervisor({ store, observability });

    const [status] = await supervisor.tick();

    assert.equal(status?.health, "ORPHANED");
    assert.equal(status?.decision?.action, "FENCE_RECONCILE_AND_RESUME");
    assert.equal(status?.task, task.task_id);
  });

  it("isolates repository authority between two missions without mutating either incumbent", async () => {
    const fixture = await greenFixture();
    try {
      const git = (await GitRepo.open(fixture.root))!;
      const incumbent = await git.headCommit();
      const store = MissionStore.open(JsonlEventStore.inMemory());
      createMission(store, "MSN-lease-first", fixture.root);
      createMission(store, "MSN-lease-second", fixture.root);
      const ownership = new MissionOwnership(store, { ownerId: "local-controller", leaseMs: 60_000 });
      const firstMission = await ownership.acquire("MSN-lease-first");
      const secondMission = await ownership.acquire("MSN-lease-second");
      await ownership.acquireRepository(firstMission, "repo-shared");

      await assert.rejects(
        () => ownership.acquireRepository(secondMission, "repo-shared"),
        /repo-shared.*MSN-lease-first/i,
      );
      assert.equal(await git.headCommit(), incumbent);
      assert.equal((await git.status()).trim(), "");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a non-local dogfood model before launching Pi or creating a repository", async () => {
    await assert.rejects(
      () =>
        exec(process.execPath, ["scripts/dogfood-mission-recovery.ts", "--model", "metabolomics/remote"], {
          cwd: process.cwd(),
          env: { ...process.env, PI_MISSION_DOGFOOD_TEMP_PARENT: "/definitely-not-created" },
        }),
      (error: unknown) => {
        const failure = error as { stderr?: string };
        assert.match(failure.stderr ?? "", /requires exactly local\/local/i);
        return true;
      },
    );
  });
});
