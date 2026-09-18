import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, ExecutionBroker, workerTimeoutMs } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

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

describe("ExecutionBroker (spec 03)", () => {
  it("workerTimeoutMs defaults to 30 min and honors the env override", () => {
    const prev = process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
    try {
      delete process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS;
      assert.equal(workerTimeoutMs(), 30 * 60_000, "default must give workers headroom to commit real work");
      process.env.PI_ENGINEERING_WORKER_TIMEOUT_MS = "60000";
      assert.equal(workerTimeoutMs(), 60_000, "env override must win");
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
});
