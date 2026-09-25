/**
 * Recovery of a wall-clock-timed-out worker's committed work (MSN-1xh24o),
 * against a real git fixture: real worktrees, real commits, real merges into
 * the integrator's handoff list.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker, type ExecutionOutcome } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

type Handoff = { worktree: { path: string; branch: string }; summary: string; ref?: string; recovered?: boolean };

/** What a scripted worker does inside its worktree before it settles. */
interface Step {
  task: string;
  /** Files written and committed by the WORKER itself. */
  commit?: string[];
  /** Files written but left uncommitted (the broker's harvest commits these). */
  edit?: string[];
  outcome: Pick<ExecutionOutcome, "exitStatus" | "summary" | "error">;
}

const TIMEOUT = { exitStatus: "failed", summary: "Worker timed out.", error: "timeout" } as const;
const SUCCESS = { exitStatus: "succeeded", summary: "done" } as const;

/**
 * How the integration runner behaves. "record" (default) only records the
 * handoffs; "merge" really merges each handoff (its exact ref when given) into
 * the fixture checkout, skipping the listed branches, like realBackends does
 * for a conflicting recovered handoff.
 */
interface IntegrationMode {
  merge?: boolean;
  skip?: (branch: string) => boolean;
  exitStatus?: string;
}

async function scenario(steps: Step[], mode: IntegrationMode = {}) {
  const fx = await makeFixtureRepo();
  const git = (await GitRepo.open(fx.root))!;
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const base = await git.headCommit();
  const m = store.createMission({
    title: "x",
    goal: "x",
    user_request: "x",
    repository: ".",
    base_ref: base,
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  const handoffs: Handoff[] = [];
  /** task -> the worker's own last commit. */
  const workerCommits = new Map<string, string>();
  const byObjective = new Map<string, Step[]>();
  for (const s of steps) byObjective.set(s.task, [...(byObjective.get(s.task) ?? []), s]);
  const broker = new ExecutionBroker({
    store,
    git,
    baseRef: base,
    backends: {
      agent: {
        runAgent: async ({ worktree, objective }) => {
          const step = byObjective.get(objective)!.shift()!;
          const write = async (f: string) => {
            await mkdir(join(worktree!, "src"), { recursive: true });
            await writeFile(join(worktree!, "src", f), `${objective} ${f}\n`);
          };
          for (const f of step.commit ?? []) await write(f);
          if (step.commit?.length) {
            await git.commitAll(worktree!, `worker commit for ${objective}`);
            workerCommits.set(objective, await git.headCommitIn(worktree!));
          }
          for (const f of step.edit ?? []) await write(f);
          return { executionId: "e", artifactRefs: [], usage: {}, ...step.outcome };
        },
      },
      integration: {
        runIntegration: async (input) => {
          handoffs.push(...(input.handoffs as Handoff[]));
          if (mode.merge) {
            for (const h of input.handoffs) {
              if (mode.skip?.(h.worktree.branch)) continue;
              await git.mergeBranch(h.ref ?? h.worktree.branch);
            }
          }
          return {
            executionId: "i",
            exitStatus: mode.exitStatus ?? "succeeded",
            summary: "merged",
            artifactRefs: [],
            usage: {},
          };
        },
      },
    },
  });
  const taskIds = new Map<string, string>();
  for (const s of steps) {
    let id = taskIds.get(s.task);
    if (!id) {
      id = store.createTask({
        mission_id: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: s.task,
        mutates_repo: true,
        isolation: "worktree",
        write_domains: ["src/**"],
      }).task_id;
      taskIds.set(s.task, id);
    }
    await (
      await broker.execute({
        taskId: id,
        missionId: m.mission_id,
        kind: "agent",
        role: "implementer",
        objective: s.task,
        mutatesRepo: true,
        isolation: "worktree",
      })
    ).result();
  }
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
  const branchOf = (task: string) => `pi-eng-orch-${taskIds.get(task)}`;
  const taskOf = (task: string) => taskIds.get(task)!;
  const integration = store.listExecutions(m.mission_id).find((e) => e.backend === "integration")!;
  return { fx, store, m, handoffs, workerCommits, branchOf, taskOf, integration };
}

describe("ExecutionBroker: recovering a timed-out worker's committed work", () => {
  it("recovers exactly the commits the worker made, not the harvest's auto-commit of its half-done edits", async () => {
    const s = await scenario([{ task: "committed", commit: ["done.txt"], edit: ["half.txt"], outcome: TIMEOUT }]);
    try {
      assert.equal(s.handoffs.length, 1, JSON.stringify(s.handoffs));
      const h = s.handoffs[0]!;
      assert.equal(h.recovered, true);
      assert.equal(h.ref, s.workerCommits.get("committed"), "merge the worker's own tip, not the harvest commit");
      assert.equal(h.worktree.branch, s.branchOf("committed"));
      // Surfaced, not silent.
      assert.ok(
        s.store.listFindings(s.m.mission_id).some((f) => /recover/i.test(f.summary)),
        "a finding must name the recovered execution",
      );
    } finally {
      await s.fx.cleanup();
    }
  });

  it("does not recover a timed-out worker that only edited files (nothing it committed itself)", async () => {
    const s = await scenario([{ task: "edited", edit: ["half.txt"], outcome: TIMEOUT }]);
    try {
      assert.deepEqual(s.handoffs, [], "half-done edits stay preserve-only");
    } finally {
      await s.fx.cleanup();
    }
  });

  it("keeps committed work from a gateway/transport timeout preserve-only (only the wall-clock marker recovers)", async () => {
    for (const error of ["gateway:queue_timeout", "transient:timeout"]) {
      const s = await scenario([
        {
          task: "infra",
          commit: ["partial.txt"],
          outcome: { exitStatus: "failed", summary: "Worker failed after 5 attempt(s): request timed out", error },
        },
      ]);
      try {
        assert.deepEqual(s.handoffs, [], `${error}: partial work must stay preserve-only`);
      } finally {
        await s.fx.cleanup();
      }
    }
  });

  it("integrates recovered work LAST, after every clean branch", async () => {
    const s = await scenario([
      { task: "recovered", commit: ["r.txt"], outcome: TIMEOUT },
      { task: "clean", commit: ["c.txt"], outcome: SUCCESS },
    ]);
    try {
      assert.deepEqual(
        s.handoffs.map((h) => [h.worktree.branch, h.recovered === true]),
        [
          [s.branchOf("clean"), false],
          [s.branchOf("recovered"), true],
        ],
      );
    } finally {
      await s.fx.cleanup();
    }
  });

  it("a retry of the same task that succeeds is integrated (the last settled outcome wins), once", async () => {
    const s = await scenario([
      { task: "retried", edit: ["a.txt"], outcome: { exitStatus: "failed", summary: "guard abort", error: "guard" } },
      { task: "retried", commit: ["b.txt"], outcome: SUCCESS },
    ]);
    try {
      assert.deepEqual(
        s.handoffs.map((h) => [h.worktree.branch, h.recovered === true]),
        [[s.branchOf("retried"), false]],
      );
    } finally {
      await s.fx.cleanup();
    }
  });
});

describe("ExecutionBroker: recording what recovery actually merged (completion-gate evidence)", () => {
  it("records the recovered task, branch and exact ref on the integration execution once merged", async () => {
    const s = await scenario(
      [
        { task: "recovered", commit: ["r.txt"], edit: ["half.txt"], outcome: TIMEOUT },
        { task: "clean", commit: ["c.txt"], outcome: SUCCESS },
      ],
      { merge: true },
    );
    try {
      assert.deepEqual(s.integration.recovered_merged, [
        { task_id: s.taskOf("recovered"), branch: s.branchOf("recovered"), ref: s.workerCommits.get("recovered") },
      ]);
    } finally {
      await s.fx.cleanup();
    }
  });

  it("records nothing for recovered work the integrator did not merge (skipped / conflict)", async () => {
    const s = await scenario([{ task: "recovered", commit: ["r.txt"], outcome: TIMEOUT }], {
      merge: true,
      skip: () => true,
    });
    try {
      assert.equal(s.handoffs.length, 1, "it was handed off");
      assert.equal(s.integration.recovered_merged, undefined);
    } finally {
      await s.fx.cleanup();
    }
  });

  it("records nothing when the integration itself did not succeed", async () => {
    const s = await scenario([{ task: "recovered", commit: ["r.txt"], outcome: TIMEOUT }], {
      merge: true,
      exitStatus: "failed",
    });
    try {
      assert.equal(s.integration.recovered_merged, undefined);
    } finally {
      await s.fx.cleanup();
    }
  });
});

describe("GitRepo.revListCount", () => {
  it("reports an unknown count as null, not as 'no commits'", async () => {
    const fx = await makeFixtureRepo();
    try {
      const git = (await GitRepo.open(fx.root))!;
      assert.equal(await git.revListCount("HEAD..HEAD"), 0);
      assert.equal(await git.revListCount("HEAD..no-such-branch"), null);
    } finally {
      await fx.cleanup();
    }
  });
});
