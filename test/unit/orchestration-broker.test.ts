import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, ExecutionBroker, workerTimeoutMs } from "../../src/orchestration/broker.ts";
import { Integrator } from "../../src/orchestration/integrator.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

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
  const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
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
            return { executionId: "worker", exitStatus: "succeeded", summary: "renamed", artifactRefs: [], usage: {} };
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
        return { repoId, root: "/repo", git: {} as never, writableDomains: ["**"] };
      },
      backends: {
        agent: {
          runAgent: async (input) => {
            seen.push(input.repoId ?? "");
            return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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

    const missing = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
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
      resolveRepository: async (repoId) => ({ repoId, root: "/repo", git: {} as never }),
      backends: {
        agent: {
          runAgent: async () => {
            runs++;
            return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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
      resolveRepository: async (repoId) => ({ repoId, root: "/repo", git: {} as never }),
      backends: {
        agent: {
          runAgent: async () => {
            runs++;
            return { executionId: "e", exitStatus: "succeeded", summary: "unsafe", artifactRefs: [], usage: {} };
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
            return { executionId: "e", exitStatus: "succeeded", summary: "unsafe", artifactRefs: [], usage: {} };
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
            return { executionId: "e", exitStatus: "succeeded", summary: "safe", artifactRefs: [], usage: {} };
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
          return { executionId: "e", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
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
    await assert.rejects(handle.result(), /aborted/i);
    assert.equal(runs, 0);
  });

  it("does not dispatch after cancellation during worktree allocation and releases the allocated worktree", async () => {
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
            return { executionId: "e", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
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
    await assert.rejects(pending, /aborted/i);
    assert.equal(runs, 0);
    assert.equal(removals, 1);
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
            return { executionId: "e", exitStatus: "succeeded", summary: "late", artifactRefs: [], usage: {} };
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
      return { executionId, exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
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
    const process = store.createTask({ mission_id: m.mission_id, kind: "process", role: "runner", objective: "build" });
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
    const seen: Array<{ missionId: string; taskId: string; executionId: string; summary: string }> = [];
    const { m, t, broker } = setup({
      agent: {
        runAgent: async ({ onActivity }) => {
          onActivity?.({ kind: "state", summary: "Worker session started", meaningfulProgress: false });
          return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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

  it("workerTimeoutMs defaults to 30 min and honors the env override", () => {
    const prev = process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
    try {
      delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
      assert.equal(workerTimeoutMs(), 30 * 60_000, "default must give workers headroom to commit real work");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = "60000";
      assert.equal(workerTimeoutMs(), 60_000, "env override must win");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = String(2 ** 40);
      assert.equal(workerTimeoutMs(), 2 ** 31 - 1, "beyond setTimeout's range the timer would fire at once");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = "not-a-number";
      assert.equal(workerTimeoutMs(), 30 * 60_000, "invalid env must fall back to default");
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
    await assert.rejects(() => resultP);
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
          return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
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
              return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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
              return { executionId: "i", exitStatus: "succeeded", summary: "merged", artifactRefs: [], usage: {} };
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
              return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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
            return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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

    // (b) Integration merges the branch tip into the base checkout and the
    // base-vs-HEAD diff is non-empty afterwards.
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
            return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
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
