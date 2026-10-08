import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, ExecutionBroker, workerTimeoutMs } from "../../src/orchestration/broker.ts";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { Integrator } from "../../src/orchestration/integrator.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import type { EventStoreBackend, StoredEvent } from "../../src/platform/eventstore/backend.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

class LateAppendFailureBackend implements EventStoreBackend {
  readonly inner = JsonlEventStore.inMemory();
  fail = false;

  append(event: StoredEvent): Promise<StoredEvent> {
    if (this.fail) return Promise.reject(new Error("late evidence persistence unavailable"));
    return this.inner.append(event);
  }

  appendConditionally(
    event: StoredEvent,
    condition: () => boolean,
    onCommit?: () => void,
  ): Promise<StoredEvent | undefined> {
    if (this.fail) return Promise.reject(new Error("late evidence persistence unavailable"));
    return this.inner.appendConditionally(event, condition, onCommit);
  }

  appendAll(events: StoredEvent[]): Promise<void> {
    if (this.fail) return Promise.reject(new Error("late evidence persistence unavailable"));
    return this.inner.appendAll(events);
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

async function cancellationCheckpointFixture(
  runAgent: NonNullable<BrokerBackends["agent"]>["runAgent"],
  cancellationAckTimeoutMs = 5_000,
  checkpoints?: CheckpointManager,
) {
  const fx = await makeFixtureRepo();
  const git = await GitRepo.open(fx.root);
  assert.ok(git);
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "cancellation quiescence",
    goal: "cancellation quiescence",
    user_request: "cancellation quiescence",
    repository: fx.root,
    base_ref: await git.headCommit(),
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.bindWorkspaceManifest({
    manifestId: "WM-cancellation-quiescence",
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
    repositories: [
      {
        repoId: "repo-cancellation-quiescence",
        canonicalRoot: fx.root,
        baseRef: "main",
        baseSha: mission.base_ref,
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-cancellation-quiescence",
    createdAt: "2026-09-27T10:00:00.000Z",
  });
  const task = store.createTask({
    mission_id: mission.mission_id,
    repo_id: "repo-cancellation-quiescence",
    kind: "agent",
    role: "implementer",
    objective: "cancel safely",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
    deliverables: ["implementation"],
    execution_budget_ms: 10_000,
    checkpoint_policy: { activity_milestone: 10, before_deadline_ms: 1_000 },
  });
  const broker = new ExecutionBroker({
    store,
    git,
    checkpoints: checkpoints ?? new CheckpointManager({ store }),
    cancellationAckTimeoutMs,
    resolveRepository: async (repoId) => ({ repoId, root: fx.root, git }),
    backends: { agent: { runAgent } },
  });
  const handle = await broker.execute({
    taskId: task.task_id,
    missionId: mission.mission_id,
    repoId: task.repo_id!,
    kind: "agent",
    role: "implementer",
    objective: task.objective,
    mutatesRepo: true,
    writeDomains: task.write_domains,
    isolation: "worktree",
    deliverables: task.deliverables,
    executionBudgetMs: task.execution_budget_ms,
    checkpointPolicy: task.checkpoint_policy,
  });
  return { fx, git, store, mission, task, broker, handle };
}

function setup(backends: BrokerBackends) {
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
  const t = store.createTask({
    mission_id: m.mission_id,
    kind: "agent",
    role: "implementer",
    objective: "x",
  });
  store.transitionTask(t.task_id, "READY");
  return { store, m, t, broker: new ExecutionBroker({ store, backends }) };
}

async function assertCrossBoundaryRenameRejected(commitRename: boolean): Promise<void> {
  const fx = await makeFixtureRepo();
  try {
    await writeFile(join(fx.root, "outside.ts"), "export const outside = true;\n", "utf8");
    await exec("git", ["-C", fx.root, "add", "outside.ts"]);
    await exec("git", ["-C", fx.root, "commit", "-q", "-m", "add outside file"]);
    const git = await GitRepo.open(fx.root);
    assert.ok(git);
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "rename confinement",
      goal: "rename confinement",
      user_request: "rename confinement",
      repository: fx.root,
      base_ref: await git.headCommit(),
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-target",
      kind: "agent",
      role: "implementer",
      objective: "rename into authorized scope",
      mutates_repo: true,
      isolation: "worktree",
      write_domains: ["src/**"],
    });
    store.transitionTask(task.task_id, "READY");
    const integrator = new Integrator(git);
    const broker = new ExecutionBroker({
      store,
      git,
      baseRef: mission.base_ref,
      resolveRepository: async (repoId) => ({ repoId, root: fx.root, git }),
      backends: {
        agent: {
          runAgent: async ({ worktree }) => {
            assert.ok(worktree);
            await exec("git", ["-C", worktree, "mv", "outside.ts", "src/inside.ts"]);
            if (commitRename) await exec("git", ["-C", worktree, "commit", "-q", "-m", "cross-boundary rename"]);
            return {
              executionId: "worker",
              exitStatus: "succeeded",
              summary: "renamed",
              artifactRefs: [],
              usage: {},
            };
          },
        },
        integration: {
          runIntegration: (input) =>
            integrator.integrate({
              objective: input.objective,
              baseCommit: mission.base_ref,
              handoffs: input.handoffs,
              signal: input.signal,
            }),
        },
      },
    });

    const worker = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      repoId: "repo-target",
      kind: "agent",
      role: "implementer",
      objective: task.objective,
      mutatesRepo: true,
      isolation: "worktree",
      writeDomains: ["src/**"],
    });
    const outcome = await worker.result();
    assert.equal(outcome.exitStatus, "failed");
    assert.match(outcome.summary, /WORKSPACE_SCOPE_MISMATCH/);

    const integrationTask = store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-target",
      kind: "integration",
      role: "integrator",
      objective: "must not land escaped rename",
      mutates_repo: true,
      isolation: "none",
      write_domains: ["src/**"],
    });
    store.transitionTask(integrationTask.task_id, "READY");
    const integration = await broker.execute({
      taskId: integrationTask.task_id,
      missionId: mission.mission_id,
      repoId: "repo-target",
      kind: "integration",
      role: "integrator",
      objective: integrationTask.objective,
      mutatesRepo: true,
      isolation: "none",
      writeDomains: ["src/**"],
    });
    await integration.result();

    await access(join(fx.root, "outside.ts"));
    await assert.rejects(access(join(fx.root, "src", "inside.ts")));
    assert.ok(
      store
        .listFailureClassifications(mission.mission_id)
        .some((classification) => classification.category === "WORKSPACE_SCOPE_MISMATCH"),
    );
  } finally {
    await fx.cleanup();
  }
}

describe("ExecutionBroker (spec 03)", () => {
  it("publishes no gate evidence when the mission resumes during diff capture", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const baseSha = await git.headCommit();
      const mission = store.createMission({
        title: "gate evidence resumption race",
        goal: "gate evidence resumption race",
        user_request: "gate evidence resumption race",
        repository: fx.root,
        base_ref: baseSha,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-gate-race",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-gate-race",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha,
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-gate-race",
        createdAt: "2026-09-27T00:00:00.000Z",
      });
      const ownership = new MissionOwnership(store, {
        ownerId: "gate-race-controller",
        leaseMs: 60_000,
      });
      const missionIdentity = await ownership.acquire(mission.mission_id, {
        resumptionGeneration: 0,
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "validation",
        role: "validator",
        objective: "validate the current candidate",
        repo_id: "repo-gate-race",
      });
      store.transitionTask(task.task_id, "READY");
      const authority = await ownership.maintain(missionIdentity, "repo-gate-race");
      const originalCaptureDiff = git.captureDiff.bind(git);
      let resumed = false;
      git.captureDiff = async (...args) => {
        if (!resumed) {
          resumed = true;
          store.resumeMission(mission.mission_id, "operator resumed during evidence capture");
        }
        return originalCaptureDiff(...args);
      };
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-gate-race",
          root: fx.root,
          git,
        }),
        backends: {
          validation: {
            runValidation: async () => ({
              executionId: "validation-gate-race",
              exitStatus: "succeeded",
              summary: "green",
              artifactRefs: [],
              usage: {},
              validationEvidence: {
                command: "npm test",
                profile: "default",
                exitCode: 0,
                testSummary: { passed: 1 },
                noTargets: false,
                accessible: true,
                acceptanceResults: [],
              },
            }),
          },
        },
      });

      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: "repo-gate-race",
        kind: "validation",
        role: "validator",
        objective: task.objective,
        authority,
      });
      await assert.rejects(handle.result(), /stale.*resumption|stale.*fencing/i);

      assert.equal(store.listValidationEvidence(mission.mission_id).length, 0);
      assert.notEqual(store.getExecution(handle.executionId)?.status, "SUCCEEDED");
      await authority.close();
    } finally {
      await fx.cleanup();
    }
  });

  it("memoizes one dispatch and one exact result promise per handle", async () => {
    let dispatches = 0;
    const { broker, m, t } = setup({
      agent: {
        runAgent: async () => {
          dispatches++;
          return {
            executionId: "worker",
            exitStatus: "succeeded",
            summary: "done",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      objective: t.objective,
    });

    const first = handle.result();
    const second = handle.result();
    assert.equal(first, second);
    assert.equal((await first).exitStatus, "succeeded");
    assert.equal(dispatches, 1);
  });

  it("memoizes result before onActivity can re-enter the handle", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = await GitRepo.open(fx.root);
      assert.ok(git);
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = store.createMission({
        title: "reentrant result",
        goal: "reentrant result",
        user_request: "reentrant result",
        repository: fx.root,
        base_ref: await git.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-reentrant-result",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-reentrant-result",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: mission.base_ref,
            writableDomains: ["src/**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-reentrant-result",
        createdAt: "2026-09-27T12:00:00.000Z",
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        repo_id: "repo-reentrant-result",
        kind: "validation",
        role: "validator",
        objective: "validate once",
      });
      let resolverCalls = 0;
      let backendCalls = 0;
      let handle!: Awaited<ReturnType<ExecutionBroker["execute"]>>;
      let reentrantResult: Promise<Awaited<ReturnType<typeof handle.result>>> | undefined;
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async (repoId) => {
          resolverCalls++;
          return { repoId, root: fx.root, git };
        },
        backends: {
          validation: {
            runValidation: async () => {
              backendCalls++;
              return {
                executionId: "validation",
                exitStatus: "succeeded",
                summary: "green",
                artifactRefs: [],
                usage: {},
                validationEvidence: {
                  command: "npm test",
                  profile: "test",
                  exitCode: 0,
                  testSummary: { passed: 1, failed: 0 },
                  noTargets: false,
                  accessible: true,
                  acceptanceResults: [],
                },
              };
            },
          },
        },
        onActivity: (event) => {
          if (event.kind === "execution" && event.phase === "started" && !reentrantResult) {
            reentrantResult = handle.result();
          }
        },
      });
      handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: task.repo_id!,
        kind: "validation",
        role: task.role,
        objective: task.objective,
      });

      const first = handle.result();
      await Promise.resolve();
      assert.ok(reentrantResult);
      assert.equal(reentrantResult, first);
      assert.equal(handle.result(), first);
      const [firstOutcome, reentrantOutcome] = await Promise.all([first, reentrantResult]);
      assert.equal(firstOutcome, reentrantOutcome);
      assert.equal(firstOutcome.exitStatus, "succeeded");
      assert.equal(resolverCalls, 1);
      assert.equal(backendCalls, 1);
      assert.equal(store.listCandidates(mission.mission_id).length, 1);
      assert.equal(store.listValidationEvidence(mission.mission_id).length, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("returns authoritative cancellation when the backend rejects after abort", async () => {
    const { broker, m, t, store } = setup({
      agent: {
        runAgent: ({ signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("backend abort")), { once: true }),
          ),
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      objective: t.objective,
    });
    const result = handle.result();
    await handle.cancel();

    const outcome = await result;
    assert.equal(outcome.error, "canceled");
    assert.equal(store.getExecution(handle.executionId)?.status, "CANCELED");
  });

  it("keeps an explicitly canceled worker branch out of integration handoffs", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = await GitRepo.open(fx.root);
      assert.ok(git);
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = store.createMission({
        title: "canceled branch",
        goal: "canceled branch",
        user_request: "canceled branch",
        repository: fx.root,
        base_ref: await git.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const workerTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "cancel this worker",
        mutates_repo: true,
        isolation: "worktree",
      });
      let started!: () => void;
      const workerStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let handoffs = 0;
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: mission.base_ref,
        cancellationAckTimeoutMs: 10,
        backends: {
          agent: {
            runAgent: async ({ signal }) => {
              started();
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              return {
                executionId: "late",
                exitStatus: "succeeded",
                summary: "late",
                artifactRefs: [],
                usage: {},
              };
            },
          },
          integration: {
            runIntegration: async (input) => {
              handoffs = input.handoffs.length;
              return {
                executionId: "integration",
                exitStatus: "succeeded",
                summary: "done",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const worker = await broker.execute({
        taskId: workerTask.task_id,
        missionId: mission.mission_id,
        kind: "agent",
        objective: workerTask.objective,
        mutatesRepo: true,
        isolation: "worktree",
      });
      const workerResult = worker.result();
      await workerStarted;
      await worker.cancel();
      assert.equal((await workerResult).error, "canceled");
      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "merge eligible work",
      });
      await (
        await broker.execute({
          taskId: integrationTask.task_id,
          missionId: mission.mission_id,
          kind: "integration",
          objective: integrationTask.objective,
        })
      ).result();

      assert.equal(handoffs, 0);
      assert.ok(broker.preservedBranches(mission.mission_id).some((branch) => branch.includes(workerTask.task_id)));
    } finally {
      await fx.cleanup();
    }
  });

  it("hard-times out while worktree allocation is blocked and preserves the late allocation", async () => {
    let allocationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      allocationStarted = resolve;
    });
    let releaseAllocation!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseAllocation = resolve;
    });
    let dispatches = 0;
    let removals = 0;
    const { store, m, t } = setup({});
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 15,
      cancellationAckTimeoutMs: 10,
      baseRef: "base",
      git: {
        root: "/repo",
        createWorktree: async () => {
          allocationStarted();
          await blocked;
          return { path: "/tmp/late-allocation", branch: "late-allocation" };
        },
        removeWorktree: async () => {
          removals++;
        },
      } as never,
      backends: {
        agent: {
          runAgent: async () => {
            dispatches++;
            return {
              executionId: "worker",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      objective: t.objective,
      mutatesRepo: true,
      isolation: "worktree",
      executionBudgetMs: 15,
    });
    const result = handle.result();
    await started;

    const outcome = await Promise.race([
      result,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("setup timeout did not settle")), 100)),
    ]);
    assert.equal(outcome.error, "timeout");
    releaseAllocation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 0);
    assert.equal(removals, 0);
    assert.ok(broker.preservedBranches(m.mission_id).includes("late-allocation"));
  });
  it("settles at the deadline plus cancellation grace when the backend ignores AbortSignal forever", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "hard timeout",
      goal: "hard timeout",
      user_request: "hard timeout",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "ignore cancellation",
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 25,
      cancellationAckTimeoutMs: 20,
      backends: {
        agent: {
          runAgent: async () => {
            await blocked;
            return {
              executionId: "late",
              exitStatus: "succeeded",
              summary: "late",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });

    const result = handle.result();
    const observed = await Promise.race([
      result.then((outcome) => ({ kind: "settled" as const, outcome })),
      new Promise<{ kind: "observation_timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "observation_timeout" }), 125),
      ),
    ]);
    release();
    await result.catch(() => undefined);

    assert.equal(observed.kind, "settled", "an uncooperative backend must not own handle settlement");
    if (observed.kind === "settled") {
      assert.equal(observed.outcome.exitStatus, "failed");
      assert.equal(observed.outcome.error, "timeout");
    }
    assert.equal(store.getExecution(handle.executionId)?.status, "FAILED");
    assert.equal(store.getExecution(handle.executionId)?.exit_status, "timeout");
  });

  it("records a late success as evidence without overwriting the terminal timeout", async () => {
    const backend = JsonlEventStore.inMemory();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "late success",
      goal: "late success",
      user_request: "late success",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "review",
      role: "reviewer",
      objective: "arrive too late",
      required_output_artifacts: ["gate"],
    });
    store.transitionTask(task.task_id, "READY");
    let finishLate!: () => void;
    const late = new Promise<void>((resolve) => {
      finishLate = resolve;
    });
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 20,
      cancellationAckTimeoutMs: 15,
      backends: {
        review: {
          runReview: async () => {
            await late;
            return {
              executionId: "late-review",
              exitStatus: "succeeded",
              summary: "late approval",
              artifactRefs: ["artifact://gate/late-approval"],
              usage: { accepted: true },
              findings: [{ severity: "none", summary: "late finding" }],
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "review",
      objective: task.objective,
      requiredOutputArtifacts: task.required_output_artifacts,
      reviewedRecovered: ["TSK-recovered"],
    });

    const outcome = await Promise.race([
      handle.result(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result did not hard-timeout")), 125)),
    ]).catch(async (error) => {
      finishLate();
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw error;
    });
    assert.equal(outcome.error, "timeout");
    const terminal = store.getExecution(handle.executionId)!;
    const findings = store.listFindings(mission.mission_id);

    finishLate();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      store.getExecution(handle.executionId),
      terminal,
      "late output must not rewrite terminal evidence",
    );
    assert.deepEqual(store.listFindings(mission.mission_id), findings, "late findings must remain inert evidence");
    assert.deepEqual(terminal.artifact_refs, [], "late gate artifacts must not become completion evidence");
    assert.ok(
      backend.all().some((event) => event.type === "execution.late_result_rejected"),
      "the rejected late result must remain auditable",
    );
    const evidence = backend
      .all()
      .reverse()
      .find((event) => event.type === "execution.late_result_rejected")?.payload.evidence as Record<string, unknown>;
    assert.deepEqual(evidence.artifactRefs, ["artifact://gate/late-approval"]);
    assert.deepEqual(evidence.findings, [{ severity: "none", summary: "late finding" }]);
    assert.equal(evidence.exitStatus, "succeeded");
    assert.equal(evidence.summary, "late approval");
    assert.equal(evidence.error, null);
    assert.deepEqual(evidence.handoffs, []);
    assert.deepEqual(evidence.recovery, []);
    assert.deepEqual(evidence.gate, {
      requiredOutputArtifacts: ["gate"],
      reviewedRecovered: ["TSK-recovered"],
      usage: { accepted: true },
    });
  });

  it("surfaces detached late-evidence append failure in persistence diagnostics", async () => {
    const backend = new LateAppendFailureBackend();
    const store = MissionStore.open(backend);
    const mission = store.createMission({
      title: "late append failure",
      goal: "late append failure",
      user_request: "late append failure",
      repository: ".",
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const task = store.createTask({
      mission_id: mission.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "finish late",
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new ExecutionBroker({
      store,
      defaultTimeoutMs: 10,
      cancellationAckTimeoutMs: 10,
      backends: {
        agent: {
          runAgent: async () => {
            await blocked;
            return {
              executionId: "late",
              exitStatus: "succeeded",
              summary: "late",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: mission.mission_id,
      kind: "agent",
      objective: task.objective,
    });
    await handle.result();
    await store.flush();
    backend.fail = true;
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      store.persistenceDiagnostics().some((diagnostic) => diagnostic.eventType === "execution.late_result_rejected"),
    );
  });

  it("does not complete declared deliverables when required artifact identities are missing", async () => {
    const { broker, m, t, store } = setup({
      agent: {
        runAgent: async () => ({
          executionId: "worker",
          exitStatus: "succeeded",
          summary: "claimed success without evidence",
          artifactRefs: [],
          usage: {},
        }),
      },
    });
    const outcome = await (
      await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        objective: "produce a diff",
        deliverables: ["implementation"],
        requiredOutputArtifacts: ["diff"],
      })
    ).result();

    assert.equal(outcome.exitStatus, "failed");
    assert.match(outcome.summary, /required output artifact.*diff/i);
    assert.equal(store.listExecutions(m.mission_id, t.task_id)[0]?.status, "FAILED");
  });

  it("anchors the hard timeout to execution creation and rejects invalid checkpoint lead time", async () => {
    const { broker, m, t } = setup({
      agent: {
        runAgent: async ({ signal }) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return {
            executionId: "late",
            exitStatus: "failed",
            summary: "deadline",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    });
    await assert.rejects(
      broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        objective: "invalid cadence",
        executionBudgetMs: 50,
        checkpointPolicy: { activity_milestone: 1, before_deadline_ms: 50 },
      }),
      /INVALID_CHECKPOINT_POLICY/,
    );
    await assert.rejects(
      broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        objective: "zero lead",
        executionBudgetMs: 50,
        checkpointPolicy: { activity_milestone: 1, before_deadline_ms: 0 },
      }),
      /INVALID_CHECKPOINT_POLICY/,
    );

    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      objective: "absolute deadline",
      executionBudgetMs: 80,
    });
    await new Promise((resolve) => setTimeout(resolve, 55));
    const startedResultAt = Date.now();
    await handle.result();
    assert.ok(Date.now() - startedResultAt < 60, "result() must use the existing deadline, not start a fresh budget");
  });

  it("checkpoints dirty work before cancellation removes the worktree and disables the deadline timer", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = await GitRepo.open(fx.root);
      assert.ok(git);
      await writeFile(
        join(fx.root, ".git", "hooks", "pre-commit"),
        [
          "#!/bin/sh",
          "if [ ! -f src/hook-added.ts ]; then",
          "  printf 'export const hookAdded = true;\\n' > src/hook-added.ts",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = store.createMission({
        title: "cancel checkpoint",
        goal: "cancel checkpoint",
        user_request: "cancel checkpoint",
        repository: fx.root,
        base_ref: await git.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-cancel",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-cancel",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: mission.base_ref,
            writableDomains: ["src/**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-cancel",
        createdAt: "2026-09-26T10:00:00.000Z",
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        repo_id: "repo-cancel",
        kind: "agent",
        role: "implementer",
        objective: "write then cancel",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
        deliverables: ["implementation"],
        execution_budget_ms: 200,
        checkpoint_policy: { activity_milestone: 10, before_deadline_ms: 100 },
        mission_generation: 2,
        candidate_generation: 3,
        fencing_token: 4,
      });
      store.transitionTask(task.task_id, "READY");
      let dirty!: () => void;
      const dirtyWritten = new Promise<void>((resolve) => {
        dirty = resolve;
      });
      const broker = new ExecutionBroker({
        store,
        git,
        checkpoints: new CheckpointManager({ store }),
        resolveRepository: async (repoId) => ({ repoId, root: fx.root, git }),
        backends: {
          agent: {
            runAgent: async ({ worktree, signal }) => {
              assert.ok(worktree);
              await writeFile(join(worktree, "src", "cancelled.ts"), "export const cancelled = true;\n", "utf8");
              dirty();
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              return {
                executionId: "late",
                exitStatus: "succeeded",
                summary: "late",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: "repo-cancel",
        kind: "agent",
        role: "implementer",
        objective: task.objective,
        mutatesRepo: true,
        writeDomains: task.write_domains,
        isolation: "worktree",
        deliverables: task.deliverables,
        executionBudgetMs: task.execution_budget_ms,
        checkpointPolicy: task.checkpoint_policy,
      });
      const result = handle.result().catch(() => undefined);
      await dirtyWritten;
      await handle.cancel();
      await result;

      const execution = store.getExecution(handle.executionId)!;
      const checkpoint = store.getTaskCheckpoint(execution.checkpoint_id!);
      assert.ok(checkpoint);
      assert.ok(checkpoint.candidateSha, "checkpoint must identify a recoverable commit");
      const removedWorktree = checkpoint.worktree!;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await access(removedWorktree);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          break;
        }
      }
      await assert.rejects(access(removedWorktree), "the canceled worktree should be cleaned up");
      const recovered = await exec("git", ["-C", fx.root, "show", `${checkpoint.candidateSha}:src/cancelled.ts`]);
      assert.equal(recovered.stdout, "export const cancelled = true;\n");
      const hookAdded = await exec("git", ["-C", fx.root, "show", `${checkpoint.candidateSha}:src/hook-added.ts`]);
      assert.equal(hookAdded.stdout, "export const hookAdded = true;\n");
      assert.deepEqual(checkpoint.preservedUncommittedChanges, []);
      assert.ok(checkpoint.committedChanges.includes("src/cancelled.ts"));
      assert.ok(checkpoint.committedChanges.includes("src/hook-added.ts"));
      const sequence = checkpoint.sequence;
      await new Promise((resolve) => setTimeout(resolve, 130));
      assert.equal(store.getTaskCheckpoint(execution.checkpoint_id!)?.sequence, sequence);
    } finally {
      await fx.cleanup();
    }
  });

  it("waits for an abort-aware writer before publishing the cancellation checkpoint", async () => {
    let started!: (worktree: string) => void;
    const worktreeReady = new Promise<string>((resolve) => {
      started = resolve;
    });
    const context = await cancellationCheckpointFixture(async ({ worktree, signal }) => {
      assert.ok(worktree);
      await writeFile(join(worktree, "src", "before-abort.ts"), "export const beforeAbort = true;\n", "utf8");
      started(worktree);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            writeFileSync(join(worktree, "src", "late-head.ts"), "export const lateHead = true;\n", "utf8");
            execFile("git", ["-C", worktree, "add", "-A"], (addError) => {
              assert.ifError(addError);
              execFile("git", ["-C", worktree, "commit", "-q", "-m", "late cancellation write"], (commitError) => {
                assert.ifError(commitError);
                resolve();
              });
            });
          },
          { once: true },
        );
      });
      return {
        executionId: "late",
        exitStatus: "succeeded",
        summary: "late",
        artifactRefs: [],
        usage: {},
      };
    });
    try {
      const result = context.handle.result().catch(() => undefined);
      await worktreeReady;
      await context.handle.cancel();
      await result;

      const execution = context.store.getExecution(context.handle.executionId)!;
      const checkpoint = context.store.getTaskCheckpoint(execution.checkpoint_id!);
      assert.ok(checkpoint?.candidateSha);
      const late = await exec("git", ["-C", context.fx.root, "show", `${checkpoint.candidateSha}:src/late-head.ts`]);
      assert.equal(late.stdout, "export const lateHead = true;\n");
    } finally {
      await context.fx.cleanup();
    }
  });

  it("retains the worktree and publishes no stale SHA when HEAD moves during the final snapshot", async () => {
    let started!: (worktree: string) => void;
    const worktreeReady = new Promise<string>((resolve) => {
      started = resolve;
    });
    const context = await cancellationCheckpointFixture(async ({ worktree, signal }) => {
      assert.ok(worktree);
      await writeFile(join(worktree, "src", "snapshot-start.ts"), "export const snapshotStart = true;\n", "utf8");
      started(worktree);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return {
        executionId: "late",
        exitStatus: "succeeded",
        summary: "late",
        artifactRefs: [],
        usage: {},
      };
    });
    const originalStatusPathsIn = context.git.statusPathsIn.bind(context.git);
    let statusReads = 0;
    let movedHead = false;
    context.git.statusPathsIn = async (worktree) => {
      const paths = await originalStatusPathsIn(worktree);
      statusReads++;
      if (statusReads >= 3 && !movedHead) {
        movedHead = true;
        await writeFile(join(worktree, "src", "moved-head.ts"), "export const movedHead = true;\n", "utf8");
        await context.git.commitAll(worktree, "move HEAD during checkpoint snapshot");
      }
      return paths;
    };
    const result = context.handle.result().catch(() => undefined);
    const worktree = await worktreeReady;
    try {
      await context.handle.cancel();
      const execution = context.store.getExecution(context.handle.executionId)!;
      assert.equal(context.store.getTaskCheckpoint(execution.checkpoint_id!), undefined);
      await access(worktree);
      assert.equal(await readFile(join(worktree, "src", "moved-head.ts"), "utf8"), "export const movedHead = true;\n");
      await context.broker.cleanupMission(context.mission.mission_id);
      await access(worktree);
    } finally {
      await result;
      await context.fx.cleanup();
    }
  });

  it("retains the worktree and publishes no checkpoint when the writer ignores cancellation", async () => {
    let started!: (worktree: string) => void;
    const worktreeReady = new Promise<string>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = await cancellationCheckpointFixture(async ({ worktree }) => {
      assert.ok(worktree);
      await writeFile(join(worktree, "src", "uncooperative.ts"), "export const uncooperative = true;\n", "utf8");
      started(worktree);
      await released;
      return {
        executionId: "late",
        exitStatus: "succeeded",
        summary: "late",
        artifactRefs: [],
        usage: {},
      };
    }, 25);
    const worktree = await (async () => {
      const result = context.handle.result().catch(() => undefined);
      const allocated = await worktreeReady;
      await context.handle.cancel();
      const execution = context.store.getExecution(context.handle.executionId)!;
      assert.equal(context.store.getTaskCheckpoint(execution.checkpoint_id!), undefined);
      await access(allocated);
      assert.equal(
        await readFile(join(allocated, "src", "uncooperative.ts"), "utf8"),
        "export const uncooperative = true;\n",
      );
      release();
      await result;
      return allocated;
    })();
    try {
      await context.broker.cleanupMission(context.mission.mission_id);
      await access(worktree);
    } finally {
      release();
      await context.fx.cleanup();
    }
  });

  it("terminalizes cancellation when checkpoint persistence never settles", async () => {
    let started!: (worktree: string) => void;
    const worktreeReady = new Promise<string>((resolve) => {
      started = resolve;
    });
    const stalledCheckpoints = {
      persist: () => new Promise<never>(() => {}),
    } as unknown as CheckpointManager;
    const context = await cancellationCheckpointFixture(
      async ({ worktree, signal }) => {
        assert.ok(worktree);
        await writeFile(join(worktree, "src", "stalled-checkpoint.ts"), "export const stalled = true;\n", "utf8");
        started(worktree);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return {
          executionId: "late",
          exitStatus: "succeeded",
          summary: "late",
          artifactRefs: [],
          usage: {},
        };
      },
      20,
      stalledCheckpoints,
    );
    const result = context.handle.result();
    const worktree = await worktreeReady;

    await Promise.race([
      context.handle.cancel(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel did not settle")), 100)),
    ]);

    assert.equal(context.store.getExecution(context.handle.executionId)?.status, "CANCELED");
    assert.equal((await result).error, "canceled");
    await access(worktree);
    assert.ok(context.broker.preservedBranches(context.mission.mission_id).length > 0);
    await context.fx.cleanup();
  });

  it("retains the dirty worktree when cancellation preservation cannot commit", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = await GitRepo.open(fx.root);
      assert.ok(git);
      await writeFile(join(fx.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = store.createMission({
        title: "retain failed preservation",
        goal: "retain failed preservation",
        user_request: "retain failed preservation",
        repository: fx.root,
        base_ref: await git.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-retain",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-retain",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: mission.base_ref,
            writableDomains: ["src/**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-retain",
        createdAt: "2026-09-26T10:00:00.000Z",
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        repo_id: "repo-retain",
        kind: "agent",
        role: "implementer",
        objective: "write then retain",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
        execution_budget_ms: 10_000,
        checkpoint_policy: {
          activity_milestone: 10,
          before_deadline_ms: 1_000,
        },
      });
      let dirty!: () => void;
      const dirtyWritten = new Promise<void>((resolve) => {
        dirty = resolve;
      });
      let worktree = "";
      const broker = new ExecutionBroker({
        store,
        git,
        checkpoints: new CheckpointManager({ store }),
        resolveRepository: async (repoId) => ({ repoId, root: fx.root, git }),
        backends: {
          agent: {
            runAgent: async ({ worktree: allocated, signal }) => {
              worktree = allocated!;
              await writeFile(join(worktree, "src", "retained.ts"), "export const retained = true;\n", "utf8");
              dirty();
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              return {
                executionId: "late",
                exitStatus: "succeeded",
                summary: "late",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: "repo-retain",
        kind: "agent",
        role: "implementer",
        objective: task.objective,
        mutatesRepo: true,
        writeDomains: task.write_domains,
        isolation: "worktree",
        executionBudgetMs: task.execution_budget_ms,
        checkpointPolicy: task.checkpoint_policy,
      });
      const result = handle.result().catch(() => undefined);
      await dirtyWritten;

      await handle.cancel();
      await result;
      await broker.cleanupMission(mission.mission_id);
      await access(worktree);
      assert.equal(await readFile(join(worktree, "src", "retained.ts"), "utf8"), "export const retained = true;\n");
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects a committed rename from outside into an authorized domain and never integrates it", async () => {
    await assertCrossBoundaryRenameRejected(true);
  });

  it("rejects a staged rename from outside into an authorized domain and never integrates it", async () => {
    await assertCrossBoundaryRenameRejected(false);
  });

  it("passes repoId explicitly to the backend and rejects a missing binding before dispatch", async () => {
    const seen: string[] = [];
    const { m, t, store } = setup({});
    const broker = new ExecutionBroker({
      store,
      resolveRepository: async (repoId) => {
        if (repoId !== "repo-known") throw new Error(`WORKSPACE_SCOPE_MISMATCH: unknown ${repoId}`);
        return {
          repoId,
          root: "/repo",
          git: {} as never,
          writableDomains: ["**"],
        };
      },
      backends: {
        agent: {
          runAgent: async (input) => {
            seen.push(input.repoId ?? "");
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });

    await (
      await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        repoId: "repo-known",
        kind: "agent",
        role: "implementer",
        objective: "read",
      })
    ).result();
    assert.deepEqual(seen, ["repo-known"]);

    const missing = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    store.transitionTask(missing.task_id, "READY");
    const handle = await broker.execute({
      taskId: missing.task_id,
      missionId: m.mission_id,
      repoId: "repo-missing",
      kind: "agent",
      role: "implementer",
      objective: "must not dispatch",
    });
    await assert.rejects(handle.result(), /WORKSPACE_SCOPE_MISMATCH/);
    assert.deepEqual(seen, ["repo-known"], "missing bindings must fail before backend dispatch");
    assert.ok(
      store
        .listFailureClassifications(m.mission_id)
        .some((classification) => classification.category === "WORKSPACE_SCOPE_MISMATCH"),
    );
  });

  it("fails candidate-scoped validation closed when durable candidate state is missing", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "missing candidate",
        goal: "missing candidate",
        user_request: "missing candidate",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-missing-candidate",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-missing-candidate",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: base,
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-missing-candidate",
        createdAt: new Date().toISOString(),
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "validation",
        role: "validator",
        objective: "validate candidate",
        repo_id: "repo-missing-candidate",
      });
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-missing-candidate",
          root: fx.root,
          git,
        }),
        backends: {
          validation: {
            candidateScoped: true,
            runValidation: async () => {
              assert.fail("candidate-scoped validation must not inspect the incumbent");
            },
          },
        },
      });

      await assert.rejects(
        (
          await broker.execute({
            taskId: task.task_id,
            missionId: mission.mission_id,
            repoId: "repo-missing-candidate",
            kind: "validation",
            objective: task.objective,
          })
        ).result(),
        /CANDIDATE_UNAVAILABLE/,
      );
      assert.equal(await git.headCommit(), base);
    } finally {
      await fx.cleanup();
    }
  });

  it("reconciles a durable candidate checkout after broker restart and validates only its exact HEAD", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "restart candidate",
        goal: "restart candidate",
        user_request: "restart candidate",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-restart-candidate",
        missionId: mission.mission_id,
        generation: 3,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-restart-candidate",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: base,
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-restart-candidate",
        createdAt: new Date().toISOString(),
      });
      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "integrate candidate before restart",
        repo_id: "repo-restart-candidate",
        mission_generation: 0,
        candidate_generation: 0,
      });
      store.transitionTask(integrationTask.task_id, "READY");
      store.transitionTask(integrationTask.task_id, "RUNNING");
      const integrationExecution = store.createExecution({
        task_id: integrationTask.task_id,
        mission_id: mission.mission_id,
        backend: "integration",
        repo_id: "repo-restart-candidate",
        base_sha: base,
        mission_generation: 0,
        candidate_generation: 0,
      });
      store.assignTaskExecution(integrationTask.task_id, integrationExecution.execution_id);
      store.setExecutionStatus(integrationExecution.execution_id, "RUNNING");
      store.setExecutionStatus(integrationExecution.execution_id, "SUCCEEDED");
      store.transitionTask(integrationTask.task_id, "SUCCEEDED");
      const candidate = await git.createCandidateWorktree(base, {
        missionId: mission.mission_id,
        repoId: "repo-restart-candidate",
        missionGeneration: 0,
        candidateGeneration: 0,
        repositoryGeneration: 3,
        attempt: integrationExecution.execution_id,
      });
      await writeFile(join(candidate.path, "src", "restart-candidate.ts"), "export const candidate = true;\n");
      await git.commitAll(candidate.path, "candidate before restart");
      candidate.candidateSha = await git.headCommitIn(candidate.path);
      candidate.updatedAt = new Date().toISOString();
      await git.persistCandidateLifecycle(candidate);
      await git.removeWorktree(candidate, { keepBranch: true });
      const wrongGeneration = await git.createCandidateWorktree(base, {
        missionId: mission.mission_id,
        repoId: "repo-restart-candidate",
        missionGeneration: 99,
        candidateGeneration: 99,
        repositoryGeneration: 99,
        attempt: "EX-wrong-generation",
      });

      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "validation",
        role: "validator",
        objective: "validate restored candidate",
        repo_id: "repo-restart-candidate",
      });
      let validatedPath: string | null = null;
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-restart-candidate",
          root: fx.root,
          git,
        }),
        backends: {
          validation: {
            candidateScoped: true,
            runValidation: async (input) => {
              validatedPath = input.worktree ?? null;
              assert.equal(await git.headCommitIn(input.worktree!), candidate.candidateSha);
              return {
                executionId: "validation",
                exitStatus: "succeeded",
                summary: "green",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });

      await (
        await broker.execute({
          taskId: task.task_id,
          missionId: mission.mission_id,
          repoId: "repo-restart-candidate",
          kind: "validation",
          objective: task.objective,
        })
      ).result();
      assert.equal(validatedPath, candidate.path);
      assert.equal(await git.headCommit(), base, "reconciliation must not inspect or mutate incumbent HEAD");
      await git.removeWorktree(candidate, { keepBranch: true }).catch(() => {});
      await git.removeWorktree(wrongGeneration, { keepBranch: true }).catch(() => {});
    } finally {
      await fx.cleanup();
    }
  });

  it("reconciles committed promotion after candidate cleanup and broker restart before mission completion", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "promotion restart",
        goal: "promotion restart",
        user_request: "promotion restart",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-promotion-restart",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-promotion-restart",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: base,
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-promotion-restart",
        createdAt: new Date().toISOString(),
      });
      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "integrate",
        repo_id: "repo-promotion-restart",
        mission_generation: 0,
        candidate_generation: 0,
      });
      store.transitionTask(integrationTask.task_id, "READY");
      store.transitionTask(integrationTask.task_id, "RUNNING");
      const execution = store.createExecution({
        task_id: integrationTask.task_id,
        mission_id: mission.mission_id,
        backend: "integration",
        repo_id: "repo-promotion-restart",
        base_sha: base,
        mission_generation: 0,
        candidate_generation: 0,
      });
      store.assignTaskExecution(integrationTask.task_id, execution.execution_id);
      store.setExecutionStatus(execution.execution_id, "RUNNING");
      store.setExecutionStatus(execution.execution_id, "SUCCEEDED");
      store.transitionTask(integrationTask.task_id, "SUCCEEDED");
      const candidate = await git.createCandidateWorktree(base, {
        missionId: mission.mission_id,
        repoId: "repo-promotion-restart",
        missionGeneration: 0,
        candidateGeneration: 0,
        repositoryGeneration: 1,
        attempt: execution.execution_id,
      });
      await writeFile(join(candidate.path, "src", "promotion-restart.ts"), "export const recovered = true;\n");
      await git.commitAll(candidate.path, "promotion restart candidate");
      candidate.candidateSha = await git.headCommitIn(candidate.path);
      const integrationRun = await git.beginIntegrationRun(candidate, execution.execution_id, []);
      integrationRun.state = "completed";
      integrationRun.candidateSha = candidate.candidateSha;
      await git.persistIntegrationRun(integrationRun);
      candidate.integrationRunId = integrationRun.runId;
      await git.persistCandidateLifecycle(candidate);
      await assert.rejects(
        git.promoteCandidate(candidate, base, undefined, candidate, {
          afterCompletion: () => {
            throw new Error("crash after promotion completion");
          },
        }),
        /crash after promotion completion/,
      );
      await git.removeWorktree(candidate, { keepBranch: true });

      let recoveredGatePath: string | null = null;
      const restarted = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-promotion-restart",
          root: fx.root,
          git,
        }),
        backends: {
          validation: {
            candidateScoped: true,
            runValidation: async ({ worktree }) => {
              recoveredGatePath = worktree ?? null;
              return {
                executionId: "recovered-gate",
                exitStatus: "succeeded",
                summary: "exact promoted candidate inspected",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });

      const validationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "validation",
        role: "validator",
        objective: "recover exact promoted candidate context",
        repo_id: "repo-promotion-restart",
        mission_generation: 0,
        candidate_generation: 0,
      });
      await (
        await restarted.execute({
          taskId: validationTask.task_id,
          missionId: mission.mission_id,
          repoId: "repo-promotion-restart",
          kind: "validation",
          objective: validationTask.objective,
        })
      ).result();
      assert.equal(recoveredGatePath, candidate.path, "completed promotion must restore only its exact candidate cwd");

      assert.equal(await restarted.promoteCandidate(mission.mission_id), true);
      assert.equal(await git.headCommit(), candidate.candidateSha);

      const stateDir = join(await git.commonDir(), "pi-engineering-candidates");
      const promotionFile = (
        await Promise.all(
          (
            await readdir(stateDir)
          )
            .filter((name) => name.startsWith("promotion."))
            .map(async (name) => ({
              name,
              record: JSON.parse(await readFile(join(stateDir, name), "utf8")) as { state?: string },
            })),
        )
      ).find(({ record }) => record.state === "completed")!.name;
      const forged = JSON.parse(await readFile(join(stateDir, promotionFile), "utf8")) as Record<string, unknown>;
      forged.candidateRepositoryGeneration = 999;
      await writeFile(join(stateDir, promotionFile), JSON.stringify(forged));
      const forgedTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "validation",
        role: "validator",
        objective: "reject forged completion",
        repo_id: "repo-promotion-restart",
        mission_generation: 0,
        candidate_generation: 0,
      });
      const forgedRestart = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-promotion-restart",
          root: fx.root,
          git,
        }),
        backends: {
          validation: {
            candidateScoped: true,
            runValidation: async () => {
              throw new Error("forged promotion must never dispatch");
            },
          },
        },
      });
      await assert.rejects(
        (
          await forgedRestart.execute({
            taskId: forgedTask.task_id,
            missionId: mission.mission_id,
            repoId: "repo-promotion-restart",
            kind: "validation",
            objective: forgedTask.objective,
          })
        ).result(),
        /CANDIDATE_UNAVAILABLE/,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("fresh current gates reauthorize a base-only stale intent and promote under current authority", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "reauthorize promotion",
        goal: "reauthorize promotion",
        user_request: "reauthorize promotion",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-reauthorize-promotion",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-reauthorize-promotion",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: base,
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-reauthorize-promotion",
        createdAt: new Date().toISOString(),
      });
      const integrationTask = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "integrate",
        repo_id: "repo-reauthorize-promotion",
        mission_generation: 0,
        candidate_generation: 0,
      });
      store.transitionTask(integrationTask.task_id, "READY");
      store.transitionTask(integrationTask.task_id, "RUNNING");
      const execution = store.createExecution({
        task_id: integrationTask.task_id,
        mission_id: mission.mission_id,
        backend: "integration",
        repo_id: "repo-reauthorize-promotion",
        base_sha: base,
        mission_generation: 0,
        candidate_generation: 0,
      });
      store.assignTaskExecution(integrationTask.task_id, execution.execution_id);
      store.setExecutionStatus(execution.execution_id, "RUNNING");
      store.setExecutionStatus(execution.execution_id, "SUCCEEDED");
      store.transitionTask(integrationTask.task_id, "SUCCEEDED");
      const candidate = await git.createCandidateWorktree(base, {
        missionId: mission.mission_id,
        repoId: "repo-reauthorize-promotion",
        missionGeneration: 0,
        candidateGeneration: 0,
        repositoryGeneration: 1,
        attempt: execution.execution_id,
      });
      await writeFile(join(candidate.path, "src", "reauthorized.ts"), "export const current = true;\n");
      await git.commitAll(candidate.path, "reauthorized candidate");
      candidate.candidateSha = await git.headCommitIn(candidate.path);
      await git.persistCandidateLifecycle(candidate);
      let stale = false;
      await assert.rejects(
        git.promoteCandidate(
          candidate,
          base,
          {
            assertAuthoritative: () => {
              if (stale) throw new Error("takeover before CAS");
            },
          },
          candidate,
          {
            beforeCas: () => {
              stale = true;
            },
          },
        ),
        /takeover before CAS/,
      );
      assert.equal(await git.headCommit(), base);

      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-reauthorize-promotion",
          root: fx.root,
          git,
        }),
        backends: {},
      });
      const authority = {
        missionIdentity: {
          missionId: mission.mission_id,
          generation: 0,
          fencingToken: 8,
        },
        repositoryIdentity: {
          repoId: "repo-reauthorize-promotion",
          generation: 99,
          fencingToken: 12,
        },
        assertAuthoritative: () => {},
        onInvalidated: () => () => {},
        close: async () => undefined,
      } as never;
      assert.equal(await broker.promoteCandidate(mission.mission_id, authority), true);
      assert.equal(await git.headCommit(), candidate.candidateSha);
      const promotions = await git.loadPromotionLifecycles(candidate.missionId, candidate.repoId);
      assert.equal(promotions.at(-1)?.state, "completed");
      assert.equal(promotions.at(-1)?.repositoryGeneration, 99, "fresh authority must supersede stale origin intent");
    } finally {
      await fx.cleanup();
    }
  });

  it("records stale cancellation preservation failure and retains the candidate diagnostics", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const base = await git.headCommit();
      const mission = store.createMission({
        title: "stale cancel",
        goal: "stale cancel",
        user_request: "stale cancel",
        repository: fx.root,
        base_ref: base,
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      store.bindWorkspaceManifest({
        manifestId: "WM-stale-cancel",
        missionId: mission.mission_id,
        generation: 1,
        authorizedRoots: [
          {
            canonicalPath: fx.root,
            source: "existing_manifest",
            access: "write",
          },
        ],
        repositories: [
          {
            repoId: "repo-stale-cancel",
            canonicalRoot: fx.root,
            baseRef: "main",
            baseSha: base,
            writableDomains: ["**"],
          },
        ],
        dependencyEdges: [],
        hash: "manifest-stale-cancel",
        createdAt: new Date().toISOString(),
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "integrate until canceled",
        repo_id: "repo-stale-cancel",
        mission_generation: 5,
        candidate_generation: 2,
      });
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      let stale = false;
      const authority = {
        missionIdentity: {
          missionId: mission.mission_id,
          generation: 5,
          ownerId: "owner-stale-cancel",
          acquiredAt: new Date().toISOString(),
          renewBy: new Date(Date.now() + 60_000).toISOString(),
          fencingToken: 5,
        },
        repositoryIdentity: {
          missionId: mission.mission_id,
          repoId: "repo-stale-cancel",
          generation: 9,
          ownerId: "owner-stale-cancel",
          acquiredAt: new Date().toISOString(),
          renewBy: new Date(Date.now() + 60_000).toISOString(),
          fencingToken: 9,
        },
        assertAuthoritative: () => {
          if (stale) throw new Error("stale repository authority");
        },
        onInvalidated: () => {},
        close: async () => undefined,
      };
      store.assignTaskAuthority(task.task_id, authority.missionIdentity);
      const broker = new ExecutionBroker({
        store,
        resolveRepository: async () => ({
          repoId: "repo-stale-cancel",
          root: fx.root,
          git,
        }),
        backends: {
          integration: {
            candidateScoped: true,
            runIntegration: async ({ signal }) => {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                started();
              });
              return {
                executionId: "late",
                exitStatus: "succeeded",
                summary: "late",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const handle = await broker.execute({
        taskId: task.task_id,
        missionId: mission.mission_id,
        repoId: "repo-stale-cancel",
        kind: "integration",
        objective: task.objective,
        authority,
      });
      const result = handle.result();
      await running;
      stale = true;
      await handle.cancel();
      await result;

      assert.ok(broker.candidateWorktree(mission.mission_id), "stale cancellation must retain candidate checkout");
      assert.ok(
        store
          .listFindings(mission.mission_id)
          .some((finding) => finding.summary.includes("Candidate preservation failed during cancellation")),
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects manifest-era mutation when the task has no repoId", async () => {
    let runs = 0;
    const { m, store } = setup({});
    const task = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "unbound mutation",
      mutates_repo: true,
      isolation: "none",
      write_domains: ["**"],
    });
    store.transitionTask(task.task_id, "READY");
    const broker = new ExecutionBroker({
      store,
      git: {} as never,
      resolveRepository: async (repoId) => ({
        repoId,
        root: "/repo",
        git: {} as never,
      }),
      backends: {
        agent: {
          runAgent: async () => {
            runs++;
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });

    const handle = await broker.execute({
      taskId: task.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: task.objective,
      mutatesRepo: true,
      isolation: "none",
      writeDomains: ["**"],
    });

    await assert.rejects(handle.result(), /WORKSPACE_SCOPE_MISMATCH/);
    assert.equal(runs, 0);
    assert.ok(
      store
        .listFailureClassifications(m.mission_id)
        .some((classification) => classification.category === "WORKSPACE_SCOPE_MISMATCH"),
    );
  });

  it("fails closed before direct-checkout mutation when manifest domains are restricted", async () => {
    let runs = 0;
    const { m, t, store } = setup({});
    const broker = new ExecutionBroker({
      store,
      git: {} as never,
      resolveRepository: async (repoId) => ({
        repoId,
        root: "/repo",
        git: {} as never,
      }),
      backends: {
        agent: {
          runAgent: async () => {
            runs++;
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "unsafe",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      repoId: "repo-known",
      kind: "agent",
      role: "implementer",
      objective: "unsafe direct mutation",
      mutatesRepo: true,
      writeDomains: ["src/**"],
      isolation: "none",
    });

    await assert.rejects(handle.result(), /restricted domains require an isolated worktree/i);
    assert.equal(runs, 0);
  });
  it("fails closed when an isolated mutating worktree cannot be allocated", async () => {
    let runs = 0;
    const { store, m, t } = setup({});
    const broker = new ExecutionBroker({
      store,
      git: {
        headCommit: async () => "abc",
        createWorktree: async () => {
          throw new Error("disk full");
        },
      } as never,
      backends: {
        agent: {
          runAgent: async () => {
            runs++;
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "unsafe",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });

    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "mutate safely",
      mutatesRepo: true,
      isolation: "worktree",
    });

    await assert.rejects(handle.result(), /isolated worktree.*disk full/i);
    assert.equal(runs, 0, "the worker must never fall back to the user's checkout");
    assert.equal(store.listExecutions(m.mission_id)[0]?.status, "FAILED");
  });

  it("still dispatches read-only and explicitly non-isolated work without a worktree", async () => {
    const seen: Array<string | null | undefined> = [];
    const { store, m } = setup({});
    const broker = new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: async ({ worktree }) => {
            seen.push(worktree);
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "safe",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const readOnly = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "scout",
      objective: "inspect",
    });
    const nonIsolated = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "mutate explicitly in place",
    });

    await (
      await broker.execute({
        taskId: readOnly.task_id,
        missionId: m.mission_id,
        kind: "agent",
        objective: "inspect",
        mutatesRepo: false,
        isolation: "worktree",
      })
    ).result();
    await (
      await broker.execute({
        taskId: nonIsolated.task_id,
        missionId: m.mission_id,
        kind: "agent",
        objective: "mutate explicitly in place",
        mutatesRepo: true,
        isolation: "none",
      })
    ).result();

    assert.deepEqual(seen, [null, null]);
  });

  it("does not dispatch when an execution was canceled before result starts", async () => {
    let runs = 0;
    const { m, t, broker } = setup({
      agent: {
        runAgent: async () => {
          runs++;
          return {
            executionId: "e",
            exitStatus: "succeeded",
            summary: "late",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      objective: "x",
    });
    await handle.cancel();
    assert.equal((await handle.result()).error, "canceled");
    assert.equal(runs, 0);
  });

  it("does not dispatch after cancellation during worktree allocation and preserves the late worktree", async () => {
    let runs = 0;
    let releaseAllocation!: () => void;
    let allocationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      allocationStarted = resolve;
    });
    let removals = 0;
    const { store, m, t } = setup({});
    const broker = new ExecutionBroker({
      store,
      baseRef: "abc",
      git: {
        createWorktree: async () => {
          allocationStarted();
          await new Promise<void>((resolve) => {
            releaseAllocation = resolve;
          });
          return { path: "/tmp/delayed-worktree", branch: "delayed" };
        },
        removeWorktree: async () => {
          removals++;
        },
      } as never,
      backends: {
        agent: {
          runAgent: async () => {
            runs++;
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "late",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      objective: "x",
      mutatesRepo: true,
      isolation: "worktree",
    });
    const pending = handle.result();
    await started;
    await handle.cancel();
    releaseAllocation();
    assert.equal((await pending).error, "canceled");
    assert.equal(runs, 0);
    assert.equal(removals, 0);
    assert.ok(broker.preservedBranches(m.mission_id).includes("delayed"));
  });

  it("clears the activity interval immediately when a signal-ignoring backend is canceled", async () => {
    let finish!: () => void;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let activityTimer: ReturnType<typeof setInterval> | undefined;
    let activityTimerCleared = false;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      activityTimer = originalSetInterval(...args);
      return activityTimer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      if (timer === activityTimer) activityTimerCleared = true;
      return originalClearInterval(timer);
    }) as typeof clearInterval;
    try {
      const { m, t, broker } = setup({
        agent: {
          runAgent: async () => {
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "late",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      });
      const handle = await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        objective: "x",
      });
      const pending = handle.result();
      while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
      await handle.cancel();
      finish();
      await pending;
      assert.equal(activityTimerCleared, true);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      if (activityTimer) originalClearInterval(activityTimer);
    }
  });

  it("emits execution-local heartbeats for long validation/process work and stops after settlement", async () => {
    const activity: Array<{ kind: string; summary: string }> = [];
    const finish: Array<() => void> = [];
    const delayedOutcome = (executionId: string) => async () => {
      await new Promise<void>((resolve) => finish.push(resolve));
      return {
        executionId,
        exitStatus: "succeeded",
        summary: "ok",
        artifactRefs: [],
        usage: {},
      };
    };
    const { store, m, broker } = setup({
      validation: {
        runValidation: delayedOutcome("v"),
      },
      process: { runProcess: delayedOutcome("p") },
    });
    const validation = store.createTask({
      mission_id: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "check",
    });
    const process = store.createTask({
      mission_id: m.mission_id,
      kind: "process",
      role: "runner",
      objective: "build",
    });
    const observing = new ExecutionBroker({
      store,
      backends: (broker as unknown as { backends: BrokerBackends }).backends,
      activityHeartbeatMs: 10,
      onActivity: (event) => activity.push({ kind: event.kind, summary: event.summary }),
    });
    const validationHandle = await observing.execute({
      taskId: validation.task_id,
      missionId: m.mission_id,
      kind: "validation",
      objective: "check",
    });
    const processHandle = await observing.execute({
      taskId: process.task_id,
      missionId: m.mission_id,
      kind: "process",
      objective: "build",
    });
    const pending = Promise.all([validationHandle.result(), processHandle.result()]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    for (const resolve of finish) resolve();
    await pending;
    assert.ok(
      activity.some((event) => /Validation still running/.test(event.summary)),
      JSON.stringify(activity),
    );
    assert.ok(
      activity.some((event) => /Process still running/.test(event.summary)),
      JSON.stringify(activity),
    );
    const count = activity.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(activity.length, count, "execution heartbeats must stop after settlement");
  });

  it("attaches mission/task/execution identity to backend activity", async () => {
    const seen: Array<{
      missionId: string;
      taskId: string;
      executionId: string;
      summary: string;
    }> = [];
    const { m, t, broker } = setup({
      agent: {
        runAgent: async ({ onActivity }) => {
          onActivity?.({
            kind: "state",
            summary: "Worker session started",
            meaningfulProgress: false,
          });
          return {
            executionId: "e",
            exitStatus: "succeeded",
            summary: "done",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    });
    const observing = new ExecutionBroker({
      store: (broker as unknown as { store: MissionStore }).store,
      backends: (broker as unknown as { backends: BrokerBackends }).backends,
      onActivity: (event) =>
        seen.push({
          missionId: event.missionId,
          taskId: event.taskId,
          executionId: event.executionId,
          summary: event.summary,
        }),
    });
    const handle = await observing.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    await handle.result();
    assert.ok(seen.some((event) => event.summary === "Worker session started"));
    assert.ok(
      seen.every(
        (event) =>
          event.missionId === m.mission_id && event.taskId === t.task_id && event.executionId === handle.executionId,
      ),
    );
  });

  it("workerTimeoutMs defaults to no budget (0) and honors the env override", () => {
    const prev = process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
    try {
      delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
      assert.equal(workerTimeoutMs(), 0, "no default wall-clock budget: a working worker is not stopped by time");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = "60000";
      assert.equal(workerTimeoutMs(), 60_000, "env override must win");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = String(2 ** 40);
      assert.equal(workerTimeoutMs(), 2 ** 31 - 1, "beyond setTimeout's range the timer would fire at once");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = "not-a-number";
      assert.equal(workerTimeoutMs(), 0, "invalid env must fall back to the default (no budget)");
    } finally {
      if (prev === undefined) delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
      else process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = prev;
    }
  });

  it("dispatches to the agent backend and records a successful execution", async () => {
    const { store, m, t, broker } = setup({
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
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    const outcome = await handle.result();
    assert.equal(outcome.exitStatus, "succeeded");
    const ex = store.listExecutions(m.mission_id)[0]!;
    assert.equal(ex.status, "SUCCEEDED");
    assert.equal(ex.backend, "agent");
  });

  it("supports cancellation via the common contract", async () => {
    let started = false;
    const { store, m, t, broker } = setup({
      agent: {
        runAgent: async ({ signal }): Promise<never> => {
          started = true;
          await new Promise<void>((_, rej) => {
            signal.addEventListener("abort", () => rej(new Error("canceled")));
          });
          throw new Error("canceled");
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    const resultP = handle.result(); // starts dispatch; not awaited yet
    await new Promise((r) => setImmediate(r)); // let dispatch begin
    assert.ok(started);
    await handle.cancel();
    const ex = store.listExecutions(m.mission_id)[0]!;
    assert.equal(ex.status, "CANCELED");
    assert.equal((await resultP).error, "canceled");
  });

  it("supports steering and records it as a task steer request", async () => {
    let steered = "";
    const { store, m, t, broker } = setup({
      agent: {
        runAgent: async () => ({
          executionId: "e",
          exitStatus: "succeeded",
          summary: "done",
          artifactRefs: [],
          usage: {},
        }),
        onSteer: (s) => {
          steered = s;
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
    });
    await handle.steer("do not touch schema");
    assert.equal(steered, "do not touch schema");
    assert.equal(store.getTask(t.task_id)!.steer_requests[0], "do not touch schema");
  });

  it("maps process/validation kinds to the right backend", async () => {
    const calls: string[] = [];
    const { m, broker } = setup({
      validation: {
        runValidation: async () => {
          calls.push("validation");
          return {
            executionId: "e",
            exitStatus: "succeeded",
            summary: "ok",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    });
    const t = m as never;
    void t;
    // Create a validation task directly on the shared store.
    const store = (broker as unknown as { store: MissionStore }).store;
    const vt = store.createTask({
      mission_id: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate",
    });
    const handle = await broker.execute({
      taskId: vt.task_id,
      missionId: m.mission_id,
      kind: "validation",
      role: "validator",
      objective: "validate",
    });
    await handle.result();
    assert.deepEqual(calls, ["validation"]);
  });

  it("allocates an isolated git worktree for a mutating, worktree-isolated task (spec 05)", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = await GitRepo.open(fx.root);
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = store.createMission({
        title: "x",
        goal: "x",
        user_request: "x",
        repository: ".",
        base_ref: await git!.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const t = store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      store.transitionTask(t.task_id, "READY");
      const seenWorktree: string[] = [];
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: await git!.headCommit(),
        backends: {
          agent: {
            runAgent: async ({ worktree }) => {
              seenWorktree.push(worktree ?? "");
              return {
                executionId: "e",
                exitStatus: "succeeded",
                summary: "done",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const handle = await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutatesRepo: true,
        isolation: "worktree",
      });
      await handle.result();
      // The worker ran in a dedicated worktree path (a sibling of the repo).
      assert.equal(seenWorktree.length, 1);
      assert.ok(seenWorktree[0]!.length > 0);
      assert.notEqual(seenWorktree[0]!, fx.root);
      // Worktree was released (cleaned up) after settlement.
      assert.equal(broker.allocatedWorktrees?.size ?? 0, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("cancelByTask aborts the runner and leaves the execution/task CANCELED (not overwritten)", async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: "abc",
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "slow work",
      mutates_repo: false,
    });
    store.transitionTask(t.task_id, "READY");
    store.transitionTask(t.task_id, "RUNNING");

    let aborted = false;
    let executionId = "";
    const broker = new ExecutionBroker({
      store,
      backends: {
        agent: {
          runAgent: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
            }),
        },
      },
    });
    const handle = await broker.execute({
      taskId: t.task_id,
      missionId: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "slow work",
    });
    executionId = handle.executionId;
    const settled = handle.result().catch(() => undefined);
    await new Promise((r) => setImmediate(r));

    const canceled = await broker.cancelByTask(t.task_id);
    assert.equal(canceled, true, "cancelByTask must find the in-flight execution");
    await settled;

    assert.ok(aborted, "the runner must actually be aborted");
    const ex = store.listExecutions(m.mission_id).find((e) => e.execution_id === executionId);
    assert.equal(ex?.status, "CANCELED", `execution must stay CANCELED, got ${ex?.status}`);
    assert.equal(store.getTask(t.task_id)?.status, "CANCELED");
  });

  it("collects mission worktrees and merges them via the integration backend (spec 05)", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = await GitRepo.open(fx.root);
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = store.createMission({
        title: "x",
        goal: "x",
        user_request: "x",
        repository: ".",
        base_ref: await git!.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const t = store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      store.transitionTask(t.task_id, "READY");

      const seenHandoffs: Array<{ branch: string }> = [];
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: await git!.headCommit(),
        backends: {
          agent: {
            runAgent: async () => ({
              executionId: "e",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            }),
          },
          integration: {
            runIntegration: async ({ handoffs }) => {
              seenHandoffs.push(...handoffs.map((h) => ({ branch: h.worktree.branch })));
              return {
                executionId: "i",
                exitStatus: "succeeded",
                summary: "merged",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      // Run a mutating agent (allocates a mission worktree).
      await (
        await broker.execute({
          taskId: t.task_id,
          missionId: m.mission_id,
          kind: "agent",
          role: "implementer",
          objective: "x",
          mutatesRepo: true,
          isolation: "worktree",
        })
      ).result();
      // Now run integration for the same mission.
      const it = store.createTask({
        mission_id: m.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "merge",
      });
      await (
        await broker.execute({
          taskId: it.task_id,
          missionId: m.mission_id,
          kind: "integration",
          role: "integrator",
          objective: "merge",
        })
      ).result();
      // The integrator received the worker worktree as a handoff, and it was released after merging.
      assert.equal(seenHandoffs.length, 1);
      assert.ok(seenHandoffs[0]!.branch.startsWith("pi-eng-orch-"));
      assert.equal(broker.allocatedWorktrees?.size ?? 0, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("records a visible finding when a mutating worker\u2019s edits cannot be harvested (commit fails)", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = store.createMission({
        title: "x",
        goal: "x",
        user_request: "x",
        repository: ".",
        base_ref: await git!.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const t = store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      store.transitionTask(t.task_id, "READY");

      // A worker that DID edit its worktree must never have that work lost
      // silently. Force the harvest commit to fail deterministically (worktrees
      // share the main repo\u2019s hooks dir) and require the broker to surface a
      // finding explaining why the work will not integrate.
      const { mkdir, writeFile, chmod } = await import("node:fs/promises");
      const hooksDir = join(fx.root, ".git", "hooks");
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
      await chmod(join(hooksDir, "pre-commit"), 0o755);

      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: await git!.headCommit(),
        backends: {
          agent: {
            runAgent: async ({ worktree }) => {
              if (worktree) {
                const { writeFile } = await import("node:fs/promises");
                await writeFile(join(worktree, "harvest-me.js"), "export const x = 1;\n");
              }
              return {
                executionId: "e",
                exitStatus: "succeeded",
                summary: "done",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const handle = await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutatesRepo: true,
        isolation: "worktree",
      });
      await handle.result();

      const findings = store.listFindings(m.mission_id);
      assert.ok(
        findings.some((f) => f.category === "integration" && f.severity === "major" && f.summary.includes("harvested")),
        `expected a visible harvest-failure finding, got ${findings.map((f) => `${f.severity}:${f.category}:${f.summary}`).join(" | ")}`,
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("publishes no handoff when the Git harvest safety query fails", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const mission = store.createMission({
        title: "query failure",
        goal: "query failure",
        user_request: "query failure",
        repository: fx.root,
        base_ref: await git.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const task = store.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "query failure",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      store.transitionTask(task.task_id, "READY");
      git.branchAheadOf = async () => {
        throw new Error("injected Git handoff query failure");
      };
      const seenHandoffs: unknown[] = [];
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: mission.base_ref,
        backends: {
          agent: {
            runAgent: async ({ worktree }) => {
              await writeFile(join(worktree!, "src", "query-failure.ts"), "export const value = 1;\n");
              return {
                executionId: "query-failure",
                exitStatus: "succeeded",
                summary: "done",
                artifactRefs: [],
                usage: {},
              };
            },
          },
          integration: {
            runIntegration: async ({ handoffs }) => {
              seenHandoffs.push(...handoffs);
              return {
                executionId: "integration",
                exitStatus: "succeeded",
                summary: "integrated",
                artifactRefs: [],
                usage: {},
              };
            },
          },
        },
      });
      const outcome = await (
        await broker.execute({
          taskId: task.task_id,
          missionId: mission.mission_id,
          kind: "agent",
          role: "implementer",
          objective: task.objective,
          mutatesRepo: true,
          isolation: "worktree",
        })
      ).result();
      assert.equal(outcome.exitStatus, "failed");
      assert.ok(store.listFindings(mission.mission_id).some((finding) => finding.severity === "major"));
      const integration = store.createTask({
        mission_id: mission.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "integrate only verified handoffs",
      });
      await (
        await broker.execute({
          taskId: integration.task_id,
          missionId: mission.mission_id,
          kind: "integration",
          role: "integrator",
          objective: integration.objective,
        })
      ).result();
      assert.deepEqual(seenHandoffs, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("surfaces an attributable finding when a mutating worker succeeds with no edits to harvest", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      const store = MissionStore.open(JsonlEventStore.inMemory());
      const m = store.createMission({
        title: "x",
        goal: "x",
        user_request: "x",
        repository: ".",
        base_ref: await git!.headCommit(),
        risk_profile: "medium",
        workflow_class: "engineering_review",
      });
      const t = store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      });
      store.transitionTask(t.task_id, "READY");

      // The worker reports SUCCESS but never touches its isolated worktree. This
      // is exactly the "harvested worktrees were empty" case the integration
      // finding calls out: the broker must record WHO came back empty so the
      // later opaque integration block is not the only trace.
      const broker = new ExecutionBroker({
        store,
        git,
        baseRef: await git!.headCommit(),
        backends: {
          agent: {
            runAgent: async () => ({
              executionId: "e",
              exitStatus: "succeeded",
              summary: "done (no changes needed)",
              artifactRefs: [],
              usage: {},
            }),
          },
        },
      });
      const handle = await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutatesRepo: true,
        isolation: "worktree",
      });
      await handle.result();

      const findings = store.listFindings(m.mission_id);
      assert.ok(
        findings.some(
          (f) =>
            f.category === "integration" &&
            f.summary.includes("held no committed work") &&
            f.summary.includes("harvested worktree was empty") &&
            f.task_id === t.task_id,
        ),
        `expected an attributable empty-harvest finding for the worker task, got ${findings
          .map((f) => `${f.severity}:${f.category}:${f.summary} (task=${f.task_id})`)
          .join(" | ")}`,
      );
    } finally {
      await fx.cleanup();
    }
  });
});

/**
 * Regression (APS Phase 1/2): an implementer that commits its OWN work directly
 * onto its worker branch leaves a clean working tree, but the branch has
 * advanced past the mission base. Harvest must recognize that committed work
 * (not treat a clean tree as "nothing to harvest"), integration must merge the
 * branch tip into the base checkout, and changedFilesSinceBase must then be
 * non-empty. This pins the whole committed-work branch lifecycle with a real
 * git fixture and NO live model.
 */
it("harvest recognizes a worker's own committed work (clean tree) and integration lands it", async () => {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const base = await git.headCommit();
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: base,
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      mutates_repo: true,
      isolation: "worktree",
      write_domains: ["src/**"],
    });
    store.transitionTask(t.task_id, "READY");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const broker = new ExecutionBroker({
      store,
      git,
      baseRef: base,
      backends: {
        agent: {
          runAgent: async ({ worktree }) => {
            // Simulate an implementer that commits its own work directly onto
            // its worker branch and leaves a CLEAN tree (nothing to "harvest"
            // from the working tree, yet the branch has advanced past base).
            const { writeFile } = await import("node:fs/promises");
            await writeFile(join(worktree!, "src", "add.js"), "export const add = (a, b) => a + b;\n");
            await exec("git", ["-C", worktree!, "add", "-A"]);
            await exec("git", ["-C", worktree!, "commit", "-q", "-m", "implementer commits own work"]);
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            };
          },
        },
        integration: {
          runIntegration: async (input) =>
            new Integrator(git).integrate({
              objective: input.objective,
              baseCommit: base,
              handoffs: input.handoffs,
              signal: input.signal,
            }),
        },
      },
    });

    const workerBranch = `pi-eng-orch-${t.task_id}`;
    await (
      await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutatesRepo: true,
        isolation: "worktree",
      })
    ).result();

    // (a) Harvest must recognize the committed work even though the tree is clean.
    assert.equal(
      broker.hasCommittedWorkerWork(m.mission_id),
      true,
      "harvest must recognize the worker's own committed work (branch advanced past base)",
    );
    assert.equal(await git.branchAheadOf(base, workerBranch), true, "worker branch must have commits since base");

    // (b) Legacy unbound integration merges the branch tip into the base checkout.
    const it = store.createTask({
      mission_id: m.mission_id,
      kind: "integration",
      role: "integrator",
      objective: "merge",
    });
    store.transitionTask(it.task_id, "READY");
    await (
      await broker.execute({
        taskId: it.task_id,
        missionId: m.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "merge",
      })
    ).result();

    const landed = await broker.changedFilesSinceBase(m.mission_id);
    assert.ok(landed !== null, "changedFilesSinceBase must be computable");
    assert.ok(landed!.length > 0, `integration must land committed work; got ${JSON.stringify(landed)}`);
    assert.ok(landed!.includes("src/add.js"));
    // The merged file is present in the base checkout.
    const { access } = await import("node:fs/promises");
    let present = true;
    try {
      await access(join(fx.root, "src", "add.js"));
    } catch {
      present = false;
    }
    assert.ok(present, "the committed work must be physically present in the base checkout after merge");
  } finally {
    await fx.cleanup();
  }
});

/**
 * Regression (branch lifecycle): cleanup MUST never force-delete (git branch -D)
 * a worker branch that carries unmerged commits, even when the caller asks for
 * keepBranches=false (the "integration succeeded" path). The unmerged branch is
 * the only copy of the worker's output and must stay recoverable.
 */
it("cleanup never force-deletes a worker branch carrying unmerged commits", async () => {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const base = await git.headCommit();
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: base,
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      mutates_repo: true,
      isolation: "worktree",
      write_domains: ["src/**"],
    });
    store.transitionTask(t.task_id, "READY");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const broker = new ExecutionBroker({
      store,
      git,
      baseRef: base,
      backends: {
        agent: {
          runAgent: async ({ worktree }) => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(join(worktree!, "src", "add.js"), "export const add = (a, b) => a + b;\n");
            await exec("git", ["-C", worktree!, "add", "-A"]);
            await exec("git", ["-C", worktree!, "commit", "-q", "-m", "unmerged worker work"]);
            return {
              executionId: "e",
              exitStatus: "succeeded",
              summary: "done",
              artifactRefs: [],
              usage: {},
            };
          },
        },
      },
    });
    const workerBranch = `pi-eng-orch-${t.task_id}`;
    await (
      await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutatesRepo: true,
        isolation: "worktree",
      })
    ).result();

    // The work was committed directly and never integrated.
    assert.equal(await git.branchAheadOf(base, workerBranch), true, "branch must carry commits since base");
    assert.equal(broker.pendingIntegrations(m.mission_id), 1, "an unmerged mission worktree must still be tracked");

    // Cleanup with keepBranches=false (the "integration succeeded" path) must
    // STILL preserve the branch because its tip is not an ancestor of HEAD.
    await broker.cleanupMission(m.mission_id, { keepBranches: false });

    const verify = await exec("git", ["-C", fx.root, "rev-parse", "--verify", "--quiet", workerBranch]).catch(
      () => null,
    );
    assert.ok(
      verify && verify.stdout.trim().length > 0,
      `unmerged worker branch must be preserved after cleanup (branch=${workerBranch})`,
    );
    assert.ok(
      broker.preservedBranches(m.mission_id).includes(workerBranch),
      "the preserved branch must be recorded for operator recovery",
    );
  } finally {
    await fx.cleanup();
  }
});

/**
 * Loss-on-failure regression (finding fGg5J6): a mutating worker that FAILS
 * after leaving uncommitted edits must not have those edits destroyed with the
 * worktree teardown. The broker must harvest (commit) the partial work onto
 * the worker branch, must NOT merge a failed branch into the base checkout, and
 * must preserve the branch so the partial work stays recoverable.
 */
it("preserves a failed worker's uncommitted edits (never merges or discards them)", async () => {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const base = await git.headCommit();
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: base,
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      mutates_repo: true,
      isolation: "worktree",
      write_domains: ["src/**"],
    });
    store.transitionTask(t.task_id, "READY");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const broker = new ExecutionBroker({
      store,
      git,
      baseRef: base,
      backends: {
        agent: {
          runAgent: async ({ worktree }) => {
            // Write partial work, do NOT commit, then FAIL. Before the fix this
            // work died with the worktree teardown (no harvest on failure).
            const { writeFile } = await import("node:fs/promises");
            await writeFile(join(worktree!, "src", "partial.js"), "export const partial = 1;\n");
            return {
              executionId: "e",
              exitStatus: "failed",
              summary: "worker failed (gateway)",
              artifactRefs: [],
              usage: {},
              error: "loop_prevented",
            };
          },
        },
        integration: {
          runIntegration: async (input) =>
            new Integrator(git).integrate({
              objective: input.objective,
              baseCommit: base,
              handoffs: input.handoffs,
              signal: input.signal,
            }),
        },
      },
    });

    const workerBranch = `pi-eng-orch-${t.task_id}`;
    const outcome = await (
      await broker.execute({
        taskId: t.task_id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: "x",
        mutatesRepo: true,
        isolation: "worktree",
      })
    ).result();
    assert.equal(outcome.exitStatus, "failed");

    // (a) The partial work was harvested onto the branch (committed), not lost.
    assert.equal(
      await git.branchAheadOf(base, workerBranch),
      true,
      "failed worker's uncommitted edits must be harvested (committed) onto the branch",
    );
    const branchFile = await exec("git", ["-C", fx.root, "show", `${workerBranch}:src/partial.js`]).catch(() => null);
    assert.ok(branchFile?.stdout.includes("export const partial"), "partial work must be on the branch");

    // (b) Integration must NOT merge a failed branch: the base checkout is unchanged.
    const it = store.createTask({
      mission_id: m.mission_id,
      kind: "integration",
      role: "integrator",
      objective: "merge",
    });
    store.transitionTask(it.task_id, "READY");
    await (
      await broker.execute({
        taskId: it.task_id,
        missionId: m.mission_id,
        kind: "integration",
        role: "integrator",
        objective: "merge",
        mutatesRepo: true,
        isolation: "none",
      })
    ).result();
    const head = await git.headCommit();
    assert.equal(head, base, "failed worker branch must not be merged into the base checkout");

    // (c) The failed branch is preserved after cleanup (never force-deleted).
    await broker.cleanupMission(m.mission_id, { keepBranches: false });
    const verify = await exec("git", ["-C", fx.root, "rev-parse", "--verify", "--quiet", workerBranch]).catch(
      () => null,
    );
    assert.ok(
      verify && verify.stdout.trim().length > 0,
      `failed worker branch must be preserved after cleanup (branch=${workerBranch})`,
    );
  } finally {
    await fx.cleanup();
  }
});

it("cleans repositories independently and durably reports a locked removal for retry", async () => {
  const firstFixture = await makeFixtureRepo();
  const secondFixture = await makeFixtureRepo();
  try {
    const firstGit = (await GitRepo.open(firstFixture.root))!;
    const secondGit = (await GitRepo.open(secondFixture.root))!;
    const first = await firstGit.createWorktree(await firstGit.headCommit(), "multi-cleanup-first");
    const second = await secondGit.createWorktree(await secondGit.headCommit(), "multi-cleanup-second");
    await exec("git", ["-C", firstFixture.root, "worktree", "lock", first.path]);
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "multi cleanup",
      goal: "multi cleanup",
      user_request: "multi cleanup",
      repository: firstFixture.root,
      base_ref: await firstGit.headCommit(),
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    const broker = new ExecutionBroker({ store, backends: {} });
    const internals = broker as unknown as {
      missionWorktrees: Map<
        string,
        Array<{
          path: string;
          branch: string;
          git: GitRepo;
          repoId: string;
          writeDomains: string[];
        }>
      >;
    };
    internals.missionWorktrees.set(mission.mission_id, [
      { ...first, git: firstGit, repoId: "repo-one", writeDomains: [] },
      { ...second, git: secondGit, repoId: "repo-two", writeDomains: [] },
    ]);
    const acquired: string[] = [];
    const closed: string[] = [];
    let failRepoTwoRelease = true;
    const authorityForRepo = async (repoId: string) => {
      acquired.push(repoId);
      return {
        missionIdentity: {
          missionId: mission.mission_id,
          generation: 1,
          fencingToken: 1,
        },
        repositoryIdentity: { repoId, generation: 1, fencingToken: 1 },
        assertAuthoritative: () => {},
        onInvalidated: () => () => {},
        close: async () => {
          closed.push(repoId);
          return repoId === "repo-two" && failRepoTwoRelease ? new Error("simulated lease release failure") : undefined;
        },
      } as never;
    };

    const firstPass = await broker.cleanupMission(mission.mission_id, {
      authorityForRepo,
    });
    assert.deepEqual(acquired.sort(), ["repo-one", "repo-two"]);
    assert.deepEqual(closed.sort(), ["repo-one", "repo-two"]);
    assert.equal(firstPass.failures.length, 2);
    assert.ok(firstPass.failures.some((failure) => failure.repoId === "repo-one" && failure.preserved));
    assert.ok(
      firstPass.failures.some(
        (failure) => failure.repoId === "repo-two" && failure.reason.includes("simulated lease release failure"),
      ),
    );
    await assert.rejects(access(second.path));
    assert.equal(await firstGit.headCommitIn(first.path), await firstGit.headCommit());
    assert.ok(
      store.listFindings(mission.mission_id).some((finding) => finding.summary.includes("Pending repository cleanup")),
    );

    await exec("git", ["-C", firstFixture.root, "worktree", "unlock", first.path]);
    failRepoTwoRelease = false;
    const retry = await broker.cleanupMission(mission.mission_id, {
      authorityForRepo,
    });
    assert.deepEqual(retry.failures, []);
    await assert.rejects(access(first.path));
  } finally {
    await firstFixture.cleanup();
    await secondFixture.cleanup();
  }
});

it("turns a corrupt durable cleanup journal into a structured finding after broker restart", async () => {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "corrupt cleanup",
      goal: "corrupt cleanup",
      user_request: "corrupt cleanup",
      repository: fx.root,
      base_ref: await git.headCommit(),
      risk_profile: "medium",
      workflow_class: "engineering_review",
    });
    store.createTask({
      mission_id: mission.mission_id,
      repo_id: "repo-corrupt-cleanup",
      kind: "agent",
      role: "implementer",
      objective: "cleanup",
      mutates_repo: true,
      isolation: "worktree",
    });
    const stateDir = join(await git.commonDir(), "pi-engineering-candidates");
    await mkdir(stateDir, { recursive: true });
    const name = `cleanup.${[mission.mission_id, "repo-corrupt-cleanup", "orphan-branch"]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".")}.json`;
    await writeFile(join(stateDir, name), "{not-json", "utf8");

    const restarted = new ExecutionBroker({
      store,
      resolveRepository: async () => ({
        repoId: "repo-corrupt-cleanup",
        root: fx.root,
        git,
      }),
      backends: {},
    });
    const result = await restarted.cleanupMission(mission.mission_id);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.repoId, "repo-corrupt-cleanup");
    assert.match(result.failures[0]?.reason ?? "", /cleanup journal is unreadable/i);
    assert.ok(
      store
        .listFindings(mission.mission_id)
        .some((finding) => finding.summary.includes(name) && finding.summary.includes("unreadable")),
    );
  } finally {
    await fx.cleanup();
  }
});
