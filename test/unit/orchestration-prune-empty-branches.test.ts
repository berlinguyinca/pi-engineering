import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { GitRepo } from "../../src/git/GitRepo.ts";
import { type BrokerBackends, ExecutionBroker } from "../../src/orchestration/broker.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const exec = promisify(execFile);

/**
 * Regression for the unmerged-work false-positive: when integration did not
 * complete, preserved branches that are byte-identical to the base (zero unique
 * commits) were reported as "Unmerged worker work preserved on branch(es): …"
 * and left mounted, forcing manual cleanup. Such empty-shell branches carry
 * nothing and must be deleted and excluded; only branches with real unmerged
 * commits should survive and be named in the finding.
 */
async function setupUnintegratedBroker(worker: (cwd: string) => Promise<void>) {
  const fx = await makeFixtureRepo();
  const git = (await GitRepo.open(fx.root))!;
  const base = await git.headCommit();
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const m = store.createMission({
    title: "unmerged work pruning",
    goal: "unmerged work pruning",
    user_request: "unmerged work pruning",
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
  const backends: BrokerBackends = {
    agent: {
      runAgent: async ({ worktree }) => {
        await worker(worktree!);
        return { executionId: "e", exitStatus: "succeeded", summary: "done", artifactRefs: [], usage: {} };
      },
    },
  };
  const broker = new ExecutionBroker({ store, git, baseRef: base, backends });
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
  const branch = `pi-eng-orch-${t.task_id}`;
  return { fx, git, broker, store, m, branch, base };
}

async function branchExists(git: GitRepo, branch: string): Promise<boolean> {
  return (await git.resolveCommit(branch)) !== null;
}

describe("pruneEmptyPreservedBranches (unmerged-work false positive)", () => {
  it("deletes empty-shell preserved branches and reports none (no finding)", async () => {
    const { fx, git, broker, m, branch, base } = await setupUnintegratedBroker(async () => {
      // The worker produces no changes: its branch stays byte-identical to base.
    });
    try {
      // An un-integrated mission cleans up with keepBranches=true, so the
      // empty-shell branch is preserved exactly like an unmerged one today.
      await broker.cleanupMission(m.mission_id, { keepBranches: true });
      assert.ok(
        broker.preservedBranches(m.mission_id).includes(branch),
        "empty branch must be preserved before pruning",
      );
      assert.equal(await git.revListCount(`${base}..${branch}`), 0, "empty shell carries zero unique commits");

      const survivors = await broker.pruneEmptyPreservedBranches(m.mission_id);

      // (a) No survivors -> the orchestrator's `if (preserved.length > 0)` does
      // not fire, so no "Unmerged worker work" finding is raised.
      assert.deepEqual(survivors, [], "empty-shell branches must be excluded from the finding");
      assert.equal(
        broker.preservedBranches(m.mission_id).length,
        0,
        "empty branches must be dropped from preserved state",
      );
      assert.equal(
        await branchExists(git, branch),
        false,
        "empty-shell branch must be deleted so the operator is not forced to clean it up",
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps a preserved branch carrying a real unmerged commit (finding names it)", async () => {
    const { fx, git, broker, m, branch, base } = await setupUnintegratedBroker(async (cwd) => {
      await writeFile(join(cwd, "src", "add.js"), "export const add = (a, b) => a + b;\n");
      await exec("git", ["-C", cwd, "add", "-A"]);
      await exec("git", ["-C", cwd, "commit", "-q", "-m", "unmerged worker work"]);
    });
    try {
      await broker.cleanupMission(m.mission_id, { keepBranches: true });
      assert.ok(
        broker.preservedBranches(m.mission_id).includes(branch),
        "unmerged branch must be preserved before pruning",
      );
      assert.equal(await git.revListCount(`${base}..${branch}`), 1, "real worker commit since base");

      const survivors = await broker.pruneEmptyPreservedBranches(m.mission_id);

      // (b) The real unmerged branch survives and is named in the finding.
      assert.deepEqual(survivors, [branch], "real unmerged branch must be reported");
      assert.ok(broker.preservedBranches(m.mission_id).includes(branch), "real unmerged branch must stay preserved");
      assert.equal(await branchExists(git, branch), true, "real unmerged branch must remain intact");
    } finally {
      await fx.cleanup();
    }
  });
});
