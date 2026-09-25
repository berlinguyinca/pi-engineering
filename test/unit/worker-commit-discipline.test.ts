import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { realBackends } from "../../src/orchestration/realBackends.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { buildCompactedWorkerPrompt } from "../../src/workers/PiWorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { buildSystemPrompt } from "../../src/workers/prompts.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

// Only a worker's own commits are recovered after a wall-clock timeout, so the
// roles that edit the repository must be told to commit as they go — but ONLY
// inside a worktree the broker isolated for them. A fallback run in the user's
// own checkout must never be told to commit there.
const MUTATING = ["implementer", "debugger", "test-generator", "clean-room-challenger"] as const;
const ISOLATED = { isolatedWorktree: true };

describe("commit discipline in the system prompt", () => {
  it("mutating roles in an isolated worktree are told to commit after every coherent unit", () => {
    for (const role of MUTATING) {
      const prompt = buildSystemPrompt(role, "change the widget", undefined, ISOLATED);
      assert.match(prompt, /Commit discipline/, role);
      assert.match(
        prompt,
        /If your session is terminated by the time budget, only your own commits are recovered; uncommitted edits at that point are not merged\./,
        role,
      );
      for (const forbidden of [/never switch branches/i, /rebase/i, /amend/i, /push/i]) {
        assert.match(prompt, forbidden, `${role}: ${forbidden}`);
      }
    }
  });

  it("without the isolated-worktree flag no role is told to commit", () => {
    for (const role of MUTATING) {
      assert.doesNotMatch(buildSystemPrompt(role, "change the widget"), /Commit discipline/, role);
      assert.doesNotMatch(
        buildSystemPrompt(role, "change the widget", undefined, { isolatedWorktree: false }),
        /Commit discipline/,
        role,
      );
    }
  });

  it("read-only roles get no commit instruction, even in a worktree", () => {
    assert.doesNotMatch(buildSystemPrompt("reviewer", "review the widget", undefined, ISOLATED), /Commit discipline/);
  });
});

describe("commit discipline in the compacted (recovery) prompt", () => {
  const req = (role: WorkerRequest["role"], isolatedWorktree?: boolean): WorkerRequest => ({
    role,
    task: "t",
    tools: [],
    cwd: "/repo",
    ...(isolatedWorktree === undefined ? {} : { isolatedWorktree }),
  });

  it("carries the rule for a mutating role in an isolated worktree", () => {
    assert.match(buildCompactedWorkerPrompt(req("implementer", true), null), /[Cc]ommit your work/);
  });

  it("omits it for a reviewer, and for a mutating role outside an isolated worktree", () => {
    assert.doesNotMatch(buildCompactedWorkerPrompt(req("reviewer", true), null), /[Cc]ommit your work/);
    assert.doesNotMatch(buildCompactedWorkerPrompt(req("implementer"), null), /[Cc]ommit your work/);
  });
});

test("the flag is plumbed broker → realBackends → WorkerRequest only for a broker-allocated worktree", async () => {
  const seen: WorkerRequest[] = [];
  const worker: WorkerExecutor = {
    async run(r: WorkerRequest) {
      seen.push(r);
      return {
        result: {
          status: "completed",
          summary: "ok",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        },
        usage: null,
      } as never;
    },
  };
  const backends = realBackends({
    worker,
    verifier: {} as never,
    artifacts: {} as never,
    git: null,
    cwd: "/repo",
  });
  const signal = new AbortController().signal;
  // A broker-allocated worktree.
  await backends.agent.runAgent({
    role: "implementer",
    objective: "x",
    worktree: "/wt",
    isolatedWorktree: true,
    signal,
  });
  // The fallback: no worktree, the user's checkout.
  await backends.agent.runAgent({ role: "implementer", objective: "x", signal });
  // A path without the broker's word for it is not treated as isolated.
  await backends.agent.runAgent({ role: "implementer", objective: "x", worktree: "/somewhere", signal });
  assert.deepEqual(
    seen.map((r) => r.isolatedWorktree === true),
    [true, false, false],
  );

  // The broker says so only when it really allocated one. Without a git
  // provider there is no worktree, so the runner hears `false`.
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
  const flags: Array<boolean | undefined> = [];
  const broker = new ExecutionBroker({
    store,
    backends: {
      agent: {
        runAgent: async (input) => {
          flags.push(input.isolatedWorktree);
          return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
        },
      },
    },
  });
  const t = store.createTask({ mission_id: m.mission_id, kind: "agent", role: "implementer", objective: "x" });
  store.transitionTask(t.task_id, "READY");
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
  assert.deepEqual(flags, [false]);
});

test("the broker reports isolatedWorktree: true when it allocated a real git worktree", async () => {
  const fx = await makeFixtureRepo();
  try {
    const git = (await GitRepo.open(fx.root))!;
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const m = store.createMission({
      title: "x",
      goal: "x",
      user_request: "x",
      repository: ".",
      base_ref: await git.headCommit(),
      risk_profile: "low",
      workflow_class: "engineering_review",
    });
    const seen: Array<{ worktree?: string | null; isolatedWorktree?: boolean }> = [];
    const broker = new ExecutionBroker({
      store,
      git,
      baseRef: await git.headCommit(),
      backends: {
        agent: {
          runAgent: async (input) => {
            seen.push({ worktree: input.worktree, isolatedWorktree: input.isolatedWorktree });
            return { executionId: "e", exitStatus: "succeeded", summary: "ok", artifactRefs: [], usage: {} };
          },
        },
      },
    });
    const t = store.createTask({
      mission_id: m.mission_id,
      kind: "agent",
      role: "implementer",
      objective: "x",
      mutates_repo: true,
      isolation: "worktree",
    });
    store.transitionTask(t.task_id, "READY");
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
    assert.equal(seen.length, 1);
    assert.ok(seen[0]!.worktree && seen[0]!.worktree !== fx.root, "a separate worktree was allocated");
    assert.equal(seen[0]!.isolatedWorktree, true);
  } finally {
    await fx.cleanup();
  }
});
