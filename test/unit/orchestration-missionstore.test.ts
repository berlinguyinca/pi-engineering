import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import type {
  CandidateEvidenceIdentity,
  FailureClassification,
  MissionLease,
  RecoveryDecision,
  RepositoryLease,
  TaskCheckpoint,
  WorkspaceManifest,
} from "../../src/orchestration/types.ts";
import type { EventStoreBackend, StoredEvent } from "../../src/platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";

class FailOnceBackend implements EventStoreBackend {
  private readonly inner = JsonlEventStore.inMemory();
  private rejectNext = false;
  attempts = 0;

  failNextAppend(): void {
    this.rejectNext = true;
  }

  async append(event: StoredEvent): Promise<StoredEvent> {
    this.attempts += 1;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("mission persistence unavailable");
    }
    return this.inner.append(event);
  }

  async appendConditionally(
    event: StoredEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    this.attempts += 1;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("mission persistence unavailable");
    }
    return this.inner.appendConditionally(event, condition, onCommit);
  }

  async appendAll(events: StoredEvent[]): Promise<void> {
    await this.inner.appendAll(events);
  }

  all(): StoredEvent[] {
    return this.inner.all();
  }

  get(eventId: string): StoredEvent | undefined {
    return this.inner.get(eventId);
  }

  count(): number {
    return this.inner.count();
  }
}

class UnavailableBackend implements EventStoreBackend {
  attempts = 0;

  async append(_event: StoredEvent): Promise<StoredEvent> {
    this.attempts += 1;
    throw new Error("mission persistence unavailable");
  }

  async appendConditionally(
    _event: StoredEvent,
    _condition: () => boolean,
    _onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    this.attempts += 1;
    throw new Error("mission persistence unavailable");
  }

  async appendAll(_events: StoredEvent[]): Promise<void> {
    throw new Error("mission persistence unavailable");
  }

  all(): StoredEvent[] {
    return [];
  }

  get(_eventId: string): StoredEvent | undefined {
    return undefined;
  }

  count(): number {
    return 0;
  }
}

function store(): MissionStore {
  return MissionStore.open(JsonlEventStore.inMemory());
}

describe("MissionStore", () => {
  it("does not expose or replay a manifest whose durable bind fails", async () => {
    const backend = new FailOnceBackend();
    const s = MissionStore.open(backend);
    const mission = s.createMission({
      title: "manifest transaction",
      goal: "manifest transaction",
      user_request: "manifest transaction",
      repository: ".",
      base_ref: "base",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const original: WorkspaceManifest = {
      manifestId: "WM-original",
      missionId: mission.mission_id,
      generation: 1,
      authorizedRoots: [],
      repositories: [],
      dependencyEdges: [],
      hash: "original",
      createdAt: "2026-09-27T00:00:00.000Z",
    };
    await s.bindWorkspaceManifestDurably(original);
    backend.failNextAppend();
    await assert.rejects(
      s.bindWorkspaceManifestDurably({ ...original, manifestId: "WM-rebuilt", generation: 2, hash: "rebuilt" }),
      /persistence unavailable/i,
    );
    assert.equal(s.getWorkspaceManifest(mission.mission_id)?.hash, "original");
    assert.equal(MissionStore.open(backend).getWorkspaceManifest(mission.mission_id)?.hash, "original");
  });

  it("creates and transitions a mission through its lifecycle", async () => {
    const s = store();
    const m = s.createMission({
      title: "Add health endpoint",
      goal: "Add a health endpoint",
      user_request: "Add a health endpoint",
      repository: ".",
      base_ref: "abc123",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    assert.equal(m.status, "NEW");
    s.transitionMission(m.mission_id, "CLASSIFYING");
    s.transitionMission(m.mission_id, "PLANNING");
    s.transitionMission(m.mission_id, "READY");
    s.transitionMission(m.mission_id, "EXECUTING");
    s.transitionMission(m.mission_id, "INTEGRATING");
    s.transitionMission(m.mission_id, "VALIDATING");
    s.transitionMission(m.mission_id, "REVIEWING");
    s.transitionMission(m.mission_id, "FINAL_VALIDATION");
    const done = s.completeMission(m.mission_id);
    assert.equal(done.status, "COMPLETE");
    assert.ok(done.completed_at);
  });

  it("rejects illegal transitions", () => {
    const s = store();
    const m = s.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "conversation",
    });
    assert.throws(() => s.transitionMission(m.mission_id, "COMPLETE"));
  });

  it("persists acceptance criteria and constraints", () => {
    const s = store();
    const m = s.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      constraints: ["do not touch schema"],
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    s.addAcceptanceCriterion(m.mission_id, "existing tests pass");
    s.addAcceptanceCriterion(m.mission_id, "endpoint responds 200");
    s.setCriterionStatus(m.mission_id, 0, "passed", "test-run://t1");
    const got = s.getMission(m.mission_id)!;
    assert.equal(got.constraints[0], "do not touch schema");
    assert.equal(got.acceptance_criteria.length, 2);
    assert.equal(got.acceptance_criteria[0]!.status, "passed");
  });

  it("creates tasks with write domains and dependency edges", () => {
    const s = store();
    const m = s.createMission({
      title: "backend+frontend",
      goal: "Add backend and frontend support for feature X",
      user_request: "Add backend and frontend support for feature X",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const a = s.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "backend",
      write_domains: ["src/server/**"],
    });
    const b = s.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "frontend",
      write_domains: ["src/web/**"],
      depends_on: [a.task_id],
    });
    assert.equal(a.status, "PENDING");
    assert.equal(b.depends_on[0], a.task_id);
    assert.equal(s.listTasks(m.mission_id).length, 2);
    assert.equal(s.getMission(m.mission_id)!.task_ids.length, 2);
  });

  it("replays from events (restart recovery)", async () => {
    const backend = JsonlEventStore.inMemory();
    const s1 = MissionStore.open(backend);
    const m = s1.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    s1.transitionMission(m.mission_id, "CLASSIFYING");
    s1.transitionMission(m.mission_id, "PLANNING");
    s1.transitionMission(m.mission_id, "READY");
    s1.transitionMission(m.mission_id, "EXECUTING");
    const t = s1.createTask({ mission_id: m.mission_id, kind: "process", role: "validator", objective: "validate" });
    s1.transitionTask(t.task_id, "READY");
    s1.transitionTask(t.task_id, "RUNNING");
    await s1.flush();

    // Simulate a restart: a fresh store over the same events.
    const s2 = MissionStore.open(backend);
    const restored = s2.getMission(m.mission_id)!;
    assert.equal(restored.status, "EXECUTING");
    const task = s2.getTask(t.task_id)!;
    assert.equal(task.status, "RUNNING");
  });

  it("replays every supported task transition metadata field and rejects all others", async () => {
    const backend = JsonlEventStore.inMemory();
    const s1 = MissionStore.open(backend);
    const mission = s1.createMission({
      title: "task metadata",
      goal: "replay task metadata",
      user_request: "persist task metadata",
      repository: ".",
      base_ref: "main",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const task = s1.createTask({
      task_id: "TSK-metadata",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "persist metadata",
      mission_generation: 4,
      fencing_token: 9,
    });
    s1.transitionTask(task.task_id, "READY");
    const running = s1.transitionTask(task.task_id, "RUNNING", "system", {
      attempt: 2,
      assigned_execution_id: "EXC-metadata",
      failure_reason: "resumed after a durable wait",
    });
    assert.equal(running.attempt, 2);
    assert.equal(running.assigned_execution_id, "EXC-metadata");
    assert.equal(running.failure_reason, "resumed after a durable wait");

    for (const metadata of [
      { task_id: "TSK-other" },
      { mission_id: "MSN-other" },
      { mission_generation: 99 },
      { candidate_generation: 99 },
      { fencing_token: 99 },
      { arbitrary: "value" },
    ]) {
      assert.throws(
        () => s1.transitionTask(task.task_id, "FAILED", "system", metadata as never),
        /unsupported task transition metadata/,
      );
    }
    assert.deepEqual(s1.getTask(task.task_id), running, "rejected metadata leaves live state unchanged");

    await s1.flush();
    assert.deepEqual(MissionStore.open(backend).getTask(task.task_id), running);
  });

  it("retries a failed append in order so restart replays the complete semantic state", async () => {
    const backend = new FailOnceBackend();
    const s = MissionStore.open(backend);
    backend.failNextAppend();

    const m = s.createMission({
      title: "recover persistence",
      goal: "persist later mission changes",
      user_request: "keep the mission visible",
      repository: ".",
      base_ref: "main",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    s.addAcceptanceCriterion(m.mission_id, "later events remain durable");

    await s.flush();
    assert.equal(backend.attempts, 3, "the failed creation is retried before the later update");
    assert.deepEqual(
      backend.all().map((event) => event.type),
      ["mission.created", "mission.updated"],
      "dependent events persist only after their prerequisite",
    );
    assert.deepEqual(s.persistenceDiagnostics(), [], "a recovered append is no longer unresolved");

    const reopened = MissionStore.open(backend);
    assert.equal(reopened.getMission(m.mission_id)?.acceptance_criteria[0]?.criterion, "later events remain durable");
  });

  it("rejects flush and retains the ordered queue while persistence remains unavailable", async () => {
    const backend = new UnavailableBackend();
    const s = MissionStore.open(backend);
    const m = s.createMission({
      title: "unavailable persistence",
      goal: "surface durability failure",
      user_request: "do not claim a durable flush",
      repository: ".",
      base_ref: "main",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    s.addAcceptanceCriterion(m.mission_id, "later events stay queued");

    await assert.rejects(s.flush(), /mission persistence unavailable/);
    assert.equal(backend.count(), 0, "no dependent event overtakes the failed creation");
    assert.deepEqual(
      s.persistenceDiagnostics().map(({ eventType, missionId, message }) => ({ eventType, missionId, message })),
      [{ eventType: "mission.created", missionId: m.mission_id, message: "mission persistence unavailable" }],
    );
  });

  it("records and resolves review findings", () => {
    const s = store();
    const m = s.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const f = s.addFinding({
      mission_id: m.mission_id,
      task_id: null,
      severity: "blocking",
      category: "correctness",
      file: "src/auth/service.ts",
      line: 42,
      summary: "missing null check",
      evidence: "observed NPE",
      recommended_action: "add guard",
    });
    assert.equal(f.status, "open");
    assert.equal(s.listFindings(m.mission_id).length, 1);
    s.resolveFinding(f.finding_id);
    assert.equal(s.listFindings(m.mission_id)[0]!.status, "resolved");
  });

  it("replays reliability authority records byte-for-byte after restart", async () => {
    const backend = JsonlEventStore.inMemory();
    const s1 = MissionStore.open(backend);
    const mission = s1.createMission({
      mission_id: "MSN-replay",
      title: "replay reliability state",
      goal: "preserve recovery authority",
      user_request: "recover this mission",
      repository: "/workspace/repo-a",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    s1.addAcceptanceCriterion(mission.mission_id, "criterion one", undefined, "AC-1");
    s1.addAcceptanceCriterion(mission.mission_id, "criterion two", undefined, "AC-2");

    const manifest: WorkspaceManifest = {
      manifestId: "WM-1",
      missionId: mission.mission_id,
      generation: 3,
      authorizedRoots: [
        { canonicalPath: "/workspace", source: "explicit_user_path", access: "write" },
        { canonicalPath: "/workspace/read-only", source: "existing_manifest", access: "read" },
      ],
      repositories: [
        {
          repoId: "repo-a",
          canonicalRoot: "/workspace/repo-a",
          remote: "git@example.test:repo-a.git",
          baseRef: "main",
          baseSha: "base-a",
          writableDomains: ["src/**"],
          validationProfileRef: "profile://node",
        },
        {
          repoId: "repo-b",
          canonicalRoot: "/workspace/repo-b",
          baseRef: "main",
          baseSha: "base-b",
          writableDomains: ["packages/api/**"],
        },
      ],
      dependencyEdges: [{ fromRepoId: "repo-a", toRepoId: "repo-b" }],
      hash: "manifest-hash",
      createdAt: "2026-09-26T10:00:00.000Z",
    };
    s1.bindWorkspaceManifest(manifest);

    const failed = s1.createTask({
      task_id: "TSK-failed",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement criterion one",
      repo_id: "repo-a",
      acceptance_ids: ["AC-1"],
      candidate_generation: 4,
      mission_generation: 3,
      fencing_token: 7,
    });
    s1.transitionTask(failed.task_id, "READY");
    s1.transitionTask(failed.task_id, "RUNNING");
    s1.transitionTask(failed.task_id, "FAILED");
    const coverageFingerprint = taskCoverageFingerprint(failed);
    const replacement = s1.createTask({
      task_id: "TSK-replacement",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: failed.objective,
      repo_id: "repo-a",
      acceptance_ids: ["AC-1"],
      candidate_generation: 5,
      mission_generation: 4,
      fencing_token: 8,
      execution_requirements: { coverageFingerprint },
    });
    const execution = s1.createExecution({
      task_id: replacement.task_id,
      mission_id: mission.mission_id,
      backend: "agent",
      mission_generation: 4,
      fencing_token: 8,
    });

    const checkpoint: TaskCheckpoint = {
      checkpointId: "TCP-1",
      executionId: execution.execution_id,
      missionId: mission.mission_id,
      taskId: failed.task_id,
      repoId: "repo-a",
      baseSha: "base-a",
      candidateSha: "candidate-a",
      branch: "mission/replay",
      worktree: "/workspace/.worktrees/replay",
      committedChanges: ["commit-a"],
      preservedUncommittedChanges: ["artifact://dirty.patch"],
      completedDeliverables: ["implementation"],
      remainingDeliverables: ["tests"],
      acceptanceIds: ["AC-1"],
      validationEvidenceRefs: ["artifact://validation-partial"],
      artifactRefs: ["artifact://handoff"],
      artifactHashes: ["sha256:handoff"],
      workerId: "worker-1",
      sessionId: "session-1",
      model: "local/local",
      sequence: 2,
      missionGeneration: 3,
      candidateGeneration: 4,
      fencingToken: 7,
      createdAt: "2026-09-26T10:01:00.000Z",
    };
    s1.checkpointTask(checkpoint);

    const classification: FailureClassification = {
      classificationId: "FCL-1",
      missionId: mission.mission_id,
      taskId: failed.task_id,
      executionId: null,
      category: "TASK_BUDGET_EXHAUSTED",
      evidenceRefs: ["artifact://timeout"],
      fingerprint: "timeout:repo-a:tests",
      summary: "task exceeded its bounded execution budget",
      classifiedAt: "2026-09-26T10:02:00.000Z",
    };
    s1.classifyFailure(classification);

    const recovery: RecoveryDecision = {
      recoveryId: "RCV-1",
      missionId: mission.mission_id,
      classificationId: classification.classificationId,
      action: "CHECKPOINT_SPLIT_AND_REPLACE",
      expectedMaterialChange: "run only the remaining tests deliverable",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-26T10:20:00.000Z",
      nextActionAt: "2026-09-26T10:03:00.000Z",
      status: "planned",
      decidedAt: "2026-09-26T10:02:30.000Z",
    };
    s1.planRecovery(recovery);
    s1.supersedeTask({
      supersessionId: "SUP-1",
      missionId: mission.mission_id,
      failedTaskId: failed.task_id,
      replacementTaskIds: [replacement.task_id],
      repoId: "repo-a",
      acceptanceIds: ["AC-1"],
      coverageFingerprint,
      reason: "resume remaining work from checkpoint",
      createdAt: "2026-09-26T10:03:00.000Z",
    });

    const evidenceIdentity: CandidateEvidenceIdentity = {
      workspaceManifestHash: manifest.hash,
      missionGeneration: 4,
      repoId: "repo-a",
      baseSha: "base-a",
      candidateSha: "candidate-a",
      diffHash: "diff-a",
      acceptanceIds: ["AC-1"],
      artifactHashes: ["sha256:validation"],
    };
    s1.invalidateEvidence({
      invalidationId: "EVI-1",
      missionId: mission.mission_id,
      identity: evidenceIdentity,
      reason: "task_superseded",
      invalidatedAt: "2026-09-26T10:03:30.000Z",
    });

    const missionLease: MissionLease = {
      missionId: mission.mission_id,
      generation: 4,
      ownerId: "controller-1",
      acquiredAt: "2026-09-26T10:04:00.000Z",
      renewBy: "2026-09-26T10:05:00.000Z",
      fencingToken: 8,
    };
    const repositoryLease: RepositoryLease = {
      missionId: mission.mission_id,
      repoId: "repo-a",
      generation: 4,
      ownerId: "controller-1",
      acquiredAt: "2026-09-26T10:04:00.000Z",
      renewBy: "2026-09-26T10:05:00.000Z",
      fencingToken: 9,
    };
    s1.transitionMissionLease("acquired", missionLease);
    s1.transitionRepositoryLease("acquired", repositoryLease);
    s1.resumeMission(mission.mission_id, "repair state is durable");
    s1.stopMission(mission.mission_id, {
      reason: "recovery budget exhausted",
      preservedWork: ["artifact://handoff"],
      attemptedRecoveries: [recovery.recoveryId],
      resumeCondition: "increase the approved recovery budget",
    });

    const materialized = (s: MissionStore) => ({
      mission: s.getMission(mission.mission_id),
      tasks: s.listTasks(mission.mission_id),
      executions: s.listExecutions(mission.mission_id),
      manifest: s.getWorkspaceManifest(mission.mission_id),
      checkpoints: s.listTaskCheckpoints(mission.mission_id),
      classifications: s.listFailureClassifications(mission.mission_id),
      recoveries: s.listRecoveryDecisions(mission.mission_id),
      supersessions: s.listTaskSupersessions(mission.mission_id),
      invalidations: s.listEvidenceInvalidations(mission.mission_id),
      missionLease: s.getMissionLease(mission.mission_id),
      repositoryLeases: s.listRepositoryLeases(mission.mission_id),
      resumptions: s.listMissionResumptions(mission.mission_id),
      stops: s.listMissionStops(mission.mission_id),
    });
    const before = JSON.stringify(materialized(s1));

    await s1.flush();
    const s2 = MissionStore.open(backend);
    assert.equal(JSON.stringify(materialized(s2)), before);
  });

  it("keeps failed tasks immutable and requires explicit valid supersession coverage", () => {
    const s = store();
    const mission = s.createMission({
      title: "immutable failure",
      goal: "preserve audit history",
      user_request: "repair safely",
      repository: ".",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    s.addAcceptanceCriterion(mission.mission_id, "criterion one", undefined, "AC-1");
    const failed = s.createTask({
      task_id: "TSK-original",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "implement criterion one",
      repo_id: "repo-a",
      acceptance_ids: ["AC-1"],
    });
    s.transitionTask(failed.task_id, "READY");
    s.transitionTask(failed.task_id, "RUNNING");
    s.transitionTask(failed.task_id, "FAILED");
    const coverageFingerprint = taskCoverageFingerprint(failed);
    const immutableFailure = s.getTask(failed.task_id)!;
    assert.throws(() => s.transitionTask(failed.task_id, "READY"), /illegal task transition FAILED -> READY/);
    assert.throws(
      () => s.transitionTask(failed.task_id, "FAILED", "system", { status: "READY" } as never),
      /status must be changed through transitionTask/,
    );
    assert.throws(() => s.steerTask(failed.task_id, "change the failed task"), /terminal task.*immutable/);
    assert.deepEqual(s.getTask(failed.task_id), immutableFailure, "every field on the failed task remains unchanged");

    const wrongRepo = s.createTask({
      task_id: "TSK-wrong-repo",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: failed.objective,
      repo_id: "repo-b",
      acceptance_ids: ["AC-1"],
    });
    assert.throws(
      () =>
        s.supersedeTask({
          supersessionId: "SUP-invalid-repo",
          missionId: mission.mission_id,
          failedTaskId: failed.task_id,
          replacementTaskIds: [wrongRepo.task_id],
          repoId: "repo-a",
          acceptanceIds: ["AC-1"],
          coverageFingerprint,
          reason: "wrong repository",
          createdAt: "2026-09-26T11:00:00.000Z",
        }),
      /repository coverage/,
    );
    assert.throws(
      () =>
        s.supersedeTask({
          supersessionId: "SUP-no-replacements",
          missionId: mission.mission_id,
          failedTaskId: failed.task_id,
          replacementTaskIds: [],
          repoId: "repo-a",
          acceptanceIds: ["AC-1"],
          reason: "missing replacement IDs",
          createdAt: "2026-09-26T11:00:00.000Z",
        }),
      /replacement task IDs/,
    );

    const replacement = s.createTask({
      task_id: "TSK-valid-replacement",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: failed.objective,
      repo_id: "repo-a",
      acceptance_ids: ["AC-1"],
      execution_requirements: { coverageFingerprint },
    });
    assert.throws(
      () =>
        s.supersedeTask({
          supersessionId: "SUP-self",
          missionId: mission.mission_id,
          failedTaskId: failed.task_id,
          replacementTaskIds: [failed.task_id],
          repoId: "repo-a",
          acceptanceIds: ["AC-1"],
          reason: "self replacement",
          createdAt: "2026-09-26T11:01:00.000Z",
        }),
      /cannot replace itself/,
    );
    assert.throws(
      () =>
        s.supersedeTask({
          supersessionId: "SUP-duplicate-replacements",
          missionId: mission.mission_id,
          failedTaskId: failed.task_id,
          replacementTaskIds: [replacement.task_id, replacement.task_id],
          repoId: "repo-a",
          acceptanceIds: ["AC-1"],
          reason: "duplicate replacement IDs",
          createdAt: "2026-09-26T11:02:00.000Z",
        }),
      /unique replacement task IDs/,
    );

    s.supersedeTask({
      supersessionId: "SUP-shared-id",
      missionId: mission.mission_id,
      failedTaskId: failed.task_id,
      replacementTaskIds: [replacement.task_id],
      repoId: "repo-a",
      acceptanceIds: ["AC-1"],
      coverageFingerprint,
      reason: "valid lineage",
      createdAt: "2026-09-26T11:03:00.000Z",
    });
    const secondFailed = s.createTask({
      task_id: "TSK-second-failed",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "second objective",
      repo_id: "repo-a",
      acceptance_ids: ["AC-1"],
    });
    s.transitionTask(secondFailed.task_id, "READY");
    s.transitionTask(secondFailed.task_id, "RUNNING");
    s.transitionTask(secondFailed.task_id, "FAILED");
    assert.throws(
      () =>
        s.supersedeTask({
          supersessionId: "SUP-shared-id",
          missionId: mission.mission_id,
          failedTaskId: secondFailed.task_id,
          replacementTaskIds: [replacement.task_id],
          repoId: "repo-a",
          acceptanceIds: ["AC-1"],
          reason: "overwrite existing lineage",
          createdAt: "2026-09-26T11:04:00.000Z",
        }),
      /duplicate supersession ID/,
    );
    assert.equal(s.getTaskSupersession("SUP-shared-id")?.failedTaskId, failed.task_id);
    assert.deepEqual(s.getTask(failed.task_id), immutableFailure, "supersession records never rewrite failed history");
  });

  it("reports the recovery deadline for the current explicit resumption generation", () => {
    const s = store();
    const mission = s.createMission({
      title: "resumed recovery",
      goal: "report the truthful recovery window",
      user_request: "resume recovery",
      repository: ".",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    s.classifyFailure({
      classificationId: "FCL-resume-deadline",
      missionId: mission.mission_id,
      taskId: null,
      executionId: null,
      category: "PROVIDER_TRANSIENT",
      evidenceRefs: [],
      fingerprint: "resume-deadline",
      summary: "provider unavailable",
      classifiedAt: "2026-09-27T00:00:00.000Z",
    });
    const recovery = (recoveryId: string, deadline: string): RecoveryDecision => ({
      recoveryId,
      missionId: mission.mission_id,
      classificationId: "FCL-resume-deadline",
      action: "PROBE_AND_BACKOFF",
      expectedMaterialChange: "provider probe succeeds",
      attempt: 1,
      maxAttempts: 2,
      deadline,
      nextActionAt: "2026-09-27T00:00:00.000Z",
      status: "planned",
      decidedAt: "2026-09-27T00:00:00.000Z",
      failureFingerprint: "resume-deadline",
    });
    s.planRecovery(recovery("RCV-before-resume", "2026-09-27T00:01:00.000Z"));
    s.stopMission(mission.mission_id, {
      reason: "first recovery stopped",
      preservedWork: [],
      attemptedRecoveries: ["RCV-before-resume"],
      resumeCondition: "provider health returns",
    });
    s.resumeMission(mission.mission_id, "provider health returned");
    s.planRecovery(recovery("RCV-after-resume", "2026-09-27T00:05:00.000Z"));

    const stop = s.stopMission(mission.mission_id, {
      reason: "resumed recovery stopped",
      preservedWork: [],
      attemptedRecoveries: ["RCV-after-resume"],
      resumeCondition: "provider health returns again",
    });

    assert.equal(stop.resumptionGeneration, 1);
    assert.equal(stop.recoveryDeadline, "2026-09-27T00:05:00.000Z");
  });

  it("rejects BLOCKED to EXECUTING bypass and atomically consumes durable repair authority", async () => {
    const backend = JsonlEventStore.inMemory();
    const s = MissionStore.open(backend);
    const mission = s.createMission({
      title: "blocked mission",
      goal: "repair durably",
      user_request: "resume after repair",
      repository: ".",
      base_ref: "main",
      risk_profile: "high",
      workflow_class: "engineering_review",
    });
    s.transitionMission(mission.mission_id, "CLASSIFYING");
    s.transitionMission(mission.mission_id, "BLOCKED");
    assert.throws(
      () => s.transitionMission(mission.mission_id, "EXECUTING"),
      /illegal mission transition BLOCKED -> EXECUTING/,
    );
    assert.throws(
      () => s.updateMission(mission.mission_id, { status: "EXECUTING" } as never),
      /status must be changed through transitionMission/,
    );
    assert.throws(
      () => s.transitionMission(mission.mission_id, "REPAIRING"),
      /requires a durable repair recovery decision/,
    );

    s.classifyFailure({
      classificationId: "FCL-blocked",
      missionId: mission.mission_id,
      taskId: null,
      executionId: null,
      category: "IMPLEMENTATION_DEFECT",
      evidenceRefs: [],
      fingerprint: "blocked:implementation-defect",
      summary: "the implementation requires repair",
      classifiedAt: "2026-09-26T11:19:00.000Z",
    });
    s.planRecovery({
      recoveryId: "RCV-repair",
      missionId: mission.mission_id,
      classificationId: "FCL-blocked",
      action: "REPAIR_BLOCKED_MISSION",
      expectedMaterialChange: "replace the failed task",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-26T12:00:00.000Z",
      nextActionAt: "2026-09-26T11:30:00.000Z",
      status: "planned",
      decidedAt: "2026-09-26T11:20:00.000Z",
    });
    s.planRecovery({
      recoveryId: "RCV-stale-planned",
      missionId: mission.mission_id,
      classificationId: "FCL-blocked",
      action: "REPAIR_BLOCKED_MISSION",
      expectedMaterialChange: "an alternative repair for the first blocked episode",
      attempt: 1,
      maxAttempts: 2,
      deadline: "2026-09-26T12:00:00.000Z",
      nextActionAt: "2026-09-26T11:30:00.000Z",
      status: "planned",
      decidedAt: "2026-09-26T11:20:30.000Z",
    });
    assert.throws(
      () => s.transitionRecovery("RCV-repair", "started"),
      /blocked-mission repair must start atomically through transitionMission/,
    );
    assert.equal(s.getRecoveryDecision("RCV-repair")?.status, "planned");
    assert.equal(s.getMission(mission.mission_id)?.status, "BLOCKED");

    const firstBlockedEpisode = s.getMission(mission.mission_id)!;
    s.transitionMission(mission.mission_id, "REPAIRING", "system", { recoveryDecisionId: "RCV-repair" });
    assert.equal(s.getRecoveryDecision("RCV-repair")?.status, "started");
    assert.equal(s.transitionMission(mission.mission_id, "EXECUTING").status, "EXECUTING");
    s.transitionMission(mission.mission_id, "BLOCKED");
    const secondBlockedEpisode = s.getMission(mission.mission_id)!;
    for (const forbiddenPatch of [
      { blocked_at: firstBlockedEpisode.blocked_at },
      { blocked_episode_id: firstBlockedEpisode.blocked_episode_id },
      { mission_id: "MSN-rewritten" },
      { title: "rewritten title" },
      { goal: "rewritten goal" },
      { user_request: "rewritten request" },
      { repository: "/different/repository" },
      { base_ref: "different-ref" },
      { risk_profile: "low" },
      { workflow_class: "conversation" },
      { task_ids: [] },
      { created_at: "2000-01-01T00:00:00.000Z" },
      { updated_at: "2000-01-01T00:00:00.000Z" },
      { completed_at: "2000-01-01T00:00:00.000Z" },
    ]) {
      assert.throws(
        () => s.updateMission(mission.mission_id, forbiddenPatch as never),
        /unsupported mission update field/,
      );
    }
    assert.deepEqual(s.getMission(mission.mission_id), secondBlockedEpisode);
    assert.throws(
      () =>
        s.transitionMission(mission.mission_id, "REPAIRING", "system", {
          recoveryDecisionId: "RCV-stale-planned",
        }),
      /does not belong to the current blocked episode/,
    );
    assert.equal(s.getRecoveryDecision("RCV-stale-planned")?.status, "planned");

    s.transitionRecovery("RCV-repair", "exhausted");
    assert.throws(
      () => s.transitionRecovery("RCV-repair", "started"),
      /illegal recovery transition exhausted -> started/,
    );

    await s.flush();
    const repairStart = backend.all().find((event) => event.type === "recovery.started");
    assert.equal((repairStart?.payload.mission_patch as { status?: string } | undefined)?.status, "REPAIRING");
    assert.equal(
      backend
        .all()
        .filter((event) => event.type === "mission.updated")
        .some((event) => (event.payload.patch as { status?: string } | undefined)?.status === "REPAIRING"),
      false,
      "repair authority consumption and BLOCKED -> REPAIRING persist in one event",
    );
    const reopened = MissionStore.open(backend);
    assert.equal(reopened.getMission(mission.mission_id)?.status, "BLOCKED");
    assert.equal(reopened.getRecoveryDecision("RCV-repair")?.status, "exhausted");
  });
});
