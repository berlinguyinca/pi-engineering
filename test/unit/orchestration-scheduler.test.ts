import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { taskCoverageFingerprint } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership, type OwnershipIdentity } from "../../src/orchestration/ownership.ts";
import { MissionScheduler, classifyFailure, domainsOverlap } from "../../src/orchestration/scheduler.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { GatewayResilienceConfig } from "../../src/resilience/config.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const cancellationResilience: GatewayResilienceConfig = {
  retry_window_ms: 60_000,
  probe_interval_ms: 1_000,
  request_timeout_ms: 120_000,
  connect_timeout_ms: 10_000,
  jitter_ms: 0,
  circuit_breaker_threshold: 99,
  retry_transient_errors: true,
  preserve_mission_on_exhaustion: true,
  auto_resume_on_recovery: true,
};

function transientInfrastructureOutcome() {
  return {
    executionId: "e",
    exitStatus: "failed" as const,
    summary: "gateway unavailable",
    artifactRefs: [],
    usage: {},
    error: "transient:server_unavailable",
  };
}

/** Deterministic overlap barrier (see dag-parallel/blackhole tests). */
function parallelBarrier(needed: number, timeoutMs = 5000): { arrived: () => Promise<void> } {
  let count = 0;
  let release: () => void;
  let settled = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      release();
    }
  }, timeoutMs);
  return {
    async arrived() {
      count++;
      if (count >= needed && !settled) {
        settled = true;
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

function makeBroker(store: MissionStore, backends: BrokerBackends) {
  return new ExecutionBroker({ store, backends });
}

function createExecutingMission(store: MissionStore) {
  const mission = store.createMission({
    title: "concurrency limits",
    goal: "concurrency limits",
    user_request: "concurrency limits",
    repository: ".",
    base_ref: "",
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.transitionMission(mission.mission_id, "CLASSIFYING");
  store.transitionMission(mission.mission_id, "PLANNING");
  store.transitionMission(mission.mission_id, "READY");
  store.transitionMission(mission.mission_id, "EXECUTING");
  return mission;
}

function delayedConcurrencyTracker(delayMs = 25) {
  let active = 0;
  let peak = 0;
  return {
    async run() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active--;
      return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
    },
    peak: () => peak,
  };
}

describe("MissionScheduler (spec 02)", () => {
  it("releases scheduler capacity after the hard timeout of an uncooperative backend", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const stuck = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "stuck",
      execution_budget_ms: 25,
      max_attempts: 1,
    });
    const next = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "next",
      execution_budget_ms: 1_000,
      max_attempts: 1,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const broker = new ExecutionBroker({
      store,
      cancellationAckTimeoutMs: 20,
      backends: {
        agent: {
          runAgent: async ({ objective }) => {
            starts.push(objective);
            if (objective === "stuck") await blocked;
            return { executionId: objective, exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 1, maxAgents: 1, maxPerRole: 1 },
    });

    const running = scheduler.runMission(mission.mission_id);
    const observed = await Promise.race([
      running.then(() => "settled" as const),
      new Promise<"observation_timeout">((resolve) => setTimeout(() => resolve("observation_timeout"), 150)),
    ]);
    release();
    await running;

    assert.equal(observed, "settled", "the timed-out slot must be available to the next task");
    assert.deepEqual(starts, ["stuck", "next"]);
    assert.equal(store.getTask(stuck.task_id)?.status, "FAILED");
    assert.equal(store.getTask(next.task_id)?.status, "SUCCEEDED");
  });

  it("attaches checkpoint identity and checkpoints progress without passing acceptance", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    store.bindWorkspaceManifest({
      manifestId: "WM-checkpoint",
      missionId: mission.mission_id,
      generation: 1,
      authorizedRoots: [{ canonicalPath: "/repo", source: "existing_manifest", access: "read" }],
      repositories: [
        {
          repoId: "repo-1",
          canonicalRoot: "/repo",
          baseRef: "main",
          baseSha: "base-1",
          writableDomains: ["**"],
        },
      ],
      dependencyEdges: [],
      hash: "manifest-checkpoint",
      createdAt: "2026-09-26T10:00:00.000Z",
    });
    store.addAcceptanceCriterion(mission.mission_id, "the implementation is validated", undefined, "AC-1");
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "bounded implementation",
      repo_id: "repo-1",
      acceptance_ids: ["AC-1"],
      deliverables: ["implementation", "tests"],
      execution_budget_ms: 10_000,
      checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 1_000 },
      required_output_artifacts: ["handoff"],
      mutates_repo: false,
      isolation: "none",
      mission_generation: 3,
      fencing_token: 5,
    });
    const checkpoints = new CheckpointManager({ store });
    const broker = new ExecutionBroker({
      store,
      checkpoints,
      resolveRepository: async (repoId) => ({ repoId, root: "/repo", git: {} as never }),
      backends: {
        agent: {
          runAgent: async ({ onActivity }) => {
            onActivity?.({ kind: "state", summary: "implementation ready", meaningfulProgress: true });
            return {
              executionId: "worker",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: ["artifact://handoff/sha256:abc"],
              usage: {},
            };
          },
        },
      },
    });

    await new MissionScheduler({ store, broker }).runMission(mission.mission_id);

    const execution = store.listExecutions(mission.mission_id, task.task_id)[0]!;
    assert.match(execution.checkpoint_id ?? "", /^TCP-/);
    const checkpoint = store.getTaskCheckpoint(execution.checkpoint_id!);
    assert.ok(checkpoint);
    assert.deepEqual(checkpoint.completedDeliverables, ["implementation", "tests"]);
    assert.deepEqual(checkpoint.artifactRefs, ["artifact://handoff/sha256:abc"]);
    assert.equal(checkpoint.artifactHashes.length, 1);
    assert.equal(checkpoint.missionGeneration, task.mission_generation);
    assert.equal(checkpoint.candidateGeneration, task.candidate_generation);
    assert.equal(checkpoint.fencingToken, task.fencing_token);
    assert.equal(store.getMission(mission.mission_id)?.acceptance_criteria[0]?.status, "pending");
  });

  it("rejects forged checkpoint recovery fields even when their candidate exists in Git", async () => {
    const fixture = await makeFixtureRepo();
    const git = (await GitRepo.open(fixture.root))!;
    const baseSha = await git.headCommit();
    await writeFile(`${fixture.root}/recovered.txt`, "exact dirty bytes\n", "utf8");
    await git.commitAll(fixture.root, "preserve formerly dirty checkpoint bytes");
    const candidateSha = await git.headCommit();
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "finish the checkpoint remainder",
      mutates_repo: true,
      isolation: "worktree",
      deliverables: ["remaining"],
      execution_requirements: {
        recoveryFromCheckpoint: "CHK-dirty",
        recoveryCandidateSha: candidateSha,
        recoveryBranch: "pi-eng-orch-original",
        recoveryWorktree: "/preserved/original",
        recoveryCommittedChanges: ["recovered.txt"],
        recoveryUncommittedChanges: ["recovered.txt"],
        recoveryCompletedDeliverables: ["completed"],
        recoveryArtifactRefs: ["artifact://checkpoint/one"],
        recoveryArtifactHashes: ["sha256:checkpoint-one"],
      },
    });
    let observedRecovery: Record<string, unknown> | undefined;
    const scheduler = new MissionScheduler({
      store,
      broker: new ExecutionBroker({
        store,
        git,
        baseRef: baseSha,
        backends: {
          agent: {
            runAgent: async (input) => {
              observedRecovery = (input as typeof input & { recovery?: Record<string, unknown> }).recovery;
              assert.equal(await readFile(`${input.worktree}/recovered.txt`, "utf8"), "exact dirty bytes\n");
              return {
                executionId: "replacement",
                exitStatus: "succeeded",
                summary: "remaining work completed",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      }),
    });
    try {
      await scheduler.runMission(mission.mission_id);

      assert.equal(store.getTask(task.task_id)?.status, "FAILED");
      assert.equal(observedRecovery, undefined);
      assert.ok(
        store
          .listFailureClassifications(mission.mission_id)
          .some((classification) => /caller fields are forbidden/i.test(classification.summary)),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed before dispatch when formerly dirty checkpoint bytes are not reproducible", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "do not dispatch an incomplete checkpoint",
      execution_requirements: {
        recoveryFromCheckpoint: "CHK-unreproducible",
        recoveryCandidateSha: "candidate-sha",
        recoveryBranch: "pi-eng-orch-original",
        recoveryWorktree: "/preserved/original",
        recoveryCommittedChanges: [],
        recoveryUncommittedChanges: ["lost-dirty.txt"],
        recoveryCompletedDeliverables: [],
        recoveryArtifactRefs: [],
        recoveryArtifactHashes: [],
      },
      max_attempts: 1,
      failure_policy: "block",
    });
    let dispatches = 0;
    const scheduler = new MissionScheduler({
      store,
      broker: makeBroker(store, {
        agent: {
          runAgent: async () => {
            dispatches++;
            return { executionId: "unsafe", exitStatus: "succeeded", summary: "unsafe", artifactRefs: [], usage: {} };
          },
        },
      }),
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(dispatches, 0);
    assert.equal(store.getTask(task.task_id)?.status, "FAILED");
    assert.match(store.getTask(task.task_id)?.failure_reason ?? "", /caller fields are forbidden/i);
  });

  it("rejects unsafe checkpoint paths and unmatched artifact hashes before execution creation", async () => {
    const cases = [
      {
        name: "unsafe committed path",
        overrides: { recoveryCommittedChanges: ["../escape.txt"] },
        expected: /checkpoint recovery committed paths are unsafe/i,
      },
      {
        name: "unmatched artifact hash",
        overrides: { recoveryArtifactHashes: [] },
        expected: /artifact identities do not match/i,
      },
      {
        name: "relative source worktree",
        overrides: { recoveryWorktree: "relative/preserved" },
        expected: /source worktree must be absolute/i,
      },
    ];
    for (const testCase of cases) {
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = createExecutingMission(store);
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: testCase.name,
      });
      const broker = makeBroker(store, {
        agent: {
          runAgent: async () => ({
            executionId: "unsafe",
            exitStatus: "succeeded",
            summary: "unsafe",
            artifactRefs: [],
            usage: {},
          }),
        },
      });
      await assert.rejects(
        broker.execute({
          taskId: task.task_id,
          missionId: mission.mission_id,
          kind: "agent",
          objective: testCase.name,
          modelRequirements: {
            recoveryFromCheckpoint: "CHK-unsafe",
            recoveryCandidateSha: "candidate-sha",
            recoveryBranch: "pi-eng-orch-original",
            recoveryWorktree: "/preserved/original",
            recoveryCommittedChanges: ["safe.txt"],
            recoveryUncommittedChanges: [],
            recoveryCompletedDeliverables: [],
            recoveryArtifactRefs: ["artifact://checkpoint/one"],
            recoveryArtifactHashes: ["sha256:checkpoint-one"],
            ...testCase.overrides,
          },
        }),
        /caller fields are forbidden/i,
      );
      assert.equal(store.listExecutions(mission.mission_id).length, 0);
    }
  });

  it("holds fenced mission and repository authority for the entire mutating dispatch", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const ownership = new MissionOwnership(store, {
      ownerId: "scheduler-owner",
      leaseMs: 30,
      heartbeatMs: 5,
    });
    let identity = await ownership.acquire(mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "long mutation",
      mutates_repo: true,
      isolation: "none",
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          assert.equal(store.getRepositoryLeaseByRepoId("repo-1")?.missionId, mission.mission_id);
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      acquireAuthority: async (scheduled) => {
        const held = await ownership.maintain(identity, scheduled.mutates_repo ? "repo-1" : undefined);
        return {
          get missionIdentity() {
            return held.missionIdentity;
          },
          get repositoryIdentity() {
            return held.repositoryIdentity;
          },
          assertAuthoritative: () => held.assertAuthoritative(),
          onInvalidated: (listener) => held.onInvalidated(listener),
          close: async () => {
            const error = await held.close();
            identity = held.missionIdentity;
            return error;
          },
        };
      },
    });

    await scheduler.runMission(mission.mission_id);

    const settled = store.getTask(task.task_id)!;
    const execution = store.listExecutions(mission.mission_id, task.task_id)[0]!;
    assert.equal(settled.status, "SUCCEEDED", settled.failure_reason);
    assert.ok((settled.mission_generation ?? 0) > 0);
    assert.equal(execution.mission_generation, settled.mission_generation);
    assert.equal(execution.fencing_token, settled.fencing_token);
    assert.equal(store.getRepositoryLeaseByRepoId("repo-1"), undefined);
  });

  it("preserves task success and durably reports a repository release failure", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = createExecutingMission(store);
    class FailingRepositoryReleaseOwnership extends MissionOwnership {
      override async release(identity: OwnershipIdentity): Promise<void> {
        if ("repoId" in identity) throw new Error("injected repository release failure");
        await super.release(identity);
      }
    }
    const ownership = new FailingRepositoryReleaseOwnership(store, { ownerId: "controller-release-failure" });
    const missionIdentity = await ownership.acquire(mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "successful mutation with failed release",
      mutates_repo: true,
      isolation: "none",
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      acquireAuthority: async () => ownership.maintain(missionIdentity, "repo-release-failure"),
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(store.getTask(task.task_id)?.status, "SUCCEEDED");
    await store.flush();
    const finding = MissionStore.open(backend)
      .listFindings(mission.mission_id)
      .find((candidate) => candidate.category === "ownership_release");
    assert.ok(finding, "repository release failure must be durable and operator-visible");
    assert.equal(finding.task_id, task.task_id);
    assert.match(finding.summary, /repository ownership release failed/i);
    assert.match(finding.evidence ?? "", /repo-release-failure/);
    assert.match(finding.evidence ?? "", /fencingToken.*1/);
    assert.match(finding.evidence ?? "", /injected repository release failure/);
  });

  it("cancels and rejects a late worker result after mission takeover", async () => {
    const eventStore = JsonlEventStore.inMemory();
    const store = MissionStore.open(eventStore);
    const mission = createExecutingMission(store);
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const firstOwner = new MissionOwnership(store, {
      ownerId: "controller-a",
      leaseMs: 100,
      heartbeatMs: 10,
      now: () => now,
    });
    let identity = await firstOwner.acquire(mission.mission_id);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "late mutation",
      mutates_repo: true,
      isolation: "none",
    });
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async ({ signal }) => {
          started();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { executionId: "late", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
        },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      acquireAuthority: async () => {
        const held = await firstOwner.maintain(identity, "repo-stale");
        return {
          get missionIdentity() {
            return held.missionIdentity;
          },
          get repositoryIdentity() {
            return held.repositoryIdentity;
          },
          assertAuthoritative: () => held.assertAuthoritative(),
          onInvalidated: (listener) => held.onInvalidated(listener),
          close: async () => {
            const error = await held.close();
            identity = held.missionIdentity;
            return error;
          },
        };
      },
    });
    const running = scheduler.runMission(mission.mission_id);
    await dispatched;

    now += 101;
    const secondOwner = new MissionOwnership(store, {
      ownerId: "controller-b",
      leaseMs: 100,
      heartbeatMs: 10,
      now: () => now,
    });
    const takeover = await secondOwner.acquire(mission.mission_id);
    await running;

    assert.equal(takeover.generation, 2);
    assert.notEqual(store.getTask(task.task_id)?.status, "SUCCEEDED");
    const execution = store.listExecutions(mission.mission_id, task.task_id)[0]!;
    assert.equal(execution.status, "CANCELED");
    assert.equal(execution.exit_status, "canceled", "late evidence must not overwrite the terminal cancellation");
    assert.ok(eventStore.all().some((event) => event.type === "execution.late_result_rejected"));
  });

  it("serializes mutating dispatches from separate controllers by repository id", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const firstMission = createExecutingMission(store);
    const secondMission = createExecutingMission(store);
    const firstOwner = new MissionOwnership(store, { ownerId: "runtime-a", leaseMs: 1_000, heartbeatMs: 50 });
    const secondOwner = new MissionOwnership(store, { ownerId: "runtime-b", leaseMs: 1_000, heartbeatMs: 50 });
    let firstIdentity = await firstOwner.acquire(firstMission.mission_id);
    let secondIdentity = await secondOwner.acquire(secondMission.mission_id);
    const firstTask = store.createTask({
      mission_id: firstMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "first mutation",
      mutates_repo: true,
      isolation: "none",
    });
    const secondTask = store.createTask({
      mission_id: secondMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "second mutation",
      mutates_repo: true,
      isolation: "none",
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDispatched = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondCalls = 0;
    const schedulerFor = (
      missionOwner: MissionOwnership,
      identity: () => typeof firstIdentity,
      update: (next: typeof firstIdentity) => void,
      broker: ExecutionBroker,
    ) =>
      new MissionScheduler({
        store,
        broker,
        acquireAuthority: async () => {
          const held = await missionOwner.maintain(identity(), "repo-shared");
          return {
            get missionIdentity() {
              return held.missionIdentity;
            },
            get repositoryIdentity() {
              return held.repositoryIdentity;
            },
            assertAuthoritative: () => held.assertAuthoritative(),
            onInvalidated: (listener) => held.onInvalidated(listener),
            close: async () => {
              const error = await held.close();
              update(held.missionIdentity);
              return error;
            },
          };
        },
      });
    const firstScheduler = schedulerFor(
      firstOwner,
      () => firstIdentity,
      (next) => {
        firstIdentity = next;
      },
      makeBroker(store, {
        agent: {
          runAgent: async () => {
            firstStarted();
            await firstMayFinish;
            return { executionId: "first", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      }),
    );
    const secondScheduler = schedulerFor(
      secondOwner,
      () => secondIdentity,
      (next) => {
        secondIdentity = next;
      },
      makeBroker(store, {
        agent: {
          runAgent: async () => {
            secondCalls++;
            return { executionId: "second", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
          },
        },
      }),
    );

    const firstRun = firstScheduler.runMission(firstMission.mission_id);
    await firstDispatched;
    await secondScheduler.runMission(secondMission.mission_id);
    assert.equal(secondCalls, 0);
    assert.equal(store.getTask(secondTask.task_id)?.status, "BLOCKED");
    assert.match(store.getTask(secondTask.task_id)?.failure_reason ?? "", /repo-shared.*mission/i);

    releaseFirst();
    await firstRun;
    assert.equal(store.getTask(firstTask.task_id)?.status, "SUCCEEDED");
  });
  it("runs independent tasks concurrently (parallelism)", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    // Backend (src/server) and frontend (src/web) — non-overlapping.
    const a = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "backend",
      write_domains: ["src/server/**"],
      mutates_repo: true,
      isolation: "none",
    });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "frontend",
      write_domains: ["src/web/**"],
      mutates_repo: true,
      isolation: "none",
    });
    let maxConcurrent = 0;
    let concurrent = 0;
    const barrier = parallelBarrier(2);
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Block until both agents are active: deterministic overlap.
          await barrier.arrived();
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(store.getTask(a.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
    assert.ok(maxConcurrent >= 2, `expected concurrent execution, saw ${maxConcurrent}`);
  });

  it("serializes overlapping write domains", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    // Both write src/shared — must NOT run concurrently.
    const a = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "a",
      write_domains: ["src/shared/**"],
      mutates_repo: true,
      isolation: "none",
    });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "b",
      write_domains: ["src/shared/util.ts"],
      mutates_repo: true,
      isolation: "none",
    });
    let maxConcurrent = 0;
    let concurrent = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(maxConcurrent, 1, `overlapping writes must serialize, saw ${maxConcurrent}`);
    assert.equal(store.getTask(a.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(b.task_id)!.status, "SUCCEEDED");
  });

  it("serializes equivalent Windows and POSIX write domains", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = createExecutingMission(store);
    store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer-a",
      objective: "windows domain",
      write_domains: ["src\\api\\**"],
      mutates_repo: true,
      isolation: "none",
    });
    store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer-b",
      objective: "posix domain",
      write_domains: ["src/api/handler.ts"],
      mutates_repo: true,
      isolation: "none",
    });
    const concurrency = delayedConcurrencyTracker(20);
    const scheduler = new MissionScheduler({
      store,
      broker: makeBroker(store, { agent: { runAgent: async () => concurrency.run() } }),
    });

    await scheduler.runMission(m.mission_id);
    assert.equal(concurrency.peak(), 1);
  });

  it("treats bare ** as overlapping every write domain in the same repository", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = createExecutingMission(store);
    for (const [objective, writeDomain] of [
      ["repository-wide", "**"],
      ["bounded", "src/api/**"],
    ] as const) {
      store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: objective,
        objective,
        write_domains: [writeDomain],
        mutates_repo: true,
        isolation: "none",
      });
    }
    const concurrency = delayedConcurrencyTracker(20);
    const scheduler = new MissionScheduler({
      store,
      broker: makeBroker(store, { agent: { runAgent: async () => concurrency.run() } }),
    });

    await scheduler.runMission(m.mission_id);
    assert.equal(concurrency.peak(), 1);
    assert.equal(domainsOverlap(["**"], ["src/api/**"]), true);
  });

  it("respects dependency order", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const order: string[] = [];
    const a = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "scout", objective: "scout" });
    const b = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "impl",
      depends_on: [a.task_id],
    });
    const c = store.createTask({
      mission_id: m.mission_id,
      kind: "review",
      role: "reviewer",
      objective: "review",
      depends_on: [b.task_id],
    });
    const backends: BrokerBackends = {
      agent: {
        runAgent: async ({ role }) => {
          order.push(role);
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
      review: {
        runReview: async () => {
          order.push("reviewer");
          return { executionId: "e", exitStatus: "succeeded", summary: "reviewed", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.deepEqual(order, ["scout", "implementer", "reviewer"]);
    assert.equal(store.getTask(c.task_id)!.status, "SUCCEEDED");
  });

  it("retries transient failures then succeeds", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      max_attempts: 3,
    });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          if (calls === 1) throw new Error("transient 429 rate limited");
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(t.task_id)!.status, "SUCCEEDED");
    assert.equal(store.getTask(t.task_id)!.attempt, 2);
  });

  it("fails a task after exhausting retries", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    store.transitionMission(m.mission_id, "CLASSIFYING");
    store.transitionMission(m.mission_id, "PLANNING");
    store.transitionMission(m.mission_id, "READY");
    store.transitionMission(m.mission_id, "EXECUTING");
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      max_attempts: 2,
    });
    let calls = 0;
    const backends: BrokerBackends = {
      agent: {
        runAgent: async () => {
          calls++;
          throw new Error("transient 429 rate limited");
        },
      },
    };
    const broker = makeBroker(store, backends);
    const scheduler = new MissionScheduler({ store, broker });
    await scheduler.runMission(m.mission_id);
    assert.equal(calls, 2);
    assert.equal(store.getTask(t.task_id)!.status, "FAILED");
  });

  it("cancels active mission executions when the caller aborts", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "long-running work",
    });
    let backendSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const broker = makeBroker(store, {
      agent: {
        runAgent: async ({ signal }) => {
          backendSignal = signal;
          markStarted();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { executionId: "e", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
        },
      },
    });
    const scheduler = new MissionScheduler({ store, broker });
    const controller = new AbortController();
    const running = scheduler.runMission(mission.mission_id, controller.signal);

    await started;
    controller.abort();
    await running;

    assert.equal(backendSignal?.aborted, true, "the active backend must receive cancellation");
    assert.equal(store.getTask(task.task_id)?.status, "CANCELED");
  });

  it("cancels promptly during resilience backoff and releases scheduler capacity", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const firstMission = createExecutingMission(store);
    const firstTask = store.createTask({
      mission_id: firstMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "retrying work",
    });
    let enterBackoff!: () => void;
    const backoffStarted = new Promise<void>((resolve) => {
      enterBackoff = resolve;
    });
    const neverCompletes = new Promise<void>(() => undefined);
    const broker = makeBroker(store, {
      agent: {
        runAgent: async ({ objective }) =>
          objective === "retrying work"
            ? transientInfrastructureOutcome()
            : { executionId: "e2", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} },
      },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 1 },
      resilience: cancellationResilience,
      sleep: async () => {
        enterBackoff();
        await neverCompletes;
      },
    });
    const controller = new AbortController();
    const running = scheduler.runMission(firstMission.mission_id, controller.signal);

    await backoffStarted;
    controller.abort();
    await running;

    assert.equal(store.getTask(firstTask.task_id)?.status, "CANCELED");

    const secondMission = createExecutingMission(store);
    const secondTask = store.createTask({
      mission_id: secondMission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "fresh work",
    });
    await scheduler.runMission(secondMission.mission_id);
    assert.equal(store.getTask(secondTask.task_id)?.status, "SUCCEEDED", "canceled work must release maxActive");
  });

  it("cancels promptly while a recovery probe is pending", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "probe-gated work",
    });
    let probeStarted!: () => void;
    const probing = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const broker = makeBroker(store, {
      agent: { runAgent: async () => transientInfrastructureOutcome() },
    });
    const scheduler = new MissionScheduler({
      store,
      broker,
      resilience: cancellationResilience,
      sleep: async () => undefined,
      probe: {
        probe: async () => {
          probeStarted();
          await new Promise<void>(() => undefined);
          return { healthy: false };
        },
      },
    });
    const controller = new AbortController();
    const running = scheduler.runMission(mission.mission_id, controller.signal);

    await probing;
    controller.abort();
    await running;

    assert.equal(store.getTask(task.task_id)?.status, "CANCELED");
  });

  it("enforces the agent cap when several delayed agents become runnable together", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 3; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: `agent-${i}`,
        objective: `agent ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { agent: { runAgent: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxAgents: 1, maxPerRole: 10 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 1, "no more than maxAgents agent executions may overlap");
  });

  it("enforces the subprocess cap when delayed process tasks become runnable together", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 3; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "process",
        role: `process-${i}`,
        objective: `process ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { process: { runProcess: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxSubprocesses: 1, maxPerRole: 10 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 1, "no more than maxSubprocesses process executions may overlap");
  });

  it("enforces the per-role cap when delayed tasks share a role", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 3; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: `implementation ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { agent: { runAgent: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 10, maxAgents: 10, maxPerRole: 1 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 1, "no more than maxPerRole executions for one role may overlap");
  });

  it("enforces the aggregate cap when delayed tasks become runnable together", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (let i = 0; i < 4; i++) {
      store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: `aggregate-${i}`,
        objective: `aggregate ${i}`,
      });
    }
    const tracker = delayedConcurrencyTracker();
    const broker = makeBroker(store, { agent: { runAgent: tracker.run } });
    const scheduler = new MissionScheduler({
      store,
      broker,
      limits: { maxActive: 2, maxAgents: 10, maxPerRole: 10 },
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(tracker.peak(), 2, "no more than maxActive executions may overlap");
  });
});

describe("write-domain conflict detection", () => {
  it("detects overlapping and disjoint domains", () => {
    assert.ok(domainsOverlap(["src/server/**"], ["src/server/api.ts"]));
    assert.ok(domainsOverlap(["src/shared/"], ["src/shared/util.ts"]));
    assert.ok(!domainsOverlap(["src/server/**"], ["src/web/**"]));
    assert.ok(domainsOverlap(["src/a"], ["src/a/b.ts"]));
  });
});

describe("superseded dependency satisfaction", () => {
  it("runs a downstream task only after every transitive leaf replacement succeeds", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    const failed = store.createTask({
      task_id: "TSK-failed-dependency",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "failed dependency",
      repo_id: "repo-a",
    });
    store.transitionTask(failed.task_id, "READY");
    store.transitionTask(failed.task_id, "RUNNING");
    store.transitionTask(failed.task_id, "FAILED");
    const replacement = store.createTask({
      task_id: "TSK-leaf-replacement",
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "leaf replacement",
      repo_id: "repo-a",
    });
    store.transitionTask(replacement.task_id, "READY");
    store.transitionTask(replacement.task_id, "RUNNING");
    store.transitionTask(replacement.task_id, "SUCCEEDED");
    store.supersedeTask({
      supersessionId: "SUP-dependency",
      missionId: mission.mission_id,
      failedTaskId: failed.task_id,
      replacementTaskIds: [replacement.task_id],
      repoId: "repo-a",
      acceptanceIds: [],
      coverageFingerprint: taskCoverageFingerprint(failed),
      reason: "replacement",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const downstream = store.createTask({
      task_id: "TSK-downstream",
      mission_id: mission.mission_id,
      kind: "process",
      role: "builder",
      objective: "downstream",
      depends_on: [failed.task_id],
    });
    const scheduler = new MissionScheduler({
      store,
      broker: makeBroker(store, {
        process: {
          runProcess: async () => ({
            executionId: "downstream",
            exitStatus: "succeeded",
            summary: "done",
            artifactRefs: [],
            usage: {},
          }),
        },
      }),
    });

    await scheduler.runMission(mission.mission_id);

    assert.equal(store.getTask(downstream.task_id)?.status, "SUCCEEDED");
  });
});

describe("failure classifier (spec 02)", () => {
  it("classifies transient vs merge vs test failures", () => {
    const task = { failure_policy: "retry" } as never;
    assert.equal(classifyFailure(new Error("429 rate limit"), task).action, "retry");
    assert.equal(classifyFailure(new Error("merge conflict in src/a.ts"), task).action, "repair");
    assert.equal(classifyFailure(new Error("test failed: expected 1 got 2"), task).action, "repair");
    assert.equal(classifyFailure(new Error("context overflow max tokens"), task).action, "retry");
  });

  it("classifies every terminal gate failure before task failure is durable", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = createExecutingMission(store);
    for (const kind of ["validation", "review", "integration"] as const) {
      store.createTask({
        task_id: `TSK-terminal-${kind}`,
        mission_id: mission.mission_id,
        kind,
        role: kind,
        objective: `${kind} terminal failure`,
        max_attempts: 1,
        failure_policy: "block",
      });
    }
    const failed = async () => ({
      executionId: "terminal",
      exitStatus: "failed",
      summary: "terminal gate failure",
      artifactRefs: [],
      usage: {},
    });
    const scheduler = new MissionScheduler({
      store,
      broker: makeBroker(store, {
        validation: { runValidation: failed },
        review: { runReview: failed },
        integration: { runIntegration: failed },
      }),
    });

    await scheduler.runMission(mission.mission_id);

    const classifications = store.listFailureClassifications(mission.mission_id);
    assert.deepEqual(
      classifications.map((classification) => classification.category).sort(),
      ["MERGE_CONFLICT", "REVIEW_FAILED", "VALIDATION_FAILED"],
      JSON.stringify(classifications),
    );
    const events = backend.all().filter((event) => event.run_id === mission.mission_id);
    for (const kind of ["validation", "review", "integration"] as const) {
      const taskId = `TSK-terminal-${kind}`;
      assert.ok(
        events.findIndex(
          (event) =>
            event.type === "failure.classified" &&
            (event.payload.classification as { taskId?: string } | undefined)?.taskId === taskId,
        ) <
          events.findIndex(
            (event) => event.type === "task.failed" && (event.payload.task_id as string | undefined) === taskId,
          ),
      );
    }
  });

  it("preserves permanent provider classification for validation, review, and integration failures", async () => {
    const fixture = await makeFixtureRepo();
    const git = (await GitRepo.open(fixture.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = createExecutingMission(store);
    for (const kind of ["validation", "review", "integration"] as const) {
      store.createTask({
        task_id: `TSK-provider-${kind}`,
        mission_id: mission.mission_id,
        kind,
        role: kind,
        objective: `${kind} with permanent provider refusal`,
        max_attempts: 1,
        failure_policy: "block",
      });
    }
    const refused = async () => ({
      executionId: "provider-refusal",
      exitStatus: "failed",
      summary: "provider rejected the request",
      error: "provider invalid api key",
      artifactRefs: [],
      usage: {},
    });
    const scheduler = new MissionScheduler({
      store,
      broker: new ExecutionBroker({
        store,
        git,
        baseRef: await git.headCommit(),
        backends: {
          validation: { runValidation: refused },
          review: { runReview: refused },
          integration: { runIntegration: refused },
        },
      }),
    });
    try {
      await scheduler.runMission(mission.mission_id);

      assert.deepEqual(
        store
          .listFailureClassifications(mission.mission_id)
          .map((classification) => classification.category)
          .sort(),
        ["PROVIDER_PERMANENT", "PROVIDER_PERMANENT", "PROVIDER_PERMANENT"],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
