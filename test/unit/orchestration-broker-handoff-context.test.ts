/** The broker fills the checkpoint handoff context only with what it can prove, and quarantines fenced executions' processes. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { GitRepo } from "../../src/git/GitRepo.ts";
import { ExecutionBroker } from "../../src/orchestration/broker.ts";
import { CheckpointManager } from "../../src/orchestration/checkpoints.ts";
import { buildCandidateEvidenceIdentity, hashCandidateEvidenceIdentity } from "../../src/orchestration/evidence.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { ProcessQuarantine } from "../../src/workers/processQuarantine.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

async function fixture(
  runAgent: Parameters<typeof ExecutionBroker.prototype.execute> extends never ? never : unknown,
  quarantine?: ProcessQuarantine,
) {
  const fx = await makeFixtureRepo();
  const git = await GitRepo.open(fx.root);
  assert.ok(git);
  const store = MissionStore.open(JsonlEventStore.inMemory());
  const mission = store.createMission({
    title: "ctx",
    goal: "ctx",
    user_request: "ctx",
    repository: fx.root,
    base_ref: await git.headCommit(),
    risk_profile: "medium",
    workflow_class: "engineering_review",
  });
  store.bindWorkspaceManifest({
    manifestId: "WM-ctx",
    missionId: mission.mission_id,
    generation: 1,
    authorizedRoots: [{ canonicalPath: fx.root, source: "existing_manifest", access: "write" }],
    repositories: [
      {
        repoId: "repo-ctx",
        canonicalRoot: fx.root,
        baseRef: "main",
        baseSha: mission.base_ref,
        writableDomains: ["src/**"],
      },
    ],
    dependencyEdges: [],
    hash: "manifest-ctx",
    createdAt: "2026-10-29T10:00:00.000Z",
  });
  const task = store.createTask({
    mission_id: mission.mission_id,
    repo_id: "repo-ctx",
    kind: "agent",
    role: "implementer",
    objective: "ctx",
    mutates_repo: true,
    isolation: "worktree",
    write_domains: ["src/**"],
    deliverables: ["implementation"],
    execution_budget_ms: 20_000,
    checkpoint_policy: { activity_milestone: 1, before_deadline_ms: 100 },
  });
  const broker = new ExecutionBroker({
    store,
    git,
    checkpoints: new CheckpointManager({ store }),
    ...(quarantine ? { processQuarantine: quarantine } : {}),
    resolveRepository: async (repoId) => ({ repoId, root: fx.root, git }),
    backends: { agent: { runAgent: runAgent as never } },
  });
  const handle = await broker.execute({
    taskId: task.task_id,
    missionId: mission.mission_id,
    repoId: "repo-ctx",
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
  const started = handle.result().catch(() => undefined);
  return { fx, git, store, mission, task, broker, handle, started };
}

const until = async (cond: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

const ok = { executionId: "e", exitStatus: "succeeded", summary: "x", artifactRefs: [], usage: {} };

describe("broker checkpoint handoff context", () => {
  it("records untracked files by content hash from the worktree snapshot, and never invents a next action", async () => {
    const content = "scratch notes\n";
    const ctx = await fixture(
      async ({
        worktree,
        signal,
        onActivity,
      }: { worktree: string; signal: AbortSignal; onActivity?: (e: unknown) => void }) => {
        await mkdir(join(worktree, "notes"), { recursive: true });
        await writeFile(join(worktree, "notes", "scratch.txt"), content, "utf8");
        onActivity?.({
          kind: "checkpoint",
          summary: "tick",
          meaningfulProgress: true,
          claims: [
            { deliverable: "implementation", candidateSha: "", evidencePaths: [], artifactRefs: [], tipBound: true },
          ],
        });
        await waitForAbort(signal);
        return ok;
      },
    );
    try {
      await until(() =>
        ctx.store
          .listTaskCheckpoints(ctx.mission.mission_id, ctx.task.task_id)
          .some((c) => c.handoff?.untracked.length),
      );
      const first = ctx.store
        .listTaskCheckpoints(ctx.mission.mission_id, ctx.task.task_id)
        .find((c) => c.handoff?.untracked.length);
      assert.deepEqual(first?.handoff?.untracked, [
        { path: "notes/scratch.txt", sha256: createHash("sha256").update(content).digest("hex") },
      ]);
      assert.equal(first?.handoff?.nextAction, null, "no source of truth for the next action, so it stays null");
      assert.deepEqual(first?.handoff?.tests, [], "no validation evidence yet, so no test outcomes");
      await ctx.handle.cancel();
      await ctx.started;
    } finally {
      await ctx.fx.cleanup();
    }
  });

  it("omits untracked files when there are too many to hash within bounds (unknown, not empty)", async () => {
    const ctx = await fixture(
      async ({
        worktree,
        signal,
        onActivity,
      }: { worktree: string; signal: AbortSignal; onActivity?: (e: unknown) => void }) => {
        await mkdir(join(worktree, "many"), { recursive: true });
        for (let i = 0; i < 60; i++) await writeFile(join(worktree, "many", `f${i}.txt`), `${i}`, "utf8");
        onActivity?.({
          kind: "checkpoint",
          summary: "tick",
          meaningfulProgress: true,
          claims: [
            { deliverable: "implementation", candidateSha: "", evidencePaths: [], artifactRefs: [], tipBound: true },
          ],
        });
        await waitForAbort(signal);
        return ok;
      },
    );
    try {
      await until(() => ctx.store.listTaskCheckpoints(ctx.mission.mission_id, ctx.task.task_id).length > 0);
      const cp = ctx.store.listTaskCheckpoints(ctx.mission.mission_id, ctx.task.task_id)[0];
      assert.ok((cp?.preservedUncommittedChanges.length ?? 0) >= 60, "the snapshot still lists the dirty paths");
      assert.deepEqual(cp?.handoff?.untracked ?? [], []);
      await ctx.handle.cancel();
      await ctx.started;
    } finally {
      await ctx.fx.cleanup();
    }
  });

  it("derives test outcomes only from validation evidence for the exact candidate being checkpointed", async () => {
    const ctx = await fixture(async ({ signal }: { signal: AbortSignal }) => {
      await waitForAbort(signal);
      return ok;
    });
    try {
      const sha = "c".repeat(40);
      const other = "d".repeat(40);
      const base = ctx.mission.base_ref;
      const record = (candidateSha: string, command: string, exitCode: number, noTargets = false) => {
        const impl = ctx.store.createTask({
          mission_id: ctx.mission.mission_id,
          kind: "agent",
          role: "implementer",
          objective: "done",
          repo_id: "repo-ctx",
          mission_generation: 0,
          candidate_generation: 0,
        });
        ctx.store.transitionTask(impl.task_id, "READY");
        ctx.store.transitionTask(impl.task_id, "RUNNING");
        const implExec = ctx.store.createExecution({
          task_id: impl.task_id,
          mission_id: ctx.mission.mission_id,
          backend: "agent",
          repo_id: "repo-ctx",
          base_sha: base,
          mission_generation: 0,
          candidate_generation: 0,
        });
        ctx.store.assignTaskExecution(impl.task_id, implExec.execution_id);
        ctx.store.setExecutionStatus(implExec.execution_id, "RUNNING");
        ctx.store.setExecutionStatus(implExec.execution_id, "SUCCEEDED");
        ctx.store.transitionTask(impl.task_id, "SUCCEEDED");
        const integration = { taskId: impl.task_id, executionId: implExec.execution_id };
        const identity = buildCandidateEvidenceIdentity({
          workspaceManifestHash: "manifest-ctx",
          missionGeneration: 0,
          repoId: "repo-ctx",
          baseSha: base,
          candidateSha,
          diffHash: `sha256:${"0".repeat(64)}`,
          acceptanceIds: [],
          artifactHashes: [],
        });
        ctx.store.recordCandidate(ctx.mission.mission_id, identity, "c", integration);
        const gate = ctx.store.createTask({
          mission_id: ctx.mission.mission_id,
          kind: "validation",
          role: "validator",
          objective: "v",
          repo_id: "repo-ctx",
          mission_generation: 0,
          candidate_generation: 0,
        });
        ctx.store.transitionTask(gate.task_id, "READY");
        ctx.store.transitionTask(gate.task_id, "RUNNING");
        const ex = ctx.store.createExecution({
          task_id: gate.task_id,
          mission_id: ctx.mission.mission_id,
          backend: "validation",
          repo_id: "repo-ctx",
          base_sha: base,
          mission_generation: 0,
          candidate_generation: 0,
        });
        ctx.store.assignTaskExecution(gate.task_id, ex.execution_id);
        ctx.store.setExecutionStatus(ex.execution_id, "RUNNING");
        ctx.store.setExecutionStatus(ex.execution_id, "SUCCEEDED");
        ctx.store.transitionTask(gate.task_id, "SUCCEEDED");
        ctx.store.recordValidationEvidence({
          evidenceId: `EV-${candidateSha.slice(0, 4)}-${command}`,
          missionId: ctx.mission.mission_id,
          taskId: gate.task_id,
          executionId: ex.execution_id,
          identity,
          identityHash: hashCandidateEvidenceIdentity(identity),
          command,
          profile: "node",
          exitCode,
          testSummary: {},
          noTargets,
          accessible: true,
          acceptanceResults: [],
          recordedAt: new Date().toISOString(),
        });
      };
      record(sha, "npm test", 1);
      record(sha, "npm run lint", 0);
      record(sha, "npm run e2e", 0, true);
      record(other, "npm test", 0);
      const outcomes = (
        ctx.broker as unknown as { validationTestOutcomes(m: string, r: string, s: string | null): unknown }
      ).validationTestOutcomes(ctx.mission.mission_id, "repo-ctx", sha);
      assert.deepEqual(outcomes, [
        { ref: "node: npm test", outcome: "failed" },
        { ref: "node: npm run lint", outcome: "passed" },
        { ref: "node: npm run e2e", outcome: "skipped" },
      ]);
      assert.deepEqual(
        (
          ctx.broker as unknown as { validationTestOutcomes(m: string, r: string, s: string | null): unknown }
        ).validationTestOutcomes(ctx.mission.mission_id, "repo-ctx", null),
        [],
      );
      await ctx.handle.cancel();
      await ctx.started;
    } finally {
      await ctx.fx.cleanup();
    }
  });
});

describe("broker quarantines the processes of a fenced execution", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("canceling an execution terminates the process group its tools registered, and nothing else", async () => {
    const quarantine = new ProcessQuarantine({ graceMs: 1500, pollMs: 25 });
    const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    unrelated.unref();
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    let registered = false;
    const ctx = await fixture(async ({ signal }: { signal: AbortSignal }) => {
      quarantine.track(signal, { pid: child.pid as number });
      registered = true;
      await waitForAbort(signal);
      return ok;
    }, quarantine);
    try {
      await until(() => registered);
      assert.equal(alive(child.pid as number), true);
      await ctx.handle.cancel();
      await ctx.started;
      await until(() => !alive(child.pid as number));
      assert.equal(alive(unrelated.pid as number), true, "an unrelated process group is never touched");
    } finally {
      try {
        process.kill(unrelated.pid as number, "SIGKILL");
      } catch {}
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
      await ctx.fx.cleanup();
    }
  });
});
