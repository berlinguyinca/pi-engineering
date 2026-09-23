import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, ExecutionBroker, workerTimeoutMs } from "../../src/orchestration/broker.ts";
import { Integrator } from "../../src/orchestration/integrator.ts";
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
